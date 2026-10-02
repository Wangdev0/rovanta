import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { GENERIC_EVM_CHAINS } from "@/core/chain/generic";
import { ROBINHOOD_ENV } from "@/core/chain/robinhood";
import { getProviderInfo } from "@/core/llm/registry";
import type { LLMConfig, ProviderId } from "@/core/llm/types";

export interface StoredConfig {
  version: 1;
  llm?: { provider?: ProviderId; model?: string; baseUrl?: string; apiKey?: string };
  /** Data/chain settings, same names as env vars (allowlisted keys only). */
  env?: Record<string, string>;
}

export const DATA_ENV_KEYS: readonly string[] = Object.freeze([
  "COINGECKO_API_KEY",
  "COINGECKO_API_PLAN",
  ...Object.values(ROBINHOOD_ENV),
  ...GENERIC_EVM_CHAINS.flatMap((chain) => [chain.env.rpcUrl, chain.env.explorerUrl, chain.env.explorerApiUrl]),
]);

const DATA_ENV_KEY_SET: ReadonlySet<string> = new Set(DATA_ENV_KEYS);

export function isDataEnvKey(key: string): boolean {
  return DATA_ENV_KEY_SET.has(key);
}

export const PROVIDER_IDS: readonly ProviderId[] = ["openai-compatible", "anthropic", "google"];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value) && getProviderInfo(value) !== undefined;
}

/** Conventional API key env vars per provider, checked in order when ROVANTA_API_KEY is unset. */
export const PROVIDER_KEY_ENV: Record<ProviderId, readonly string[]> = {
  "openai-compatible": ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

const storedConfigSchema = z.object({
  version: z.literal(1),
  llm: z
    .object({
      provider: z.enum(["openai-compatible", "anthropic", "google"]).optional(),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
});

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function configPath(env: NodeJS.ProcessEnv): string {
  const explicit = nonEmpty(env.ROVANTA_CONFIG);
  if (explicit) return resolve(explicit);
  const xdg = nonEmpty(env.XDG_CONFIG_HOME);
  if (xdg) return join(resolve(xdg), "rovanta", "config.json");
  const home = nonEmpty(env.HOME) ?? homedir();
  return join(home, ".config", "rovanta", "config.json");
}

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<StoredConfig> {
  const path = configPath(env);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw new Error(`Could not read config file ${path}: ${(error as Error).message}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config file ${path} is not valid JSON. Fix or delete it, then run "rovanta config init".`, {
      cause: error,
    });
  }
  const parsed = storedConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at "${issue.path.join(".")}"` : "";
    throw new Error(
      `Config file ${path} is invalid${where}: ${issue?.message ?? "unexpected shape"}. Fix or delete it, then run "rovanta config init".`,
    );
  }
  return normalizeConfig(parsed.data);
}

/** Drops empty values and non-allowlisted env keys. */
function normalizeConfig(input: StoredConfig): StoredConfig {
  const out: StoredConfig = { version: 1 };
  if (input.llm) {
    const llm: NonNullable<StoredConfig["llm"]> = {};
    if (input.llm.provider) llm.provider = input.llm.provider;
    const model = nonEmpty(input.llm.model);
    if (model) llm.model = model;
    const baseUrl = nonEmpty(input.llm.baseUrl);
    if (baseUrl) llm.baseUrl = baseUrl;
    const apiKey = nonEmpty(input.llm.apiKey);
    if (apiKey) llm.apiKey = apiKey;
    if (Object.keys(llm).length > 0) out.llm = llm;
  }
  if (input.env) {
    const dataEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      const trimmed = nonEmpty(value);
      if (isDataEnvKey(key) && trimmed) dataEnv[key] = trimmed;
    }
    if (Object.keys(dataEnv).length > 0) out.env = dataEnv;
  }
  return out;
}

export async function saveConfig(config: StoredConfig, env: NodeJS.ProcessEnv): Promise<string> {
  const path = configPath(env);
  const normalized = normalizeConfig(storedConfigSchema.parse(config));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await chmod(path, 0o600);
  return path;
}

export interface LLMOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export type SettingSource = "flag" | "env" | "file";

export interface ResolvedSetting {
  value: string;
  source: SettingSource;
  /** Env var name when source is "env". */
  envVar?: string;
}

export interface ResolvedLLMSettings {
  provider?: ResolvedSetting;
  model?: ResolvedSetting;
  baseUrl?: ResolvedSetting;
  apiKey?: ResolvedSetting;
}

/**
 * Resolves each LLM setting with its source, without validating the provider id.
 * File values for model, base URL and API key apply only when the file's provider matches the
 * resolved provider, so a key saved for one provider is never sent to another.
 * API key order: ROVANTA_API_KEY > config file > provider env var (e.g. OPENAI_API_KEY).
 */
export function resolveLLMSettings(
  config: StoredConfig,
  env: NodeJS.ProcessEnv,
  overrides: LLMOverrides = {},
): ResolvedLLMSettings {
  const file = config.llm ?? {};
  const pick = (flag: string | undefined, envVar: string, fileValue: string | undefined): ResolvedSetting | undefined => {
    const fromFlag = nonEmpty(flag);
    if (fromFlag) return { value: fromFlag, source: "flag" };
    const fromEnv = nonEmpty(env[envVar]);
    if (fromEnv) return { value: fromEnv, source: "env", envVar };
    const fromFile = nonEmpty(fileValue);
    if (fromFile) return { value: fromFile, source: "file" };
    return undefined;
  };

  const provider = pick(overrides.provider, "ROVANTA_PROVIDER", file.provider);
  const fileApplies = !provider || !file.provider || provider.value === file.provider;
  const settings: ResolvedLLMSettings = {
    provider,
    model: pick(overrides.model, "ROVANTA_MODEL", fileApplies ? file.model : undefined),
    baseUrl: pick(overrides.baseUrl, "ROVANTA_BASE_URL", fileApplies ? file.baseUrl : undefined),
  };

  let apiKey = pick(undefined, "ROVANTA_API_KEY", fileApplies ? file.apiKey : undefined);
  if (!apiKey && provider && isProviderId(provider.value)) {
    for (const envVar of PROVIDER_KEY_ENV[provider.value]) {
      const value = nonEmpty(env[envVar]);
      if (value) {
        apiKey = { value, source: "env", envVar };
        break;
      }
    }
  }
  settings.apiKey = apiKey;
  return settings;
}

export async function resolveLLMConfig(env: NodeJS.ProcessEnv, overrides?: LLMOverrides): Promise<LLMConfig | null> {
  const settings = resolveLLMSettings(await loadConfig(env), env, overrides);
  const provider = settings.provider?.value;
  if (provider !== undefined && !isProviderId(provider)) {
    throw new Error(`Unknown provider "${provider}". Supported providers: ${PROVIDER_IDS.join(", ")}.`);
  }
  if (!provider || !settings.apiKey || !settings.model) return null;
  const config: LLMConfig = { provider, apiKey: settings.apiKey.value, model: settings.model.value };
  if (settings.baseUrl) config.baseUrl = settings.baseUrl.value;
  return config;
}

export async function resolveDataEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const config = await loadConfig(env);
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (!nonEmpty(env[key])) merged[key] = value;
  }
  return merged;
}

export function maskSecret(value: string | undefined): string {
  if (value === undefined) return "(not set)";
  const trimmed = value.trim();
  if (!trimmed) return "(not set)";
  if (trimmed.length < 12) return "****";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function looksLikeToken(segment: string): boolean {
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment);
}

/**
 * Redacts a data env value for display: values of key-like settings are masked, and URLs that carry
 * credentials, query strings or token-like path segments (e.g. RPC provider keys) are reduced to their origin.
 */
export function maskDataValue(key: string, value: string): string {
  if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) return maskSecret(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.username || url.password || url.search || url.hash || segments.some(looksLikeToken)) {
    return `${url.protocol}//${url.host}/****`;
  }
  return value;
}
