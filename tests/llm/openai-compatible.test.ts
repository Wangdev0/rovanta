import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "@/core/llm/openai-compatible";
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

const make = (fetchImpl: ReturnType<typeof mockFetch>, baseUrl = "https://api.example.test/v1/") =>
  new OpenAICompatibleProvider({ apiKey: FAKE_KEY, model: "dev-model", baseUrl }, fetchImpl);

const conversation: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "price?" },
  { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_price", arguments: { symbol: "ETH" } }] },
  { role: "tool", toolCallId: "call_1", name: "get_price", content: "{\"usd\":1}" },
];

describe("OpenAICompatibleProvider", () => {
  it("builds the request shape", async () => {
    const fetchImpl = mockFetch(
      jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    await make(fetchImpl).generate({ messages: conversation, tools: [TOOL], json: true, temperature: 0.2, maxTokens: 50 });
    const { url, headers, body } = lastCall(fetchImpl);
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(body.model).toBe("dev-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(50);
    expect(body.tools).toEqual([
      { type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.parameters } },
    ]);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "price?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_price", arguments: "{\"symbol\":\"ETH\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "{\"usd\":1}" },
    ]);
  });

  it("parses tool calls, keeping malformed arguments as raw strings", async () => {
    const fetchImpl = mockFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "a", type: "function", function: { name: "get_price", arguments: "{\"symbol\":\"BTC\"}" } },
                { id: "b", type: "function", function: { name: "get_price", arguments: "{not json" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const result = await make(fetchImpl).toolCall({ messages: [{ role: "user", content: "x" }], tools: [TOOL] });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "a", name: "get_price", arguments: { symbol: "BTC" } },
      { id: "b", name: "get_price", arguments: "{not json" },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("maps errors and never leaks the key", async () => {
    const leak = jsonResponse({ error: { message: `bad key ${FAKE_KEY}` } }, 401);
    const e401 = await catchError(() => make(mockFetch(leak)).generate({ messages: [] }));
    expect(e401.code).toBe("INVALID_API_KEY");
    expect(e401.message).not.toContain(FAKE_KEY);

    const e429 = await catchError(() => make(mockFetch(textResponse("slow down", 429))).generate({ messages: [] }));
    expect(e429.code).toBe("RATE_LIMITED");
    const e500 = await catchError(() => make(mockFetch(textResponse("", 502))).generate({ messages: [] }));
    expect(e500.code).toBe("PROVIDER_UNAVAILABLE");
    const eNet = await catchError(() => make(mockFetch(new TypeError("fetch failed"))).generate({ messages: [] }));
    expect(eNet.code).toBe("PROVIDER_UNAVAILABLE");
    for (const e of [e429, e500, eNet]) expect(e.message).not.toContain(FAKE_KEY);
  });

  it("streams text and tool call deltas split across chunks", async () => {
    const events = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "get_price", arguments: "{\"sym" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "bol\":\"ETH\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const raw = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    const fetchImpl = mockFetch(sseResponse(splitEvery(raw, 7)));
    const chunks = await collect(make(fetchImpl).stream({ messages: [{ role: "user", content: "hi" }] }));
    expect(lastCall(fetchImpl).body.stream).toBe(true);
    expect(chunks.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.delta : ""))).toEqual(["Hel", "lo"]);
    const done = chunks[chunks.length - 1];
    expect(done).toEqual({
      type: "done",
      result: {
        text: "Hello",
        toolCalls: [{ id: "c0", name: "get_price", arguments: { symbol: "ETH" } }],
        finishReason: "tool_calls",
      },
    });
  });

  it("requires a base URL and rejects non-https", () => {
    expect(() => make(mockFetch(), "")).toThrow(expect.objectContaining({ code: "PROVIDER_NOT_CONFIGURED" }));
    expect(() => make(mockFetch(), "http://api.example.test")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});
