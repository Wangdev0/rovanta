import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_TOOL_CALLS, MAX_QUESTION_LENGTH, runResearch } from "@/core/agent/runtime";
import type { AgentEvent, AgentRunOptions, AgentRunResult } from "@/core/agent/types";
import { createServerDataServices } from "@/core/data/server";
import type { DataServices } from "@/core/data/types";
import { ERROR_MESSAGES, toRovantaError, type RovantaErrorJSON } from "@/core/errors";
import { createProvider } from "@/core/llm/registry";
import type { LLMConfig, LLMProvider } from "@/core/llm/types";
import { reportToMarkdown } from "@/core/report/markdown";
import type { ResearchReport } from "@/core/report/schema";
import { createDefaultRegistry, type ToolRegistry } from "@/core/tools";
import { resolveDataEnv, resolveLLMConfig, type LLMOverrides } from "../config";
import { writeLine, type CliIO, type CommandHandler } from "../io";
import { createEventRenderer, type EventRenderer } from "../render/events";
import { renderReportText } from "../render/report";
import { createStyle } from "../style";

export type OutputFormat = "text" | "markdown" | "json";

const FORMATS: readonly OutputFormat[] = ["text", "markdown", "json"];
const DEFAULT_WIDTH = 100;
export const EXIT_ABORTED = 130;

export interface SignalSource {
  on(signal: "SIGINT", listener: () => void): unknown;
  off(signal: "SIGINT", listener: () => void): unknown;
}

export interface ResearchCommandDeps {
  resolveLLMConfig: (env: NodeJS.ProcessEnv, overrides?: LLMOverrides) => Promise<LLMConfig | null>;
  resolveDataEnv: (env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>;
  createProvider: (config: LLMConfig) => LLMProvider;
  createRegistry: () => ToolRegistry;
  createDataServices: (env: NodeJS.ProcessEnv) => DataServices;
  runResearch: (options: AgentRunOptions) => Promise<AgentRunResult>;
  createEventRenderer: (io: CliIO, options?: { quiet?: boolean; verbose?: boolean }) => EventRenderer;
  writeFile: (path: string, contents: string) => Promise<void>;
  /** Source of SIGINT notifications; pass null to skip signal handling. */
  signalSource: SignalSource | null;
  exit: (code: number) => void;
}

export const USAGE = [
  "Usage:",
  "  rovanta research [options] <question...>",
  '  rovanta "<question>"',
  '  echo "<question>" | rovanta research',
  "",
  "Options:",
  "      --provider <id>        LLM provider (overrides config)",
  "      --model <id>           Model id (overrides config)",
  "      --base-url <url>       Provider base URL (overrides config)",
  "  -f, --format <fmt>         Output format: text, markdown or json",
  "                             (default: text in a terminal, markdown when piped)",
  "  -o, --out <file>           Also save the report (.json saves JSON, otherwise markdown)",
  `      --max-steps <n>        Max model turns (default: ${DEFAULT_MAX_STEPS})`,
  `      --max-tool-calls <n>   Max tool calls (default: ${DEFAULT_MAX_TOOL_CALLS})`,
  "  -q, --quiet                Hide progress output",
  "      --verbose              Show detailed progress output",
  "  -h, --help                 Show this help",
  "",
  "API keys are read from your config or environment, never from flags.",
].join("\n");

const NOT_CONFIGURED_HINT = [
  "No LLM provider is configured.",
  "",
  "Run `rovanta config init` to set one up, or set environment variables:",
  "  ROVANTA_PROVIDER   openai-compatible | anthropic | google",
  "  ROVANTA_MODEL      model id",
  "  ROVANTA_API_KEY    API key (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY)",
].join("\n");

const OPTIONS = {
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  format: { type: "string", short: "f" },
  out: { type: "string", short: "o" },
  "max-steps": { type: "string" },
  "max-tool-calls": { type: "string" },
  quiet: { type: "boolean", short: "q" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

class UsageError extends Error {}

function parseResearchArgs(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
}

function parsePositiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive integer (got "${value}")`);
  }
  return parsed;
}

function parseFormat(value: string | undefined, isTTY: boolean): OutputFormat {
  if (value === undefined) return isTTY ? "text" : "markdown";
  const format = value.trim().toLowerCase() as OutputFormat;
  if (!FORMATS.includes(format)) {
    throw new UsageError(`--format must be one of: ${FORMATS.join(", ")} (got "${value}")`);
  }
  return format;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return chunks.join("");
}

function formatReport(report: ResearchReport, format: OutputFormat, io: CliIO): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  if (format === "markdown") return reportToMarkdown(report);
  const columns = (io.stdout as { columns?: number }).columns;
  const width = typeof columns === "number" && columns > 0 ? columns : DEFAULT_WIDTH;
  return renderReportText(report, createStyle(io.color), width);
}

function writeBlock(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function lastErrorEvent(events: AgentEvent[]): RovantaErrorJSON | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === "error") return event.error;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createResearchCommand(overrides: Partial<ResearchCommandDeps> = {}): CommandHandler {
  const deps: ResearchCommandDeps = {
    resolveLLMConfig,
    resolveDataEnv,
    createProvider: (config) => createProvider(config),
    createRegistry: () => createDefaultRegistry(),
    createDataServices: (env) => createServerDataServices(env),
    runResearch,
    createEventRenderer,
    writeFile: (path, contents) => writeFile(path, contents, "utf8"),
    signalSource: process,
    exit: (code) => process.exit(code),
    ...overrides,
  };

  return async (args, io) => {
    const style = createStyle(io.color);
    const usageError = (message: string): number => {
      writeLine(io.stderr, `${style.red("Error:")} ${message}\n\n${USAGE}`);
      return 2;
    };

    let parsed: ReturnType<typeof parseResearchArgs>;
    try {
      parsed = parseResearchArgs(args);
    } catch (error) {
      return usageError(messageOf(error));
    }
    const { values, positionals } = parsed;

    if (values.help) {
      writeLine(io.stdout, USAGE);
      return 0;
    }

    let format: OutputFormat;
    let maxSteps: number | undefined;
    let maxToolCalls: number | undefined;
    try {
      format = parseFormat(values.format, io.isTTY);
      maxSteps = parsePositiveInt("max-steps", values["max-steps"]);
      maxToolCalls = parsePositiveInt("max-tool-calls", values["max-tool-calls"]);
      if (values.out !== undefined && values.out.trim() === "") throw new UsageError("--out requires a file path");
    } catch (error) {
      if (error instanceof UsageError) return usageError(error.message);
      throw error;
    }

    let question = positionals.join(" ");
    const stdinIsTTY = Boolean((io.stdin as { isTTY?: boolean }).isTTY);
    if ((positionals.length === 0 || question.trim() === "-") && !stdinIsTTY) {
      question = await readStream(io.stdin);
    } else if (question.trim() === "-") {
      question = "";
    }
    question = question.trim().slice(0, MAX_QUESTION_LENGTH).trim();
    if (!question) return usageError("A research question is required.");

    const llmOverrides: LLMOverrides = {};
    if (values.provider !== undefined) llmOverrides.provider = values.provider;
    if (values.model !== undefined) llmOverrides.model = values.model;
    if (values["base-url"] !== undefined) llmOverrides.baseUrl = values["base-url"];

    let config: LLMConfig | null;
    try {
      config = await deps.resolveLLMConfig(io.env, llmOverrides);
    } catch (error) {
      writeLine(io.stderr, `${style.red("Error:")} ${messageOf(error)}`);
      return 1;
    }
    if (!config) {
      writeLine(io.stderr, NOT_CONFIGURED_HINT);
      return 1;
    }

    let provider: LLMProvider;
    let registry: ToolRegistry;
    let data: DataServices;
    try {
      provider = deps.createProvider(config);
      registry = deps.createRegistry();
      data = deps.createDataServices(await deps.resolveDataEnv(io.env));
    } catch (error) {
      const failure = toRovantaError(error, "PROVIDER_NOT_CONFIGURED");
      writeLine(io.stderr, `${style.red(`Error [${failure.code}]:`)} ${failure.message}`);
      return 1;
    }

    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = (): void => {
      interrupts += 1;
      if (interrupts === 1) {
        writeLine(io.stderr, style.yellow("Cancelling… (press Ctrl-C again to exit immediately)"));
        controller.abort();
        return;
      }
      deps.exit(EXIT_ABORTED);
    };

    const renderer = deps.createEventRenderer(io, { quiet: values.quiet, verbose: values.verbose });
    deps.signalSource?.on("SIGINT", onSigint);

    let result: AgentRunResult | null = null;
    let thrown: RovantaErrorJSON | null = null;
    try {
      result = await deps.runResearch({
        question,
        provider,
        registry,
        data,
        signal: controller.signal,
        maxSteps,
        maxToolCalls,
        onEvent: (event) => renderer.onEvent(event),
      });
    } catch (error) {
      thrown = toRovantaError(error).toJSON();
    } finally {
      deps.signalSource?.off("SIGINT", onSigint);
      renderer.finish();
    }

    const aborted = result?.status === "aborted" || thrown?.code === "ABORTED" || (thrown !== null && controller.signal.aborted);
    const report = result?.report ?? null;

    if (report) writeBlock(io.stdout, formatReport(report, format, io));

    let exitCode = 0;
    if (aborted) {
      writeLine(io.stderr, style.yellow(ERROR_MESSAGES.ABORTED));
      exitCode = EXIT_ABORTED;
    } else if (thrown || result?.status !== "complete" || !report) {
      const failure = thrown ??
        lastErrorEvent(result?.events ?? []) ?? { code: "INTERNAL", message: ERROR_MESSAGES.INTERNAL };
      writeLine(io.stderr, `${style.red(`Error [${failure.code}]:`)} ${failure.message}`);
      exitCode = 1;
    }

    if (report && values.out !== undefined) {
      const path = resolve(io.cwd, values.out);
      const contents = extname(path).toLowerCase() === ".json" ? JSON.stringify(report, null, 2) : reportToMarkdown(report);
      try {
        await deps.writeFile(path, contents.endsWith("\n") ? contents : `${contents}\n`);
        writeLine(io.stderr, `Saved report to ${path}`);
      } catch (error) {
        writeLine(io.stderr, `${style.red("Error:")} could not write ${path}: ${messageOf(error)}`);
        if (exitCode === 0) exitCode = 1;
      }
    }

    return exitCode;
  };
}

export const runResearchCommand: CommandHandler = createResearchCommand();
