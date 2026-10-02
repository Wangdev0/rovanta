import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "@/core/llm/anthropic";
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
  new AnthropicProvider({ apiKey: FAKE_KEY, model: "dev-model" }, fetchImpl);

const okBody = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };

describe("AnthropicProvider", () => {
  it("builds the request shape with browser header, system and merged tool results", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "checking",
        toolCalls: [
          { id: "t1", name: "get_price", arguments: { symbol: "ETH" } },
          { id: "t2", name: "get_price", arguments: { symbol: "BTC" } },
        ],
      },
      { role: "tool", toolCallId: "t1", name: "get_price", content: "1" },
      { role: "tool", toolCallId: "t2", name: "get_price", content: "2" },
    ];
    const fetchImpl = mockFetch(jsonResponse(okBody));
    await make(fetchImpl).generate({ messages, tools: [TOOL], json: true });
    const { url, headers, body } = lastCall(fetchImpl);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe(FAKE_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["content-type"]).toBe("application/json");
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toMatch(/^a\n\nb\n\n.*single valid JSON object/);
    expect(body.tools).toEqual([{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t1", name: "get_price", input: { symbol: "ETH" } },
          { type: "tool_use", id: "t2", name: "get_price", input: { symbol: "BTC" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "1" },
          { type: "tool_result", tool_use_id: "t2", content: "2" },
        ],
      },
    ]);
  });

  it("parses tool_use responses", async () => {
    const fetchImpl = mockFetch(
      jsonResponse({
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "toolu_1", name: "get_price", input: { symbol: "ETH" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    );
    const result = await make(fetchImpl).toolCall({ messages: [{ role: "user", content: "x" }], tools: [TOOL] });
    expect(result).toEqual({
      text: "let me check",
      toolCalls: [{ id: "toolu_1", name: "get_price", arguments: { symbol: "ETH" } }],
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });

  it("maps errors and never leaks the key", async () => {
    const e401 = await catchError(() =>
      make(mockFetch(jsonResponse({ type: "error", error: { message: `invalid x-api-key ${FAKE_KEY}` } }, 401))).generate({
        messages: [],
      }),
    );
    expect(e401.code).toBe("INVALID_API_KEY");
    expect(e401.message).not.toContain(FAKE_KEY);
    expect((await catchError(() => make(mockFetch(textResponse("", 429))).generate({ messages: [] }))).code).toBe(
      "RATE_LIMITED",
    );
    expect((await catchError(() => make(mockFetch(textResponse("", 529))).generate({ messages: [] }))).code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect((await catchError(() => make(mockFetch(new TypeError("x"))).generate({ messages: [] }))).code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
  });

  it("streams text and tool input deltas, including malformed tool JSON", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "get_price", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"symbol\":" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"ETH\"}" } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu2", name: "get_price", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{oops" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    const raw = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const chunks = await collect(make(mockFetch(sseResponse(splitEvery(raw, 11)))).stream({ messages: [] }));
    expect(chunks.slice(0, -1)).toEqual([
      { type: "text", delta: "Hi " },
      { type: "text", delta: "there" },
    ]);
    expect(chunks[chunks.length - 1]).toEqual({
      type: "done",
      result: {
        text: "Hi there",
        toolCalls: [
          { id: "tu1", name: "get_price", arguments: { symbol: "ETH" } },
          { id: "tu2", name: "get_price", arguments: "{oops" },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 7, outputTokens: 9 },
      },
    });
  });

  it("maps stream error events", async () => {
    const raw = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`;
    const err = await catchError(() => collect(make(mockFetch(sseResponse([raw]))).stream({ messages: [] })));
    expect(err.code).toBe("PROVIDER_UNAVAILABLE");
  });
});
