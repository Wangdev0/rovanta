import { vi } from "vitest";
import type { FetchLike } from "@/core/llm/types";

/** DEV FIXTURE: fake key used only in tests. */
export const FAKE_KEY = "sk-test-DEVFIXTURE-1234567890abcdef";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

/** Build an SSE response whose body is delivered in the given raw chunks. */
export function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Split a string into fixed-size pieces to exercise chunk-boundary handling. */
export function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn<FetchLike>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  return fn;
}

export function lastCall(fn: ReturnType<typeof mockFetch>, index = 0) {
  const call = fn.mock.calls[index];
  if (!call) throw new Error("fetch was not called");
  const [url, init] = call;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return { url: String(url), init, headers, body };
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

export async function catchError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error("expected rejection");
}

export const TOOL = {
  name: "get_price",
  description: "DEV FIXTURE tool",
  parameters: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { symbol: { type: "string", description: "Ticker" } },
    required: ["symbol"],
    additionalProperties: false,
  },
};
