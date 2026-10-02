import { RovantaError } from "@/core/errors";
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

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant": {
        if (!m.toolCalls?.length) return { role: "assistant", content: m.content };
        return {
          role: "assistant",
          content: m.content === "" ? null : m.content,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
            },
          })),
        };
      }
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

export function toOpenAITools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function mapFinishReason(reason: unknown, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls && (reason === "stop" || reason === "tool_calls" || reason === "function_call" || reason == null)) {
    return "tool_calls";
  }
  if (reason === "stop") return "stop";
  if (reason === "tool_calls" || reason === "function_call") return "tool_calls";
  if (reason === "length") return "length";
  return "other";
}

function mapUsage(usage: unknown): GenerateResult["usage"] {
  if (!isRecord(usage)) return undefined;
  const out: NonNullable<GenerateResult["usage"]> = {};
  if (typeof usage.prompt_tokens === "number") out.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") out.outputTokens = usage.completion_tokens;
  return out;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = "openai-compatible" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenAICompatibleOptions, fetchImpl?: FetchLike) {
    assertConfigured(options.apiKey, options.model);
    if (!options.baseUrl?.trim()) {
      throw new RovantaError("PROVIDER_NOT_CONFIGURED", "A base URL is required for OpenAI-compatible providers.");
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.baseUrl = assertSafeBaseUrl(options.baseUrl);
    this.fetchImpl = fetchImpl ?? defaultFetch();
  }

  private buildBody(request: GenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(request.messages),
    };
    if (request.tools?.length) body.tools = toOpenAITools(request.tools);
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.json) body.response_format = { type: "json_object" };
    if (stream) body.stream = true;
    return body;
  }

  private post(request: GenerateRequest, stream: boolean): Promise<Response> {
    return postJson(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      this.buildBody(request, stream),
      request.signal,
      [this.apiKey],
    );
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await this.post(request, false);
    const data = await readJson(response, request.signal);
    return this.parseResponse(data);
  }

  async toolCall(request: GenerateRequest & { tools: ToolSpec[] }): Promise<GenerateResult> {
    assertTools(request.tools);
    return this.generate(request);
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await this.post(request, true);
    let text = "";
    let finishReason: unknown;
    let usage: GenerateResult["usage"];
    const partial = new Map<number, { id: string; name: string; args: string }>();

    for await (const evt of parseSSE(response.body, request.signal)) {
      let data: unknown;
      try {
        data = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (!isRecord(data)) continue;
      if (data.error !== undefined) {
        const detail = isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : undefined;
        throw providerError("PROVIDER_UNAVAILABLE", detail, [this.apiKey]);
      }
      if (data.usage) usage = mapUsage(data.usage);
      const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
      if (!isRecord(choice)) continue;
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!isRecord(delta)) continue;

      const textDelta = contentToText(delta.content);
      if (textDelta) {
        text += textDelta;
        yield { type: "text", delta: textDelta };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!isRecord(tc)) continue;
          const index = typeof tc.index === "number" ? tc.index : partial.size;
          const entry = partial.get(index) ?? { id: "", name: "", args: "" };
          if (typeof tc.id === "string" && tc.id) entry.id = tc.id;
          const fn = tc.function;
          if (isRecord(fn)) {
            if (typeof fn.name === "string") entry.name += fn.name;
            if (typeof fn.arguments === "string") entry.args += fn.arguments;
          }
          partial.set(index, entry);
        }
      }
    }

    const toolCalls: ToolCallRequest[] = [...partial.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => ({
        id: tc.id || `call_${index}`,
        name: tc.name,
        arguments: parseToolArguments(tc.args),
      }));
    const result: GenerateResult = {
      text,
      toolCalls,
      finishReason: mapFinishReason(finishReason, toolCalls.length > 0),
    };
    if (usage) result.usage = usage;
    yield { type: "done", result };
  }

  private parseResponse(data: unknown): GenerateResult {
    const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!isRecord(choice) || !isRecord(choice.message)) {
      throw new RovantaError("PROVIDER_UNAVAILABLE", "The model provider returned an unexpected response shape.");
    }
    const message = choice.message;
    const toolCalls: ToolCallRequest[] = [];
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((tc, index) => {
        if (!isRecord(tc) || !isRecord(tc.function) || typeof tc.function.name !== "string") return;
        toolCalls.push({
          id: typeof tc.id === "string" && tc.id ? tc.id : `call_${index}`,
          name: tc.function.name,
          arguments: parseToolArguments(tc.function.arguments),
        });
      });
    }
    const result: GenerateResult = {
      text: contentToText(message.content),
      toolCalls,
      finishReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    };
    const usage = mapUsage(isRecord(data) ? data.usage : undefined);
    if (usage) result.usage = usage;
    return result;
  }
}

export const createOpenAICompatibleProvider: ProviderFactory = (config: LLMConfig, fetchImpl?: FetchLike) =>
  new OpenAICompatibleProvider(
    { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl ?? OPENAI_DEFAULT_BASE_URL },
    fetchImpl,
  );
