import type { z } from "zod";
import type { RovantaErrorJSON } from "../errors";
import type { DataServices } from "../data/types";
import type { SourceRef } from "../data/schemas";

export type ToolCategory = "market" | "liquidity" | "protocol" | "onchain" | "analysis";

export interface ToolContext {
  data: DataServices;
  signal: AbortSignal;
  now: () => Date;
}

export interface ToolRunResult<O> {
  data: O;
  sources: SourceRef[];
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  category: ToolCategory;
  /** Short present-tense label for the activity log, e.g. "Checking liquidity data". */
  activityLabel: string;
  input: I;
  output: O;
  timeoutMs?: number;
  run(input: z.output<I>, ctx: ToolContext): Promise<ToolRunResult<z.input<O>>>;
  /** One-line human summary of a successful result, shown in the activity log and evidence list. */
  summarize(output: z.output<O>, input: z.output<I>): string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export type ToolExecutionResult =
  | {
      ok: true;
      tool: string;
      callId: string;
      input: unknown;
      data: unknown;
      sources: SourceRef[];
      summary: string;
      durationMs: number;
      fetchedAt: string;
    }
  | {
      ok: false;
      tool: string;
      callId: string;
      input: unknown;
      error: RovantaErrorJSON;
      durationMs: number;
    };
