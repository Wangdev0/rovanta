import { describe, expect, it } from "vitest";
import { GoogleProvider, cleanSchemaForGemini } from "@/core/llm/google";
import type { ChatMessage } from "@/core/llm/types";
import {
  FAKE_KEY,
  TOOL,
  catchError,
  collect,
  jsonResponse,
  lastCall,
  mockFetch,
  splitEvery,
  sseResponse,
  textResponse,
} from "./helpers";

const make = (fetchImpl: ReturnType<typeof mockFetch>) =>
  new GoogleProvider({ apiKey: FAKE_KEY, model: "dev-model" }, fetchImpl);

const okBody = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };

describe("GoogleProvider", () => {
  it("builds the request shape with the key only in a header", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_price", arguments: { symbol: "ETH" } }] },
      { role: "tool", toolCallId: "c1", name: "get_price", content: "{\"usd\":1}" },
      { role: "tool", toolCallId: "c2", name: "get_price", content: "plain text" },
    ];
    const fetchImpl = mockFetch(jsonResponse(okBody));
    await make(fetchImpl).generate({ messages, tools: [TOOL], json: true, maxTokens: 10 });
    const { url, headers, body } = lastCall(fetchImpl);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/dev-model:generateContent");
    expect(url).not.toContain(FAKE_KEY);
    expect(url).not.toContain("key=");
    expect(headers["x-goog-api-key"]).toBe(FAKE_KEY);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 10 });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: TOOL.name,
            description: TOOL.description,
            parameters: {
              type: "object",
              properties: { symbol: { type: "string", description: "Ticker" } },
              required: ["symbol"],
            },
          },
        ],
      },
    ]);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ functionCall: { name: "get_price", args: { symbol: "ETH" } } }] },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "get_price", response: { content: { usd: 1 } } } },
          { functionResponse: { name: "get_price", response: { content: "plain text" } } },
        ],
      },
    ]);
  });

  it("sets responseMimeType for json only without tools", async () => {
    const fetchImpl = mockFetch(jsonResponse(okBody));
    await make(fetchImpl).generate({ messages: [{ role: "user", content: "q" }], json: true });
    expect(lastCall(fetchImpl).body.generationConfig).toEqual({ responseMimeType: "application/json" });
  });

  it("parses function calls and generates ids", async () => {
    const fetchImpl = mockFetch(
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "thinking", thought: true },
                { functionCall: { name: "get_price", args: { symbol: "ETH" } } },
                { functionCall: { name: "get_price", args: { symbol: "BTC" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
      }),
    );
    const result = await make(fetchImpl).toolCall({ messages: [{ role: "user", content: "x" }], tools: [TOOL] });
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(result.toolCalls.map((c) => c.arguments)).toEqual([{ symbol: "ETH" }, { symbol: "BTC" }]);
    expect(result.toolCalls[0]?.id).toMatch(/^call_0_[0-9a-f]+$/);
    expect(result.toolCalls[1]?.id).toMatch(/^call_1_[0-9a-f]+$/);
  });

  it("maps errors and never leaks the key", async () => {
    const leak = jsonResponse([{ error: { code: 400, message: `API key not valid: ${FAKE_KEY}` } }], 403);
    const e403 = await catchError(() => make(mockFetch(leak)).generate({ messages: [] }));
    expect(e403.code).toBe("INVALID_API_KEY");
    expect(e403.message).toContain("API key not valid");
    expect(e403.message).not.toContain(FAKE_KEY);
    expect((await catchError(() => make(mockFetch(textResponse("", 429))).generate({ messages: [] }))).code).toBe(
      "RATE_LIMITED",
    );
    expect((await catchError(() => make(mockFetch(textResponse("", 500))).generate({ messages: [] }))).code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect((await catchError(() => make(mockFetch(new TypeError("x"))).generate({ messages: [] }))).code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });

  it("streams via alt=sse across chunk boundaries", async () => {
    const events = [
      { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] },
      {
        candidates: [
          { content: { role: "model", parts: [{ functionCall: { name: "get_price", args: { symbol: "SOL" } } }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    ];
    const raw = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
    const fetchImpl = mockFetch(sseResponse(splitEvery(raw, 5)));
    const chunks = await collect(make(fetchImpl).stream({ messages: [{ role: "user", content: "q" }] }));
    const { url, headers } = lastCall(fetchImpl);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/dev-model:streamGenerateContent?alt=sse");
    expect(headers["x-goog-api-key"]).toBe(FAKE_KEY);
    expect(chunks.slice(0, -1)).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
    ]);
    const done = chunks[chunks.length - 1];
    if (done?.type !== "done") throw new Error("missing done chunk");
    expect(done.result.text).toBe("Hello");
    expect(done.result.finishReason).toBe("tool_calls");
    expect(done.result.toolCalls).toHaveLength(1);
    expect(done.result.toolCalls[0]).toMatchObject({ name: "get_price", arguments: { symbol: "SOL" } });
  });
});

describe("cleanSchemaForGemini", () => {
  it("removes unsupported keys recursively and keeps the supported subset", () => {
    const cleaned = cleanSchemaForGemini({
      $schema: "x",
      $defs: { a: {} },
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^a", default: "a", examples: ["a"], minLength: 1 },
        when: { type: "string", format: "date-time" },
        email: { type: "string", format: "email" },
        count: { type: "integer", minimum: 0, maximum: 10, exclusiveMinimum: 0 },
        maybe: { type: ["number", "null"] },
        kind: { type: "string", enum: ["a", "b"] },
        list: { type: "array", items: { type: "object", properties: { x: { $ref: "#/$defs/a" } }, additionalProperties: false } },
      },
      required: ["name", "ghost"],
    });
    expect(cleaned).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        when: { type: "string", format: "date-time" },
        email: { type: "string" },
        count: { type: "integer", minimum: 0, maximum: 10 },
        maybe: { type: "number", nullable: true },
        kind: { type: "string", enum: ["a", "b"] },
        list: { type: "array", items: { type: "object", properties: { x: {} } } },
      },
      required: ["name"],
    });
  });
});
