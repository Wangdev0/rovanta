import { RovantaError } from "@/core/errors";
import { ANTHROPIC_DEFAULT_BASE_URL, createAnthropicProvider } from "./anthropic";
import { GOOGLE_DEFAULT_BASE_URL, createGoogleProvider } from "./google";
import { assertSafeBaseUrl } from "./http";
import { OPENAI_DEFAULT_BASE_URL, createOpenAICompatibleProvider } from "./openai-compatible";
import type { FetchLike, LLMConfig, LLMProvider, ProviderFactory, ProviderInfo } from "./types";

const MODEL_PLACEHOLDER = "Model ID from your provider";

export const PROVIDER_INFO: ProviderInfo[] = [
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    defaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
    requiresBaseUrl: true,
    modelPlaceholder: MODEL_PLACEHOLDER,
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
    requiresBaseUrl: false,
    modelPlaceholder: MODEL_PLACEHOLDER,
    docsUrl: "https://docs.anthropic.com/en/api/messages",
  },
  {
    id: "google",
    label: "Google Gemini",
    defaultBaseUrl: GOOGLE_DEFAULT_BASE_URL,
    requiresBaseUrl: false,
    modelPlaceholder: MODEL_PLACEHOLDER,
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
];

interface RegistryEntry {
  info: ProviderInfo;
  factory: ProviderFactory;
}

const registry = new Map<string, RegistryEntry>();

export function registerProvider(id: string, info: ProviderInfo, factory: ProviderFactory): void {
  registry.set(id, { info, factory });
}

const BUILT_IN_FACTORIES: Record<string, ProviderFactory> = {
  "openai-compatible": createOpenAICompatibleProvider,
  anthropic: createAnthropicProvider,
  google: createGoogleProvider,
};

for (const info of PROVIDER_INFO) {
  const factory = BUILT_IN_FACTORIES[info.id];
  if (factory) registerProvider(info.id, info, factory);
}

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return registry.get(id)?.info;
}

export function listProviders(): ProviderInfo[] {
  return [...registry.values()].map((entry) => entry.info);
}

/**
 * Validate a user-supplied config and build a provider.
 * Unknown provider -> UNSUPPORTED_PROVIDER; missing key/model/base URL -> PROVIDER_NOT_CONFIGURED;
 * base URL that is not https (or http on localhost/127.0.0.1) -> INVALID_INPUT.
 */
export function createProvider(config: LLMConfig, fetchImpl?: FetchLike): LLMProvider {
  const entry = typeof config?.provider === "string" ? registry.get(config.provider) : undefined;
  if (!entry) throw new RovantaError("UNSUPPORTED_PROVIDER");

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (!apiKey || !model) throw new RovantaError("PROVIDER_NOT_CONFIGURED");

  const rawBaseUrl = typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl : undefined;
  const baseUrl = rawBaseUrl ?? entry.info.defaultBaseUrl;
  if (entry.info.requiresBaseUrl && !baseUrl) {
    throw new RovantaError("PROVIDER_NOT_CONFIGURED", "A base URL is required for this provider.");
  }

  const normalized: LLMConfig = { provider: config.provider, apiKey, model };
  if (baseUrl) normalized.baseUrl = assertSafeBaseUrl(baseUrl);
  return entry.factory(normalized, fetchImpl);
}
