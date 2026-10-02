import { RovantaError, type RovantaErrorCode } from "@/core/errors";
import {
  assertConfigured,
  assertSafeBaseUrl,
  assertTools,
  defaultFetch,
  isRecord,
  parseSSE,
  parseToolArguments,
  postJson,
  providerError,
  readJson,
} from "./http";
import type {
  ChatMessage,
  FetchLike,
  FinishReason,
  GenerateRequest,
  GenerateResult,
  LLMConfig,
  LLMProvider,
  ProviderFactory,
  StreamChunk,
  ToolCallRequest,
  ToolSpec,
} from "./types";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
const JSON_INSTRUCTION =
  "Respond with a single valid JSON object only. Do not include prose, markdown or code fences.";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function toToolInput(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args;
  const parsed = typeof args === "string" ? parseToolArguments(args) : undefined;
  return isRecord(parsed) ? parsed : {};
}

export function toAnthropicPayload(messages: ChatMessage[], json = false): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage["role"], blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    switch (m.role) {
      case "system":
        if (m.content.trim()) systemParts.push(m.content);
        break;
      case "user":
        if (m.content) push("user", [{ type: "text", text: m.content }]);
        break;
      case "assistant": {
        const blocks: AnthropicBlock[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: toToolInput(tc.arguments) });
        }
        push("assistant", blocks);
        break;
      }
      case "tool":
        push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
        break;
    }
  }

  if (json) systemParts.push(JSON_INSTRUCTION);
  const payload: { system?: string; messages: AnthropicMessage[] } = { messages: out };
  if (systemParts.length) payload.system = systemParts.join("\n\n");
  return payload;
}

export function toAnthropicTools(tools: ToolSpec[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

function mapStopReason(reason: unknown, hasToolCalls: boolean): FinishReason {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return hasToolCalls ? "tool_calls" : "stop";
  return hasToolCalls ? "tool_calls" : "other";
}

function streamErrorCode(type: unknown): RovantaErrorCode {
  if (type === "authentication_error" || type === "permission_error") return "INVALID_API_KEY";
  if (type === "rate_limit_error") return "RATE_LIMITED";
  return "PROVIDER_UNAVAILABLE";
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: AnthropicOptions, fetchImpl?: FetchLike) {
    assertConfigured(options.apiKey, options.model);
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = assertSafeBaseUrl(options.baseUrl?.trim() || ANTHROPIC_DEFAULT_BASE_URL);
    this.fetchImpl = fetchImpl ?? defaultFetch();
  }

  private buildBody(request: GenerateRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicPayload(request.messages, request.json);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages,
    };
    if (system) body.system = system;
    if (request.tools?.length) body.tools = toAnthropicTools(request.tools);
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (stream) body.stream = true;
    return body;
  }

  private post(request: GenerateRequest, stream: boolean): Promise<Response> {
    return postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      this.buildBody(request, stream),
      request.signal,
      [this.apiKey],
    );
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await this.post(request, false);
    const data = await readJson(response, request.signal);
    if (!isRecord(data) || !Array.isArray(data.content)) {
      throw new RovantaError("PROVIDER_UNAVAILABLE", "The model provider returned an unexpected response shape.");
    }
    let text = "";
    const toolCalls: ToolCallRequest[] = [];
    for (const block of data.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      if (block.type === "tool_use" && typeof block.name === "string") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : `call_${toolCalls.length}`,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }
    const result: GenerateResult = {
      text,
      toolCalls,
      finishReason: mapStopReason(data.stop_reason, toolCalls.length > 0),
    };
    if (isRecord(data.usage)) {
      result.usage = {};
      if (typeof data.usage.input_tokens === "number") result.usage.inputTokens = data.usage.input_tokens;
      if (typeof data.usage.output_tokens === "number") result.usage.outputTokens = data.usage.output_tokens;
    }
    return result;
  }

  async toolCall(request: GenerateRequest & { tools: ToolSpec[] }): Promise<GenerateResult> {
    assertTools(request.tools);
    return this.generate(request);
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await this.post(request, true);
    let text = "";
    let stopReason: unknown;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const tools = new Map<number, { id: string; name: string; json: string }>();

    for await (const evt of parseSSE(response.body, request.signal)) {
      let data: unknown;
      try {
        data = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (!isRecord(data)) continue;
      const index = typeof data.index === "number" ? data.index : -1;

      switch (data.type) {
        case "message_start": {
          const usage = isRecord(data.message) ? data.message.usage : undefined;
          if (isRecord(usage) && typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
          break;
        }
        case "content_block_start": {
          const block = data.content_block;
          if (isRecord(block) && block.type === "tool_use") {
            tools.set(index, {
              id: typeof block.id === "string" ? block.id : `call_${index}`,
              name: typeof block.name === "string" ? block.name : "",
              json: "",
            });
          } else if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text) {
            text += block.text;
            yield { type: "text", delta: block.text };
          }
          break;
        }
        case "content_block_delta": {
          const delta = data.delta;
          if (!isRecord(delta)) break;
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
            text += delta.text;
            yield { type: "text", delta: delta.text };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const entry = tools.get(index);
            if (entry) entry.json += delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (isRecord(data.delta) && data.delta.stop_reason != null) stopReason = data.delta.stop_reason;
          if (isRecord(data.usage) && typeof data.usage.output_tokens === "number") {
            outputTokens = data.usage.output_tokens;
          }
          break;
        }
        case "error": {
          const err = isRecord(data.error) ? data.error : {};
          throw providerError(
            streamErrorCode(err.type),
            typeof err.message === "string" ? err.message : undefined,
            [this.apiKey],
          );
        }
      }
    }

    const toolCalls: ToolCallRequest[] = [...tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: parseToolArguments(tc.json) }));
    const result: GenerateResult = {
      text,
      toolCalls,
      finishReason: mapStopReason(stopReason, toolCalls.length > 0),
    };
    if (inputTokens !== undefined || outputTokens !== undefined) {
      result.usage = {};
      if (inputTokens !== undefined) result.usage.inputTokens = inputTokens;
      if (outputTokens !== undefined) result.usage.outputTokens = outputTokens;
    }
    yield { type: "done", result };
  }
}

export const createAnthropicProvider: ProviderFactory = (config: LLMConfig, fetchImpl?: FetchLike) =>
  new AnthropicProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl }, fetchImpl);
