export const ERROR_CODES = [
  "INVALID_API_KEY",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "UNSUPPORTED_PROVIDER",
  "PROVIDER_NOT_CONFIGURED",
  "RPC_UNAVAILABLE",
  "RPC_NOT_CONFIGURED",
  "INVALID_TOKEN",
  "INVALID_WALLET",
  "INVALID_INPUT",
  "DATA_UNAVAILABLE",
  "TOOL_TIMEOUT",
  "MALFORMED_TOOL_RESULT",
  "UNKNOWN_TOOL",
  "ABORTED",
  "INTERNAL",
] as const;

export type RovantaErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Record<RovantaErrorCode, string> = {
  INVALID_API_KEY:
    "The model provider rejected the API key. Check the key in Settings.",
  PROVIDER_UNAVAILABLE:
    "The model provider could not be reached. Check the base URL and your network.",
  RATE_LIMITED:
    "Rate limit reached. Wait a moment before retrying, or use a different key or model.",
  UNSUPPORTED_PROVIDER: "This model provider is not supported.",
  PROVIDER_NOT_CONFIGURED:
    "No model provider is configured. Add a provider, model and API key in Settings.",
  RPC_UNAVAILABLE: "The chain RPC endpoint could not be reached.",
  RPC_NOT_CONFIGURED:
    "No RPC endpoint is configured for this chain. Set it in your environment configuration.",
  INVALID_TOKEN: "The token identifier is invalid or could not be resolved.",
  INVALID_WALLET: "The wallet address is not a valid public address.",
  INVALID_INPUT: "The request input failed validation.",
  DATA_UNAVAILABLE: "The requested data is not available from configured sources.",
  TOOL_TIMEOUT: "The research tool timed out.",
  MALFORMED_TOOL_RESULT:
    "A data source returned a result that failed validation and was discarded.",
  UNKNOWN_TOOL: "The model requested a tool that does not exist.",
  ABORTED: "The request was cancelled.",
  INTERNAL: "An unexpected error occurred.",
};

const RETRYABLE: ReadonlySet<RovantaErrorCode> = new Set([
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "RPC_UNAVAILABLE",
  "TOOL_TIMEOUT",
]);

export interface RovantaErrorJSON {
  code: RovantaErrorCode;
  message: string;
  retryable: boolean;
}

export class RovantaError extends Error {
  readonly code: RovantaErrorCode;
  readonly retryable: boolean;

  constructor(code: RovantaErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? ERROR_MESSAGES[code], options);
    this.name = "RovantaError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
  }

  toJSON(): RovantaErrorJSON {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function isRovantaError(value: unknown): value is RovantaError {
  return value instanceof RovantaError;
}

export function toRovantaError(value: unknown, fallback: RovantaErrorCode = "INTERNAL"): RovantaError {
  if (value instanceof RovantaError) return value;
  if (value instanceof DOMException && value.name === "AbortError") {
    return new RovantaError("ABORTED");
  }
  if (value instanceof Error && value.name === "AbortError") {
    return new RovantaError("ABORTED");
  }
  return new RovantaError(fallback, undefined, { cause: value });
}

/** Map an HTTP status from an upstream API to an error code. */
export function codeFromHttpStatus(status: number, kind: "llm" | "data" | "rpc"): RovantaErrorCode {
  if (status === 401 || status === 403) return kind === "llm" ? "INVALID_API_KEY" : "DATA_UNAVAILABLE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return kind === "llm" ? "PROVIDER_UNAVAILABLE" : "DATA_UNAVAILABLE";
  if (status >= 500) return kind === "rpc" ? "RPC_UNAVAILABLE" : kind === "llm" ? "PROVIDER_UNAVAILABLE" : "DATA_UNAVAILABLE";
  return kind === "llm" ? "PROVIDER_UNAVAILABLE" : "DATA_UNAVAILABLE";
}
