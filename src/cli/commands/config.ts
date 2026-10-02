import { access } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseChainId, parseEndpointUrl } from "@/core/chain/config";
import { assertSafeBaseUrl } from "@/core/llm/http";
import { PROVIDER_INFO, getProviderInfo } from "@/core/llm/registry";
import type { ProviderId } from "@/core/llm/types";
import {
  DATA_ENV_KEYS,
  PROVIDER_IDS,
  PROVIDER_KEY_ENV,
  configPath,
  isDataEnvKey,
  isProviderId,
  loadConfig,
  maskDataValue,
  maskSecret,
  resolveLLMSettings,
  saveConfig,
  type ResolvedSetting,
  type StoredConfig,
} from "../config";
import { writeLine, type CliIO, type CommandHandler } from "../io";
import { PromptClosedError, ask, askSecret, choose, isInteractive } from "../prompt";

type LLMKey = keyof NonNullable<StoredConfig["llm"]>;

const LLM_KEY_ALIASES: Record<string, LLMKey> = {
  provider: "provider",
  model: "model",
  "base-url": "baseUrl",
  base_url: "baseUrl",
  baseurl: "baseUrl",
  "api-key": "apiKey",
  api_key: "apiKey",
  apikey: "apiKey",
};

const LLM_KEY_LABELS: Record<LLMKey, string> = {
  provider: "provider",
  model: "model",
  baseUrl: "base-url",
  apiKey: "api-key",
};

class UsageError extends Error {}

function usage(): string {
  return [
    "Usage:",
    "  rovanta config [show] [--json] [--provider <id>] [--model <id>] [--base-url <url>]",
    "  rovanta config init                 Interactive setup",
    "  rovanta config set <key> [value]    Set a value (omit value for api-key to enter it hidden)",
    "  rovanta config unset <key>          Remove a value",
    "  rovanta config path                 Print the config file path",
    "",
    "Keys:",
    `  provider     ${PROVIDER_IDS.join(" | ")}`,
    "  model        Model ID from your provider",
    "  base-url     API base URL (https, or http only for localhost)",
    "  api-key      API key (stored in the config file with mode 0600)",
    ...DATA_ENV_KEYS.map((key) => `  ${key}`),
    "",
    "Environment (overrides the config file):",
    "  ROVANTA_PROVIDER, ROVANTA_MODEL, ROVANTA_BASE_URL, ROVANTA_API_KEY",
    "  OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY (or GOOGLE_API_KEY) are used when no other key is set",
    "  ROVANTA_CONFIG sets the config file path; data keys above can also be set as env vars",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSecretKey(key: LLMKey | string): boolean {
  return key === "apiKey" || /KEY|SECRET|TOKEN|PASSWORD/i.test(key);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sourceLabel(setting: ResolvedSetting | undefined): string {
  if (!setting) return "";
  if (setting.source === "env") return `env ${setting.envVar}`;
  return setting.source === "file" ? "config file" : "flag";
}

function displayBaseUrl(provider: string | undefined, baseUrl: string | undefined): string {
  if (baseUrl) return maskDataValue("BASE_URL", baseUrl);
  const info = provider ? getProviderInfo(provider) : undefined;
  return info?.defaultBaseUrl ? `default (${info.defaultBaseUrl})` : "(not set)";
}

function formatRows(rows: [string, string, string?][]): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value, note]) => `  ${label.padEnd(width)}  ${value}${note ? `  (${note})` : ""}`);
}

function redactStored(config: StoredConfig): StoredConfig {
  const out: StoredConfig = { version: 1 };
  if (config.llm) {
    out.llm = { ...config.llm };
    if (out.llm.apiKey) out.llm.apiKey = maskSecret(out.llm.apiKey);
    if (out.llm.baseUrl) out.llm.baseUrl = maskDataValue("BASE_URL", out.llm.baseUrl);
  }
  if (config.env) {
    out.env = Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, maskDataValue(key, value)]));
  }
  return out;
}

function parseLLMKey(raw: string): LLMKey | undefined {
  return LLM_KEY_ALIASES[raw.toLowerCase()];
}

function parseDataKey(raw: string): string | undefined {
  const upper = raw.toUpperCase().replace(/-/g, "_");
  return isDataEnvKey(upper) ? upper : undefined;
}

function validateDataValue(key: string, value: string): string {
  if (key.endsWith("_URL")) {
    const url = parseEndpointUrl(value);
    if (!url) throw new UsageError(`${key} must be an https URL (http is allowed only for localhost).`);
    return url;
  }
  if (key.endsWith("_CHAIN_ID") && parseChainId(value) === null) {
    throw new UsageError(`${key} must be a positive integer.`);
  }
  if (key === "COINGECKO_API_PLAN" && !["demo", "pro"].includes(value.toLowerCase())) {
    throw new UsageError("COINGECKO_API_PLAN must be demo or pro.");
  }
  if (key.endsWith("_NATIVE_SYMBOL") && !/^[A-Za-z0-9.]{1,16}$/.test(value)) {
    throw new UsageError(`${key} must be 1-16 letters, digits or dots.`);
  }
  return key === "COINGECKO_API_PLAN" ? value.toLowerCase() : value;
}

function validateProvider(value: string): ProviderId {
  if (!isProviderId(value)) {
    throw new UsageError(`Unknown provider "${value}". Supported providers: ${PROVIDER_IDS.join(", ")}.`);
  }
  return value;
}

function validateBaseUrl(value: string): string {
  try {
    return assertSafeBaseUrl(value);
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

async function runShow(io: CliIO, options: { json: boolean; provider?: string; model?: string; baseUrl?: string }) {
  const path = configPath(io.env);
  const config = await loadConfig(io.env);
  const exists = await fileExists(path);
  const settings = resolveLLMSettings(config, io.env, options);
  const provider = settings.provider?.value;
  const providerValid = provider === undefined || isProviderId(provider);

  const dataEnv: Record<string, { value: string; source: "env" | "file" }> = {};
  for (const key of DATA_ENV_KEYS) {
    const fromEnv = io.env[key]?.trim();
    const fromFile = config.env?.[key];
    if (fromEnv) dataEnv[key] = { value: maskDataValue(key, fromEnv), source: "env" };
    else if (fromFile) dataEnv[key] = { value: maskDataValue(key, fromFile), source: "file" };
  }

  const missing: string[] = [];
  if (!provider) missing.push("provider");
  if (!settings.model) missing.push("model");
  if (!settings.apiKey) missing.push("api key");
  const ready = missing.length === 0 && providerValid;

  if (options.json) {
    const describe = (setting: ResolvedSetting | undefined, redact: (value: string) => string = (v) => v) =>
      setting ? { ...setting, value: redact(setting.value) } : null;
    const payload = {
      path,
      exists,
      ready,
      llm: {
        provider: describe(settings.provider),
        model: describe(settings.model),
        baseUrl: describe(settings.baseUrl, (value) => maskDataValue("BASE_URL", value)),
        apiKey: describe(settings.apiKey, maskSecret),
      },
      env: dataEnv,
      file: redactStored(config),
    };
    writeLine(io.stdout, JSON.stringify(payload, null, 2));
    return 0;
  }

  const lines = [`Config file: ${path}${exists ? "" : " (not created yet)"}`, "", "LLM:"];
  lines.push(
    ...formatRows([
      ["provider", provider ? `${provider}${providerValid ? "" : " (unknown provider)"}` : "(not set)", sourceLabel(settings.provider)],
      ["model", settings.model?.value ?? "(not set)", sourceLabel(settings.model)],
      ["base URL", displayBaseUrl(provider, settings.baseUrl?.value), sourceLabel(settings.baseUrl)],
      ["api key", maskSecret(settings.apiKey?.value), sourceLabel(settings.apiKey)],
    ]),
  );
  lines.push("", "Data:");
  const dataRows = Object.entries(dataEnv).map(
    ([key, { value, source }]): [string, string, string] => [key, value, source === "env" ? "env" : "config file"],
  );
  lines.push(...(dataRows.length > 0 ? formatRows(dataRows) : ["  (none set)"]));
  lines.push("");
  if (!providerValid) {
    lines.push(`Status: unknown provider "${provider}". Supported: ${PROVIDER_IDS.join(", ")}.`);
  } else if (ready) {
    lines.push("Status: ready");
  } else {
    lines.push(`Status: incomplete (missing ${missing.join(", ")}). Run "rovanta config init".`);
  }
  writeLine(io.stdout, lines.join("\n"));
  return 0;
}

function summaryLines(llm: NonNullable<StoredConfig["llm"]>): string[] {
  return formatRows([
    ["provider", llm.provider ?? "(not set)"],
    ["model", llm.model ?? "(not set)"],
    ["base URL", displayBaseUrl(llm.provider, llm.baseUrl)],
    ["api key", maskSecret(llm.apiKey)],
  ]);
}

async function runInit(io: CliIO): Promise<number> {
  const config = await loadConfig(io.env);
  const previous = config.llm ?? {};

  try {
    const provider = (await choose(
      io,
      "LLM provider:",
      PROVIDER_INFO.map((info) => ({ value: info.id, label: `${info.label} (${info.id})` })),
      previous.provider ?? PROVIDER_INFO[0]?.id,
    )) as ProviderId;
    const info = getProviderInfo(provider);
    const same = previous.provider === provider;

    let model = "";
    while (!model) {
      model = await ask(io, `Model ID (${info?.modelPlaceholder ?? "required"})`, same ? previous.model : undefined);
      if (!model) io.stderr.write("A model ID is required.\n");
    }

    let baseUrl: string | undefined;
    for (;;) {
      const current = same ? previous.baseUrl : undefined;
      const answer = info?.requiresBaseUrl
        ? await ask(io, "Base URL", current ?? info.defaultBaseUrl)
        : await ask(io, `Base URL override (Enter for default ${info?.defaultBaseUrl ?? "endpoint"})`, current);
      if (!answer) break;
      try {
        baseUrl = assertSafeBaseUrl(answer);
        break;
      } catch (error) {
        io.stderr.write(`${errorMessage(error)}\n`);
      }
    }
    if (!info?.requiresBaseUrl && baseUrl && baseUrl === info?.defaultBaseUrl) baseUrl = undefined;

    const existingKey = same ? previous.apiKey : undefined;
    const keyAnswer = await askSecret(
      io,
      existingKey ? `API key (Enter to keep ${maskSecret(existingKey)})` : "API key (input hidden)",
    );
    const apiKey = keyAnswer || existingKey;

    const llm: NonNullable<StoredConfig["llm"]> = { provider, model };
    if (baseUrl) llm.baseUrl = baseUrl;
    if (apiKey) llm.apiKey = apiKey;
    const path = await saveConfig({ ...config, llm }, io.env);

    writeLine(io.stdout, `Saved ${path}`);
    writeLine(io.stdout, summaryLines(llm).join("\n"));
    if (!apiKey) {
      const envVars = ["ROVANTA_API_KEY", ...PROVIDER_KEY_ENV[provider]].join(" or ");
      writeLine(io.stdout, `\nNo API key saved. Set ${envVars}, or run "rovanta config set api-key".`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof PromptClosedError)) throw error;
    if (isInteractive(io)) {
      writeLine(io.stderr, "Cancelled. Nothing was saved.");
      return 1;
    }
    writeLine(
      io.stderr,
      [
        `"rovanta config init" is interactive and no input was received.`,
        "For scripts and CI, use environment variables instead:",
        "  ROVANTA_PROVIDER, ROVANTA_MODEL, ROVANTA_API_KEY (and ROVANTA_BASE_URL for openai-compatible)",
        'or set values one at a time with "rovanta config set <key> <value>".',
      ].join("\n"),
    );
    return 2;
  }
}

async function runSet(io: CliIO, positionals: string[]): Promise<number> {
  const [rawKey, rawValue, ...extra] = positionals;
  if (!rawKey) throw new UsageError("Missing key.");
  if (extra.length > 0) throw new UsageError("Too many arguments. Quote values that contain spaces.");
  const llmKey = parseLLMKey(rawKey);
  const dataKey = llmKey ? undefined : parseDataKey(rawKey);
  if (!llmKey && !dataKey) throw new UsageError(`Unknown key "${rawKey}".`);
  const keyName = llmKey ? LLM_KEY_LABELS[llmKey] : (dataKey as string);
  const secret = isSecretKey(llmKey ?? (dataKey as string));

  let value = rawValue?.trim();
  if (rawValue === undefined) {
    if (!secret) throw new UsageError(`Missing value for ${keyName}.`);
    try {
      value = await askSecret(io, `${keyName} (input hidden)`);
    } catch (error) {
      if (error instanceof PromptClosedError) throw new UsageError(`No value received for ${keyName}.`);
      throw error;
    }
  } else if (secret) {
    writeLine(
      io.stderr,
      `Warning: passing ${keyName} on the command line can leave it in your shell history. ` +
        `Run "rovanta config set ${keyName}" without a value to enter it hidden.`,
    );
  }
  if (!value) throw new UsageError(`Value for ${keyName} must not be empty.`);

  const config = await loadConfig(io.env);
  if (llmKey) {
    const llm = { ...config.llm };
    if (llmKey === "provider") {
      const provider = validateProvider(value);
      if (llm.provider && llm.provider !== provider && (llm.model || llm.apiKey || llm.baseUrl)) {
        delete llm.model;
        delete llm.apiKey;
        delete llm.baseUrl;
        writeLine(io.stderr, `Note: cleared model, base URL and API key saved for ${llm.provider}.`);
      }
      llm.provider = provider;
    } else if (llmKey === "baseUrl") {
      llm.baseUrl = validateBaseUrl(value);
    } else {
      llm[llmKey] = value;
    }
    config.llm = llm;
    value = llm[llmKey] as string;
  } else {
    value = validateDataValue(dataKey as string, value);
    config.env = { ...config.env, [dataKey as string]: value };
  }

  const path = await saveConfig(config, io.env);
  const shown = llmKey ? (secret ? maskSecret(value) : value) : maskDataValue(dataKey as string, value);
  writeLine(io.stdout, `Set ${keyName} = ${shown} in ${path}`);
  return 0;
}

async function runUnset(io: CliIO, positionals: string[]): Promise<number> {
  const [rawKey, ...extra] = positionals;
  if (!rawKey) throw new UsageError("Missing key.");
  if (extra.length > 0) throw new UsageError("Too many arguments.");
  const llmKey = parseLLMKey(rawKey);
  const dataKey = llmKey ? undefined : parseDataKey(rawKey);
  if (!llmKey && !dataKey) throw new UsageError(`Unknown key "${rawKey}".`);
  const keyName = llmKey ? LLM_KEY_LABELS[llmKey] : (dataKey as string);

  const config = await loadConfig(io.env);
  let removed = false;
  if (llmKey && config.llm?.[llmKey] !== undefined) {
    const llm = { ...config.llm };
    delete llm[llmKey];
    config.llm = llm;
    removed = true;
  } else if (dataKey && config.env?.[dataKey] !== undefined) {
    const env = { ...config.env };
    delete env[dataKey];
    config.env = env;
    removed = true;
  }
  if (!removed) {
    writeLine(io.stdout, `${keyName} was not set in ${configPath(io.env)}`);
    return 0;
  }
  const path = await saveConfig(config, io.env);
  writeLine(io.stdout, `Removed ${keyName} from ${path}`);
  return 0;
}

export const runConfigCommand: CommandHandler = async (args, io) => {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        provider: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    writeLine(io.stderr, `${errorMessage(error)}\n\n${usage()}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    writeLine(io.stdout, usage());
    return 0;
  }

  const [sub = "show", ...rest] = positionals;
  const hasOverrides = values.provider !== undefined || values.model !== undefined || values["base-url"] !== undefined;

  try {
    if (sub !== "show" && (values.json || hasOverrides)) {
      throw new UsageError(`--json, --provider, --model and --base-url apply only to "config show".`);
    }
    switch (sub) {
      case "show":
        if (rest.length > 0) throw new UsageError(`Unexpected argument "${rest[0]}".`);
        return await runShow(io, {
          json: values.json === true,
          provider: values.provider,
          model: values.model,
          baseUrl: values["base-url"],
        });
      case "init":
        if (rest.length > 0) throw new UsageError(`Unexpected argument "${rest[0]}".`);
        return await runInit(io);
      case "set":
        return await runSet(io, rest);
      case "unset":
        return await runUnset(io, rest);
      case "path":
        if (rest.length > 0) throw new UsageError(`Unexpected argument "${rest[0]}".`);
        writeLine(io.stdout, configPath(io.env));
        return 0;
      default:
        throw new UsageError(`Unknown subcommand "${sub}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      writeLine(io.stderr, `${error.message}\n\n${usage()}`);
      return 2;
    }
    writeLine(io.stderr, `Error: ${errorMessage(error)}`);
    return 1;
  }
};
