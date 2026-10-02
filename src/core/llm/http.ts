import { RovantaError, ERROR_MESSAGES, codeFromHttpStatus, type RovantaErrorCode } from "@/core/errors";
import { redactSecrets } from "@/core/security/redact";
import type { FetchLike } from "./types";

const MAX_PROVIDER_MESSAGE = 300;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Only https, or http for loopback hosts. Credentials in the URL are rejected. */
export function assertSafeBaseUrl(url: string): string {
  const normalized = normalizeBaseUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new RovantaError("INVALID_INPUT", "The base URL is not a valid URL.");
  }
  if (parsed.username || parsed.password) {
    throw new RovantaError("INVALID_INPUT", "The base URL must not contain credentials.");
  }
  if (parsed.protocol === "https:") return normalized;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) return normalized;
  throw new RovantaError(
    "INVALID_INPUT",
    "The base URL must use https (http is allowed only for localhost or 127.0.0.1).",
  );
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorFromUnknown(error: unknown, signal?: AbortSignal): RovantaError {
  if (error instanceof RovantaError) return error;
  if (isAbortError(error, signal)) return new RovantaError("ABORTED", undefined, { cause: error });
  return new RovantaError("PROVIDER_UNAVAILABLE");
}

function sanitizeProviderMessage(message: string, secrets: string[]): string {
  const redacted = redactSecrets(message.replace(/\s+/g, " ").trim(), secrets);
  return redacted.length > MAX_PROVIDER_MESSAGE ? `${redacted.slice(0, MAX_PROVIDER_MESSAGE)}…` : redacted;
}

function extractProviderMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of candidates) {
      if (!isRecord(item)) continue;
      const err = item.error;
      if (typeof err === "string") return err;
      if (isRecord(err) && typeof err.message === "string") return err.message;
      if (typeof item.message === "string") return item.message;
    }
  } catch {
    // Non-JSON error bodies are summarized as plain text below.
  }
  return raw;
}

/** Build an RovantaError for a provider-reported failure, redacting secrets from any provider text. */
export function providerError(code: RovantaErrorCode, detail: string | undefined, secrets: string[]): RovantaError {
  const clean = detail ? sanitizeProviderMessage(detail, secrets) : "";
  return new RovantaError(code, clean ? `${ERROR_MESSAGES[code]} (${clean})` : ERROR_MESSAGES[code]);
}

/**
 * POST a JSON body and return the successful Response.
 * Network failure -> PROVIDER_UNAVAILABLE, abort -> ABORTED, non-2xx -> codeFromHttpStatus(status, "llm").
 * Thrown messages never include request headers; provider text is redacted against `secrets`.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  secrets: string[] = [],
): Promise<Response> {
  if (signal?.aborted) throw new RovantaError("ABORTED");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw errorFromUnknown(error, signal);
  }
  if (response.ok) return response;

  const code = codeFromHttpStatus(response.status, "llm");
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }
  const detail = raw ? extractProviderMessage(raw) : "";
  throw providerError(code, `HTTP ${response.status}${detail ? `: ${detail}` : ""}`, secrets);
}

export async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error, signal)) throw new RovantaError("ABORTED", undefined, { cause: error });
    throw new RovantaError("PROVIDER_UNAVAILABLE", "The model provider returned an unreadable response.");
  }
}

/** Parse tool-call arguments. Invalid JSON is returned as the raw string so schema validation fails cleanly. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function assertTools(tools: unknown[] | undefined): void {
  if (!tools || tools.length === 0) {
    throw new RovantaError("INVALID_INPUT", "toolCall requires at least one tool.");
  }
}

export function assertConfigured(apiKey: string | undefined, model: string | undefined): void {
  if (!apiKey?.trim() || !model?.trim()) throw new RovantaError("PROVIDER_NOT_CONFIGURED");
}

export function randomSuffix(bytes = 6): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Parse a Server-Sent Events body. Yields one event per blank-line-terminated block,
 * joining multi-line `data:` fields. Stops at a `[DONE]` sentinel.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  if (!body) throw new RovantaError("PROVIDER_UNAVAILABLE", "The model provider returned an empty stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let finished = false;

  const dispatch = (): SSEEvent | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return null;
    }
    const evt: SSEEvent = { data: dataLines.join("\n") };
    if (eventName !== undefined) evt.event = eventName;
    eventName = undefined;
    dataLines = [];
    return evt;
  };

  const handleLine = (line: string): SSEEvent | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    return null;
  };

  try {
    while (!finished) {
      if (signal?.aborted) throw new RovantaError("ABORTED");
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw errorFromUnknown(error, signal);
      }
      if (chunk.done) {
        buffer += decoder.decode();
        finished = true;
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }

      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const sepLength = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
        if (!finished && buffer[newline] === "\r" && newline + 1 === buffer.length) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + sepLength);
        const evt = handleLine(line);
        if (evt) {
          if (evt.data.trim() === "[DONE]") return;
          yield evt;
        }
      }
    }
    if (buffer !== "") handleLine(buffer);
    const last = dispatch();
    if (last && last.data.trim() !== "[DONE]") yield last;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
