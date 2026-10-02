export type ProviderId = "openai-compatible" | "anthropic" | "google";

export interface LLMConfig {
  provider: ProviderId;
  apiKey: string;
  model: string;
  /** Required for openai-compatible, optional override for others. */
  baseUrl?: string;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Parsed JSON arguments. Unvalidated: callers must validate against the tool schema. */
  arguments: unknown;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** JSON Schema object describing tool parameters. */
export type JSONSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface GenerateRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object response where supported. */
  json?: boolean;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "other";

export interface GenerateResult {
  text: string;
  toolCalls: ToolCallRequest[];
  finishReason: FinishReason;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "done"; result: GenerateResult };

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  /** Like generate, but `tools` is required and tool calls are expected. */
  toolCall(request: GenerateRequest & { tools: ToolSpec[] }): Promise<GenerateResult>;
}

export type FetchLike = typeof fetch;

export type ProviderFactory = (config: LLMConfig, fetchImpl?: FetchLike) => LLMProvider;

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultBaseUrl?: string;
  requiresBaseUrl: boolean;
  modelPlaceholder: string;
  docsUrl: string;
}
