import { RovantaError } from "@/core/errors";
import {
  assertConfigured,
  assertSafeBaseUrl,
  assertTools,
  defaultFetch,
  isRecord,
  parseSSE,
  postJson,
  providerError,
  randomSuffix,
  readJson,
} from "./http";
import type {
  ChatMessage,
  FetchLike,
  FinishReason,
  GenerateRequest,
  GenerateResult,
  JSONSchema,
  LLMConfig,
  LLMProvider,
  ProviderFactory,
  StreamChunk,
  ToolCallRequest,
  ToolSpec,
} from "./types";

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GoogleOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: unknown } } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

const GEMINI_FORMATS = new Set(["enum", "date-time"]);

/**
 * Reduce a JSON Schema to the OpenAPI subset accepted by Gemini function declarations.
 * Unsupported keywords are dropped; `type: [X, "null"]` becomes `type: X, nullable: true`.
 */
export function cleanSchemaForGemini(schema: unknown): JSONSchema {
  if (!isRecord(schema)) return {};
  const out: JSONSchema = {};

  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t): t is string => typeof t === "string");
    const nonNull = types.filter((t) => t !== "null");
    if (nonNull[0]) out.type = nonNull[0];
    if (types.includes("null")) out.nullable = true;
  } else if (typeof schema.type === "string") {
    out.type = schema.type;
  }

  if (typeof schema.description === "string") out.description = schema.description;
  if (typeof schema.nullable === "boolean") out.nullable = schema.nullable;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.filter((v) => v !== null);
  if (typeof schema.minimum === "number") out.minimum = schema.minimum;
  if (typeof schema.maximum === "number") out.maximum = schema.maximum;
  if (typeof schema.format === "string" && GEMINI_FORMATS.has(schema.format)) out.format = schema.format;

  if (isRecord(schema.properties)) {
    const props: Record<string, JSONSchema> = {};
    for (const [key, value] of Object.entries(schema.properties)) props[key] = cleanSchemaForGemini(value);
    out.properties = props;
    if (Array.isArray(schema.required)) {
      const required = schema.required.filter((r): r is string => typeof r === "string" && r in props);
      if (required.length) out.required = required;
    }
  }

  if (schema.items !== undefined && !Array.isArray(schema.items)) out.items = cleanSchemaForGemini(schema.items);

  return out;
}

function parseMaybeJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function toFunctionArgs(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args;
  const parsed = typeof args === "string" ? parseMaybeJson(args) : undefined;
  return isRecord(parsed) ? parsed : {};
}

export function toGeminiPayload(messages: ChatMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];
  const push = (role: GeminiContent["role"], parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const m of messages) {
    switch (m.role) {
      case "system":
        if (m.content.trim()) systemParts.push(m.content);
        break;
      case "user":
        if (m.content) push("user", [{ text: m.content }]);
        break;
      case "assistant": {
        const parts: GeminiPart[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: tc.name, args: toFunctionArgs(tc.arguments) } });
        }
        push("model", parts);
        break;
      }
      case "tool":
        push("user", [{ functionResponse: { name: m.name, response: { content: parseMaybeJson(m.content) } } }]);
        break;
    }
  }

  const payload: { systemInstruction?: { parts: Array<{ text: string }> }; contents: GeminiContent[] } = {
    contents,
  };
  if (systemParts.length) payload.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  return payload;
}

export function toGeminiTools(tools: ToolSpec[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: cleanSchemaForGemini(t.parameters),
      })),
    },
  ];
}

function mapFinishReason(reason: unknown, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls && (reason === "STOP" || reason == null)) return "tool_calls";
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return "other";
}

function newToolCallId(index: number): string {
  return `call_${index}_${randomSuffix()}`;
}

interface CandidateParse {
  text: string;
  calls: Array<{ name: string; args: unknown }>;
  finishReason: unknown;
}

function parseCandidate(data: unknown): CandidateParse {
  const out: CandidateParse = { text: "", calls: [], finishReason: undefined };
  if (!isRecord(data) || !Array.isArray(data.candidates)) return out;
  const candidate = data.candidates[0];
  if (!isRecord(candidate)) return out;
  out.finishReason = candidate.finishReason;
  const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string" && part.thought !== true) out.text += part.text;
    if (isRecord(part.functionCall) && typeof part.functionCall.name === "string") {
      out.calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
    }
  }
  return out;
}

function parseUsage(data: unknown): GenerateResult["usage"] {
  if (!isRecord(data) || !isRecord(data.usageMetadata)) return undefined;
  const meta = data.usageMetadata;
  const usage: NonNullable<GenerateResult["usage"]> = {};
  if (typeof meta.promptTokenCount === "number") usage.inputTokens = meta.promptTokenCount;
  if (typeof meta.candidatesTokenCount === "number") usage.outputTokens = meta.candidatesTokenCount;
  return usage;
}

export class GoogleProvider implements LLMProvider {
  readonly id = "google" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GoogleOptions, fetchImpl?: FetchLike) {
    assertConfigured(options.apiKey, options.model);
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim().replace(/^models\//, "");
    this.baseUrl = assertSafeBaseUrl(options.baseUrl?.trim() || GOOGLE_DEFAULT_BASE_URL);
    this.fetchImpl = fetchImpl ?? defaultFetch();
  }

  private buildBody(request: GenerateRequest): Record<string, unknown> {
    const { systemInstruction, contents } = toGeminiPayload(request.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    const hasTools = Boolean(request.tools?.length);
    if (hasTools) body.tools = toGeminiTools(request.tools ?? []);
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.json && !hasTools) generationConfig.responseMimeType = "application/json";
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return body;
  }

  private post(request: GenerateRequest, stream: boolean): Promise<Response> {
    const model = encodeURIComponent(this.model);
    const url = stream
      ? `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`
      : `${this.baseUrl}/models/${model}:generateContent`;
    return postJson(
      this.fetchImpl,
      url,
      { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      this.buildBody(request),
      request.signal,
      [this.apiKey],
    );
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = await this.post(request, false);
    const data = await readJson(response, request.signal);
    if (!isRecord(data)) {
      throw new RovantaError("PROVIDER_UNAVAILABLE", "The model provider returned an unexpected response shape.");
    }
    const parsed = parseCandidate(data);
    const toolCalls: ToolCallRequest[] = parsed.calls.map((c, i) => ({
      id: newToolCallId(i),
      name: c.name,
      arguments: c.args,
    }));
    const result: GenerateResult = {
      text: parsed.text,
      toolCalls,
      finishReason: mapFinishReason(parsed.finishReason, toolCalls.length > 0),
    };
    const usage = parseUsage(data);
    if (usage) result.usage = usage;
    return result;
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
    const toolCalls: ToolCallRequest[] = [];

    for await (const evt of parseSSE(response.body, request.signal)) {
      let data: unknown;
      try {
        data = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (!isRecord(data)) continue;
      if (isRecord(data.error)) {
        const detail = typeof data.error.message === "string" ? data.error.message : undefined;
        throw providerError("PROVIDER_UNAVAILABLE", detail, [this.apiKey]);
      }
      const parsed = parseCandidate(data);
      if (parsed.finishReason != null) finishReason = parsed.finishReason;
      if (parsed.text) {
        text += parsed.text;
        yield { type: "text", delta: parsed.text };
      }
      for (const call of parsed.calls) {
        toolCalls.push({ id: newToolCallId(toolCalls.length), name: call.name, arguments: call.args });
      }
      usage = parseUsage(data) ?? usage;
    }

    const result: GenerateResult = {
      text,
      toolCalls,
      finishReason: mapFinishReason(finishReason, toolCalls.length > 0),
    };
    if (usage) result.usage = usage;
    yield { type: "done", result };
  }
}

export const createGoogleProvider: ProviderFactory = (config: LLMConfig, fetchImpl?: FetchLike) =>
  new GoogleProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl }, fetchImpl);
