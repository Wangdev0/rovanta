import type { RovantaErrorJSON } from "../errors";
import type { LLMProvider } from "../llm/types";
import type { DataServices } from "../data/types";
import type { ResearchReport } from "../report/schema";
import type { ToolRegistry } from "../tools/registry";

export type AgentEvent =
  | { type: "run_start"; runId: string; question: string; at: string }
  | { type: "status"; message: string; at: string }
  | { type: "plan"; steps: string[]; at: string }
  | { type: "tool_start"; callId: string; tool: string; label: string; input: unknown; at: string }
  | {
      type: "tool_result";
      callId: string;
      tool: string;
      evidenceId: string;
      summary: string;
      durationMs: number;
      at: string;
    }
  | { type: "tool_error"; callId: string; tool: string; error: RovantaErrorJSON; durationMs: number; at: string }
  | { type: "report"; report: ResearchReport; at: string }
  | { type: "error"; error: RovantaErrorJSON; at: string }
  | { type: "run_end"; status: "complete" | "failed" | "aborted"; at: string };

export interface AgentRunOptions {
  question: string;
  provider: LLMProvider;
  registry: ToolRegistry;
  data: DataServices;
  signal?: AbortSignal;
  /** Max model turns in the tool-calling phase. */
  maxSteps?: number;
  /** Max tool calls across the run. */
  maxToolCalls?: number;
  now?: () => Date;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  status: "complete" | "failed" | "aborted";
  report: ResearchReport | null;
  events: AgentEvent[];
}
