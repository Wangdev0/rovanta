import { describe, expect, it } from "vitest";
import { assertSafeBaseUrl, parseSSE, parseToolArguments, postJson } from "@/core/llm/http";
import { FAKE_KEY, catchError, collect, jsonResponse, mockFetch, sseResponse, textResponse } from "./helpers";

describe("postJson", () => {
  const post = (fetchImpl: ReturnType<typeof mockFetch>, signal?: AbortSignal) =>
    postJson(fetchImpl, "https://example.test/x", { authorization: `Bearer ${FAKE_KEY}` }, { a: 1 }, signal, [
      FAKE_KEY,
    ]);

  it("maps HTTP statuses to error codes", async () => {
    expect((await catchError(() => post(mockFetch(textResponse("", 401))))).code).toBe("INVALID_API_KEY");
    expect((await catchError(() => post(mockFetch(textResponse("", 429))))).code).toBe("RATE_LIMITED");
    expect((await catchError(() => post(mockFetch(textResponse("", 503))))).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("maps network failure to PROVIDER_UNAVAILABLE without leaking details", async () => {
    const err = await catchError(() => post(mockFetch(new TypeError(`failed ${FAKE_KEY}`))));
    expect(err.code).toBe("PROVIDER_UNAVAILABLE");
    expect(err.message).not.toContain(FAKE_KEY);
  });

  it("maps abort to ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await catchError(() => post(mockFetch(jsonResponse({})), controller.signal))).code).toBe("ABORTED");
    const abortErr = new DOMException("aborted", "AbortError");
    expect((await catchError(() => post(mockFetch(abortErr)))).code).toBe("ABORTED");
  });

  it("includes a redacted provider message", async () => {
    const res = jsonResponse({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }, 401);
    const err = await catchError(() => post(mockFetch(res)));
    expect(err.message).toContain("Incorrect API key provided");
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toContain("Bearer");
  });
});

describe("parseSSE", () => {
  it("parses events split across arbitrary chunk boundaries and stops at [DONE]", async () => {
    const res = sseResponse(["da", "ta: {\"a\":1}\r", "\n\r\nevent: x\ndata: li", "ne1\ndata: line2\n\n", "data: [DONE]\n\ndata: after\n\n"]);
    const events = await collect(parseSSE(res.body));
    expect(events).toEqual([{ data: "{\"a\":1}" }, { event: "x", data: "line1\nline2" }]);
  });

  it("flushes a trailing event without a final blank line and ignores comments", async () => {
    const events = await collect(parseSSE(sseResponse([": ping\n\ndata: tail"]).body));
    expect(events).toEqual([{ data: "tail" }]);
  });
});

describe("parseToolArguments", () => {
  it("parses JSON, defaults empty to {}, and keeps malformed raw strings", () => {
    expect(parseToolArguments("{\"x\":1}")).toEqual({ x: 1 });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("{bad")).toBe("{bad");
  });
});

describe("assertSafeBaseUrl", () => {
  it("normalizes trailing slashes and enforces https except loopback", () => {
    expect(assertSafeBaseUrl("https://api.example.test/v1///")).toBe("https://api.example.test/v1");
    expect(assertSafeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(assertSafeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => assertSafeBaseUrl("http://example.test")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertSafeBaseUrl("https://u:p@example.test")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => assertSafeBaseUrl("not a url")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
