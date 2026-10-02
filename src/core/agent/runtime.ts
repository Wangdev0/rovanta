import { RovantaError, isRovantaError, toRovantaError } from "../errors";
import type { RovantaErrorJSON } from "../errors";
import type { ChatMessage, ToolCallRequest } from "../llm/types";
import type { EvidenceItem, ReportDraft, ResearchReport } from "../report/schema";
import { buildFallbackReportDraft, enforceEvidence, parseReportDraft } from "../report/validate";
import { redactSecrets } from "../security/redact";
import { sanitizeDeep, sanitizeToolText, wrapToolData } from "../security/sanitize";
import { REPORT_TOOL_NAME } from "../tools/chain-protocol";
import { executeTool } from "../tools/executor";
import { REPORT_SYSTEM_PROMPT, activityLabelFor, buildReportPrompt, buildSystemPrompt } from "./prompt";
import type { AgentEvent, AgentRunOptions, AgentRunResult } from "./types";

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_TOOL_CALLS = 16;
export const MAX_QUESTION_LENGTH = 4000;
export const MAX_PLAN_STEPS = 5;
export const MAX_PLAN_STEP_LENGTH = 140;

export const STATUS_MESSAGES = {
  understanding: "Understanding the request",
  stepBudget: "Step budget reached; compiling report from collected evidence",
  toolBudget: "Tool budget reached; compiling report from collected evidence",
  building: "Building research report",
  reportFallback: "Model unavailable during report step; compiling report from collected evidence",
} as const;

const RETRY_JSON_MESSAGE = "Your previous output was not valid JSON matching the schema. Return only the JSON object.";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventInput = DistributiveOmit<AgentEvent, "at">;

function createRunId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function limit(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

export function extractPlan(text: string): string[] {
  const steps: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?PLAN:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const step = redactSecrets(sanitizeToolText(match[1], 1000).text).slice(0, MAX_PLAN_STEP_LENGTH).trim();
    if (step) steps.push(step);
    if (steps.length >= MAX_PLAN_STEPS) break;
  }
  return steps;
}

function safeError(error: RovantaErrorJSON): RovantaErrorJSON {
  return { ...error, message: redactSecrets(error.message).slice(0, 500) };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RovantaError("ABORTED");
}

export async function runResearch(options: AgentRunOptions): Promise<AgentRunResult> {
  const { provider, registry, data, signal } = options;
  const now = options.now ?? (() => new Date());
  const maxSteps = limit(options.maxSteps, DEFAULT_MAX_STEPS, 1);
  const maxToolCalls = limit(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, 0);
  const runId = createRunId();
  const events: AgentEvent[] = [];
  let report: ResearchReport | null = null;

  const emit = (input: EventInput): void => {
    const event = { ...input, at: now().toISOString() } as AgentEvent;
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      // A failing listener must not break the run.
    }
  };

  const finish = (status: AgentRunResult["status"]): AgentRunResult => {
    emit({ type: "run_end", status });
    return { status, report, events };
  };

  const question = typeof options.question === "string" ? options.question.trim() : "";
  emit({ type: "run_start", runId, question: question.slice(0, MAX_QUESTION_LENGTH) });

  if (!question || question.length > MAX_QUESTION_LENGTH) {
    const message = question
      ? `The question must be at most ${MAX_QUESTION_LENGTH} characters.`
      : "The question must not be empty.";
    emit({ type: "error", error: new RovantaError("INVALID_INPUT", message).toJSON() });
    return finish("failed");
  }

  try {
    throwIfAborted(signal);
    emit({ type: "status", message: STATUS_MESSAGES.understanding });

    const tools = registry.toSpecs();
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ tools, now: now() }) },
      { role: "user", content: `<user_request>\n${question}\n</user_request>` },
    ];
    const evidence: EvidenceItem[] = [];
    const toolDataBlocks: string[] = [];
    let planEmitted = false;
    let toolCallsUsed = 0;
    let callCounter = 0;
    let reportRequested = false;
    let budgetExhausted = false;
    let modelFinished = false;

    const skip = (call: ToolCallRequest, message: string) => {
      const content = wrapToolData({
        ok: false,
        tool: String(call.name ?? ""),
        callId: call.id,
        input: call.arguments,
        error: new RovantaError("INVALID_INPUT", message).toJSON(),
        durationMs: 0,
      });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    };

    for (let step = 0; step < maxSteps; step++) {
      throwIfAborted(signal);
      const result = await provider.toolCall({ messages, tools, signal });
      throwIfAborted(signal);

      if (!planEmitted) {
        const plan = extractPlan(result.text);
        if (plan.length > 0) {
          planEmitted = true;
          emit({ type: "plan", steps: plan });
        }
      }

      const calls = (result.toolCalls ?? []).map((call) => ({
        ...call,
        id: call.id || `call_${++callCounter}`,
      }));
      messages.push({ role: "assistant", content: result.text ?? "", ...(calls.length > 0 ? { toolCalls: calls } : {}) });

      if (calls.length === 0) {
        modelFinished = true;
        break;
      }

      for (const call of calls) {
        if (reportRequested) {
          skip(call, "Skipped: the research report was already requested.");
          continue;
        }
        if (call.name === REPORT_TOOL_NAME) {
          reportRequested = true;
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: `<tool_data tool="${REPORT_TOOL_NAME}" untrusted="true">\n{"ready":true}\n</tool_data>`,
          });
          continue;
        }
        if (budgetExhausted || toolCallsUsed >= maxToolCalls) {
          budgetExhausted = true;
          skip(call, "Tool budget exhausted");
          continue;
        }

        toolCallsUsed++;
        const toolName = sanitizeToolText(String(call.name ?? ""), 64).text;
        emit({
          type: "tool_start",
          callId: call.id,
          tool: toolName,
          label: activityLabelFor(call.name, registry.get(call.name)?.activityLabel),
          input: sanitizeDeep(call.arguments ?? {}, { maxDepth: 4, maxArrayItems: 20, maxStringLength: 500 }).value,
        });

        const executed = await executeTool(registry, call.name, call.arguments, {
          callId: call.id,
          context: { data, signal, now },
        });
        throwIfAborted(signal);

        let evidenceId: string | undefined;
        if (executed.ok) {
          evidenceId = `E${evidence.length + 1}`;
          evidence.push({
            id: evidenceId,
            tool: executed.tool,
            input: executed.input,
            summary: executed.summary,
            sources: executed.sources,
            fetchedAt: executed.fetchedAt,
          });
          emit({
            type: "tool_result",
            callId: call.id,
            tool: toolName,
            evidenceId,
            summary: redactSecrets(sanitizeToolText(executed.summary, 300).text),
            durationMs: executed.durationMs,
          });
        } else {
          emit({
            type: "tool_error",
            callId: call.id,
            tool: toolName,
            error: safeError(executed.error),
            durationMs: executed.durationMs,
          });
        }

        const content = wrapToolData(executed, evidenceId);
        toolDataBlocks.push(content);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      }

      if (reportRequested || budgetExhausted) break;
    }

    if (budgetExhausted && !reportRequested) {
      emit({ type: "status", message: STATUS_MESSAGES.toolBudget });
    } else if (!reportRequested && !modelFinished) {
      emit({ type: "status", message: STATUS_MESSAGES.stepBudget });
    }

    throwIfAborted(signal);
    emit({ type: "status", message: STATUS_MESSAGES.building });

    const reportMessages: ChatMessage[] = [
      { role: "system", content: REPORT_SYSTEM_PROMPT },
      { role: "user", content: buildReportPrompt({ question, evidence, toolDataBlocks }) },
    ];
    let draft: ReportDraft | null = null;
    try {
      const first = await provider.generate({ messages: reportMessages, json: true, signal });
      throwIfAborted(signal);
      draft = parseReportDraft(first.text ?? "");
      if (!draft) {
        const retry = await provider.generate({
          messages: [
            ...reportMessages,
            { role: "assistant", content: (first.text ?? "").slice(0, 8000) },
            { role: "user", content: RETRY_JSON_MESSAGE },
          ],
          json: true,
          signal,
        });
        throwIfAborted(signal);
        draft = parseReportDraft(retry.text ?? "");
      }
    } catch (error) {
      const alpha = toRovantaError(error);
      if (signal?.aborted || alpha.code === "ABORTED" || evidence.length === 0) throw error;
      emit({ type: "status", message: STATUS_MESSAGES.reportFallback });
    }
    const fallback = !draft;
    const checked = enforceEvidence(draft ?? buildFallbackReportDraft(question, evidence), evidence);

    report = {
      ...checked,
      id: runId,
      question,
      generatedAt: now().toISOString(),
      model: { provider: provider.id, model: provider.model },
      dataSources: [...new Set(evidence.flatMap((item) => item.sources.map((source) => source.name)))],
      evidence,
      fallback,
    };
    emit({ type: "report", report });
    return finish("complete");
  } catch (error) {
    const alpha = toRovantaError(error);
    if (signal?.aborted || alpha.code === "ABORTED") return finish("aborted");
    const safe = isRovantaError(error) ? alpha : new RovantaError("INTERNAL");
    emit({ type: "error", error: safeError(safe.toJSON()) });
    return finish("failed");
  }
}
