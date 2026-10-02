import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/core/llm/anthropic";
import { GoogleProvider } from "@/core/llm/google";
import { OpenAICompatibleProvider } from "@/core/llm/openai-compatible";
import {
  PROVIDER_INFO,
  createProvider,
  getProviderInfo,
  listProviders,
  registerProvider,
} from "@/core/llm/registry";
import type { LLMConfig, LLMProvider } from "@/core/llm/types";
import { FAKE_KEY, jsonResponse, lastCall, mockFetch } from "./helpers";

const base: LLMConfig = { provider: "openai-compatible", apiKey: FAKE_KEY, model: "dev-model" };

describe("registry", () => {
  it("lists built-in providers with docs and defaults", () => {
    expect(listProviders().map((p) => p.id)).toEqual(expect.arrayContaining(["openai-compatible", "anthropic", "google"]));
    expect(getProviderInfo("openai-compatible")).toMatchObject({
      label: "OpenAI-compatible",
      requiresBaseUrl: true,
      defaultBaseUrl: "https://api.openai.com/v1",
    });
    expect(getProviderInfo("anthropic")?.requiresBaseUrl).toBe(false);
    expect(getProviderInfo("google")?.label).toBe("Google Gemini");
    expect(PROVIDER_INFO.every((p) => p.docsUrl.startsWith("https://"))).toBe(true);
    expect(getProviderInfo("nope")).toBeUndefined();
  });

  it("creates the right adapter", () => {
    expect(createProvider(base)).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createProvider({ ...base, provider: "anthropic" })).toBeInstanceOf(AnthropicProvider);
    expect(createProvider({ ...base, provider: "google" })).toBeInstanceOf(GoogleProvider);
  });

  it("rejects unsupported providers", () => {
    expect(() => createProvider({ ...base, provider: "mystery" as LLMConfig["provider"] })).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_PROVIDER" }),
    );
  });

  it("rejects missing key or model", () => {
    expect(() => createProvider({ ...base, apiKey: "  " })).toThrow(
      expect.objectContaining({ code: "PROVIDER_NOT_CONFIGURED" }),
    );
    expect(() => createProvider({ ...base, model: "" })).toThrow(
      expect.objectContaining({ code: "PROVIDER_NOT_CONFIGURED" }),
    );
  });

  it("rejects non-https base URLs but allows loopback http", async () => {
    expect(() => createProvider({ ...base, baseUrl: "http://evil.example.test/v1" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => createProvider({ ...base, provider: "anthropic", baseUrl: "ftp://x.test" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(createProvider({ ...base, baseUrl: "http://127.0.0.1:1234/v1" })).toBeInstanceOf(OpenAICompatibleProvider);

    const fetchImpl = mockFetch(jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    await createProvider({ ...base, baseUrl: "http://localhost:11434/v1/" }, fetchImpl).generate({ messages: [] });
    expect(lastCall(fetchImpl).url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("supports registering an extension provider", () => {
    const stub = { id: "anthropic", model: "m" } as unknown as LLMProvider;
    registerProvider(
      "dev-fixture-provider",
      { id: "anthropic", label: "DEV FIXTURE", requiresBaseUrl: false, modelPlaceholder: "m", docsUrl: "https://example.test" },
      () => stub,
    );
    expect(createProvider({ ...base, provider: "dev-fixture-provider" as LLMConfig["provider"] })).toBe(stub);
  });
});
