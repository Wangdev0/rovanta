import type { z } from "zod";
import { RovantaError, toRovantaError } from "../errors";
import { SourceRefSchema } from "../data/schemas";
import type { ToolRegistry } from "./registry";
import type { ToolContext, ToolExecutionResult } from "./types";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export interface ExecuteOptions {
  callId: string;
  context: Omit<ToolContext, "signal"> & { signal?: AbortSignal };
  timeoutMs?: number;
}

/**
 * Run a tool call requested by the model. Never throws: every failure
 * becomes a structured error result the model and UI can read.
 *
 * Steps: resolve tool -> validate input -> run with timeout -> validate output.
 */
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  rawInput: unknown,
  options: ExecuteOptions,
): Promise<ToolExecutionResult> {
  const started = Date.now();
  const base = { tool: name, callId: options.callId, input: rawInput };
  const fail = (error: RovantaError): ToolExecutionResult => ({
    ...base,
    ok: false,
    error: error.toJSON(),
    durationMs: Date.now() - started,
  });

  const tool = registry.get(name);
  if (!tool) return fail(new RovantaError("UNKNOWN_TOOL", `Unknown tool "${String(name).slice(0, 64)}"`));

  const parsedInput = (tool.input as z.ZodType).safeParse(rawInput ?? {});
  if (!parsedInput.success) {
    const issues = parsedInput.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return fail(new RovantaError("INVALID_INPUT", `Invalid input for ${name}: ${issues}`));
  }

  const timeoutMs = options.timeoutMs ?? tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.context.signal?.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (options.context.signal?.aborted) throw new RovantaError("ABORTED");
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RovantaError("TOOL_TIMEOUT", `${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const result = await Promise.race([
      tool.run(parsedInput.data, { ...options.context, signal: controller.signal }),
      timeout,
    ]);

    const parsedOutput = tool.output.safeParse(result?.data);
    const parsedSources = SourceRefSchema.array().safeParse(result?.sources ?? []);
    if (!parsedOutput.success || !parsedSources.success) {
      return fail(new RovantaError("MALFORMED_TOOL_RESULT", `${name} returned data that failed validation`));
    }

    return {
      ...base,
      input: parsedInput.data,
      ok: true,
      data: parsedOutput.data,
      sources: parsedSources.data,
      summary: tool.summarize(parsedOutput.data, parsedInput.data),
      durationMs: Date.now() - started,
      fetchedAt: options.context.now().toISOString(),
    };
  } catch (error) {
    if (options.context.signal?.aborted) return fail(new RovantaError("ABORTED"));
    return fail(toRovantaError(error, "DATA_UNAVAILABLE"));
  } finally {
    if (timer) clearTimeout(timer);
    options.context.signal?.removeEventListener("abort", onParentAbort);
  }
}
