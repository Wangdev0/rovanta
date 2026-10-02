import type { z } from "zod";
import { RovantaError, codeFromHttpStatus, type RovantaErrorCode } from "@/core/errors";
import { redactSecrets } from "@/core/security/redact";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Values removed verbatim from any error message, e.g. API keys sent in headers. */
  secrets?: Array<string | undefined>;
  /** Override the error raised for "not found" style statuses (default: 404 -> DATA_UNAVAILABLE). */
  notFound?: { statuses?: number[]; code?: RovantaErrorCode; message?: string };
}

export const DEFAULT_TIMEOUT_MS = 10_000;

function describe(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "upstream";
  }
}

export async function fetchJson(fetchImpl: FetchLike, url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const { headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS, secrets = [], notFound } = options;
  const fail = (code: RovantaErrorCode, message: string, cause?: unknown): RovantaError =>
    new RovantaError(code, redactSecrets(message, secrets), cause === undefined ? undefined : { cause });

  if (signal?.aborted) throw new RovantaError("ABORTED");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const target = describe(url);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new RovantaError("ABORTED");
    if (timedOut) throw fail("DATA_UNAVAILABLE", `Request to ${target} timed out after ${timeoutMs} ms.`);
    throw fail("DATA_UNAVAILABLE", `Could not reach ${target}.`, err instanceof Error ? redactSecrets(err.message, secrets) : undefined);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!res.ok) {
    const notFoundStatuses = notFound?.statuses ?? [404];
    if (res.status === 429) {
      throw fail("RATE_LIMITED", `${target} rate limit reached (HTTP 429). Wait before retrying or configure an API key.`);
    }
    if (notFoundStatuses.includes(res.status)) {
      throw fail(notFound?.code ?? "DATA_UNAVAILABLE", notFound?.message ?? `${target} returned HTTP ${res.status}: not found.`);
    }
    throw fail(codeFromHttpStatus(res.status, "data"), `${target} returned HTTP ${res.status}.`);
  }

  try {
    return await res.json();
  } catch {
    throw fail("MALFORMED_TOOL_RESULT", `${target} returned a response that is not valid JSON.`);
  }
}

/** Parse an upstream payload; shape mismatches become MALFORMED_TOOL_RESULT instead of crashing. */
export function parseUpstream<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new RovantaError("MALFORMED_TOOL_RESULT", `${label} returned an unexpected shape${where}.`);
  }
  return result.data;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export const defaultFetch: FetchLike = (input, init) => fetch(input, init);
