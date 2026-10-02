import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRunOptions, AgentRunResult } from "@/core/agent/types";
import type { LLMConfig, LLMProvider } from "@/core/llm/types";
import type { DataServices } from "@/core/data/types";
import type { ToolRegistry } from "@/core/tools";
import { MAX_QUESTION_LENGTH } from "@/core/agent/runtime";
import { reportToMarkdown } from "@/core/report/markdown";
import type { CliIO } from "@/cli/io";
import { fixtureReport } from "../report/fixtures";

const rendererEvents: AgentEvent[] = [];
const rendererState = { finished: 0, options: undefined as unknown };

vi.mock("@/cli/config", () => ({
  resolveLLMConfig: vi.fn(),
  resolveDataEnv: vi.fn(async (env: NodeJS.ProcessEnv) => env),
}));

vi.mock("@/cli/style", () => {
  const id = (s: string) => s;
  return {
    createStyle: (enabled: boolean) => ({
      enabled,
      bold: id,
      dim: id,
      green: id,
      red: id,
      yellow: id,
      cyan: id,
      gray: id,
      accent: id,
    }),
  };
});

vi.mock("@/cli/render/events", () => ({
  createEventRenderer: vi.fn(),
}));

vi.mock("@/cli/render/report", () => ({
  renderReportText: (report: { title: string }, _style: unknown, width?: number) =>
    `TEXT REPORT: ${report.title} (width ${width})`,
}));

const { createResearchCommand } = await import("@/cli/commands/research");
const { createEventRenderer } = await import("@/cli/render/events");
type Deps = import("@/cli/commands/research").ResearchCommandDeps;

const CONFIG: LLMConfig = { provider: "openai-compatible", apiKey: "dev-key", model: "dev-model", baseUrl: "https://example.com/v1" };
const AT = "2026-01-01T00:00:00.000Z";

interface Captured {
  io: CliIO;
  stdout: () => string;
  stderr: () => string;
}

function makeIO(options: { stdin?: string; stdinTTY?: boolean; isTTY?: boolean; cwd?: string; columns?: number } = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (chunk: Buffer) => out.push(chunk.toString()));
  stderr.on("data", (chunk: Buffer) => err.push(chunk.toString()));
  if (options.columns !== undefined) Object.assign(stdout, { columns: options.columns });
  const stdin = Readable.from(options.stdin === undefined ? [] : [options.stdin]);
  Object.assign(stdin, { isTTY: options.stdinTTY ?? options.stdin === undefined });
  return {
    io: {
      stdout,
      stderr,
      stdin,
      env: {},
      cwd: options.cwd ?? process.cwd(),
      isTTY: options.isTTY ?? false,
      color: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function okRun(result: Partial<AgentRunResult> = {}) {
  return vi.fn(async (options: AgentRunOptions): Promise<AgentRunResult> => {
    const report = result.report === undefined ? fixtureReport() : result.report;
    const events: AgentEvent[] = [
      { type: "run_start", runId: "r1", question: options.question, at: AT },
      { type: "status", message: "Working", at: AT },
      ...(result.events ?? []),
    ];
    for (const event of events) options.onEvent?.(event);
    return { status: result.status ?? "complete", report, events };
  });
}

function makeDeps(overrides: Partial<Deps> = {}) {
  const resolveLLMConfig = vi.fn(async () => CONFIG as LLMConfig | null);
  const writes = new Map<string, string>();
  const deps: Partial<Deps> = {
    resolveLLMConfig,
    resolveDataEnv: vi.fn(async (env: NodeJS.ProcessEnv) => ({ ...env, DATA: "1" })),
    createProvider: vi.fn(() => ({ id: "fake" }) as unknown as LLMProvider),
    createRegistry: vi.fn(() => ({}) as unknown as ToolRegistry),
    createDataServices: vi.fn(() => ({}) as unknown as DataServices),
    runResearch: okRun(),
    signalSource: null,
    exit: vi.fn(),
    writeFile: vi.fn(async (path: string, contents: string) => {
      writes.set(path, contents);
    }),
    ...overrides,
  };
  return { deps, resolveLLMConfig, writes };
}

beforeEach(() => {
  rendererEvents.length = 0;
  rendererState.finished = 0;
  rendererState.options = undefined;
  vi.mocked(createEventRenderer).mockImplementation((_io, options) => {
    rendererState.options = options;
    return {
      onEvent: (event: AgentEvent) => rendererEvents.push(event),
      finish: () => {
        rendererState.finished += 1;
      },
    };
  });
});

describe("research command: question input", () => {
  it("joins positional args into the question and renders events", async () => {
    const runResearch = okRun();
    const { deps } = makeDeps({ runResearch });
    const c = makeIO();
    const code = await createResearchCommand(deps)(["what", "is", "ETH?"], c.io);
    expect(code).toBe(0);
    expect(runResearch.mock.calls[0][0].question).toBe("what is ETH?");
    expect(runResearch.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(rendererEvents.map((e) => e.type)).toEqual(["run_start", "status"]);
    expect(rendererState.finished).toBe(1);
  });

  it("reads the question from stdin when no args are given and stdin is piped", async () => {
    const runResearch = okRun();
    const { deps } = makeDeps({ runResearch });
    const c = makeIO({ stdin: "  piped question\n", stdinTTY: false });
    expect(await createResearchCommand(deps)([], c.io)).toBe(0);
    expect(runResearch.mock.calls[0][0].question).toBe("piped question");
  });

  it("reads stdin for a lone '-' argument", async () => {
    const runResearch = okRun();
    const { deps } = makeDeps({ runResearch });
    const c = makeIO({ stdin: "from dash", stdinTTY: false });
    expect(await createResearchCommand(deps)(["-"], c.io)).toBe(0);
    expect(runResearch.mock.calls[0][0].question).toBe("from dash");
  });

  it("caps the question at MAX_QUESTION_LENGTH", async () => {
    const runResearch = okRun();
    const { deps } = makeDeps({ runResearch });
    const c = makeIO();
    await createResearchCommand(deps)(["x".repeat(MAX_QUESTION_LENGTH + 50)], c.io);
    expect(runResearch.mock.calls[0][0].question).toHaveLength(MAX_QUESTION_LENGTH);
  });

  it("exits 2 with usage on an empty question", async () => {
    const runResearch = okRun();
    const { deps } = makeDeps({ runResearch });
    const tty = makeIO({ stdinTTY: true });
    expect(await createResearchCommand(deps)([], tty.io)).toBe(2);
    expect(tty.stderr()).toContain("Usage:");

    const piped = makeIO({ stdin: "   \n", stdinTTY: false });
    expect(await createResearchCommand(deps)([], piped.io)).toBe(2);
    expect(runResearch).not.toHaveBeenCalled();
  });
});

describe("research command: flags", () => {
  it("exits 2 with usage on an unknown flag", async () => {
    const { deps } = makeDeps();
    const c = makeIO();
    expect(await createResearchCommand(deps)(["--bogus", "q"], c.io)).toBe(2);
    expect(c.stderr()).toContain("Usage:");
  });

  it("does not accept an API key flag", async () => {
    const { deps, resolveLLMConfig } = makeDeps();
    for (const flag of ["--api-key", "--apiKey", "--key"]) {
      const c = makeIO();
      expect(await createResearchCommand(deps)([flag, "sk-secret", "q"], c.io)).toBe(2);
      expect(c.stderr()).not.toContain("sk-secret");
    }
    expect(resolveLLMConfig).not.toHaveBeenCalled();
  });

  it("prints help to stdout with exit 0", async () => {
    const { deps } = makeDeps();
    const c = makeIO();
    expect(await createResearchCommand(deps)(["--help"], c.io)).toBe(0);
    expect(c.stdout()).toContain("rovanta research");
    expect(c.stdout()).not.toMatch(/--api-key/);
  });

  it.each([["0"], ["-1"], ["abc"], ["1.5"]])("rejects --max-steps %s", async (value) => {
    const { deps } = makeDeps();
    const c = makeIO();
    expect(await createResearchCommand(deps)([`--max-steps=${value}`, "q"], c.io)).toBe(2);
    expect(c.stderr()).toContain("--max-steps");
  });

  it("rejects an invalid --max-tool-calls and --format", async () => {
    const { deps } = makeDeps();
    expect(await createResearchCommand(deps)(["--max-tool-calls", "zero", "q"], makeIO().io)).toBe(2);
    expect(await createResearchCommand(deps)(["--format", "html", "q"], makeIO().io)).toBe(2);
  });

  it("forwards limits, quiet/verbose and LLM overrides", async () => {
    const runResearch = okRun();
    const { deps, resolveLLMConfig } = makeDeps({ runResearch });
    const c = makeIO();
    c.io.env = { ROVANTA_MODEL: "env-model" };
    const code = await createResearchCommand(deps)(
      [
        "--provider", "anthropic",
        "--model", "m-1",
        "--base-url", "https://llm.example.com",
        "--max-steps", "3",
        "--max-tool-calls", "5",
        "-q",
        "--verbose",
        "q",
      ],
      c.io,
    );
    expect(code).toBe(0);
    expect(resolveLLMConfig).toHaveBeenCalledWith(c.io.env, {
      provider: "anthropic",
      model: "m-1",
      baseUrl: "https://llm.example.com",
    });
    expect(runResearch.mock.calls[0][0]).toMatchObject({ maxSteps: 3, maxToolCalls: 5 });
    expect(rendererState.options).toEqual({ quiet: true, verbose: true });
  });

  it("passes the resolved data env to createDataServices", async () => {
    const { deps } = makeDeps();
    const c = makeIO();
    c.io.env = { COINGECKO_API_KEY: "cg" };
    await createResearchCommand(deps)(["q"], c.io);
    expect(deps.createDataServices).toHaveBeenCalledWith({ COINGECKO_API_KEY: "cg", DATA: "1" });
  });
});

describe("research command: configuration", () => {
  it("exits 1 with a setup hint when no provider is configured", async () => {
    const runResearch = okRun();
    const { deps } = makeDeps({ runResearch, resolveLLMConfig: vi.fn(async () => null) });
    const c = makeIO();
    expect(await createResearchCommand(deps)(["q"], c.io)).toBe(1);
    const err = c.stderr();
    expect(err).toContain("rovanta config init");
    expect(err).toContain("ROVANTA_PROVIDER");
    expect(err).toContain("ROVANTA_MODEL");
    expect(err).toContain("ROVANTA_API_KEY");
    expect(err).toContain("OPENAI_API_KEY");
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("exits 1 when config resolution throws (unknown provider)", async () => {
    const { deps } = makeDeps({
      resolveLLMConfig: vi.fn(async () => {
        throw new Error('Unknown provider "nope"');
      }),
    });
    const c = makeIO();
    expect(await createResearchCommand(deps)(["--provider", "nope", "q"], c.io)).toBe(1);
    expect(c.stderr()).toContain('Unknown provider "nope"');
  });

  it("exits 1 when createProvider throws", async () => {
    const { RovantaError } = await import("@/core/errors");
    const { deps } = makeDeps({
      createProvider: vi.fn(() => {
        throw new RovantaError("UNSUPPORTED_PROVIDER");
      }),
    });
    const c = makeIO();
    expect(await createResearchCommand(deps)(["q"], c.io)).toBe(1);
    expect(c.stderr()).toContain("UNSUPPORTED_PROVIDER");
  });
});

describe("research command: output", () => {
  it("defaults to text in a TTY using the terminal width", async () => {
    const { deps } = makeDeps();
    const c = makeIO({ isTTY: true, columns: 80 });
    expect(await createResearchCommand(deps)(["q"], c.io)).toBe(0);
    expect(c.stdout()).toBe("TEXT REPORT: DEV FIXTURE report (width 80)\n");
  });

  it("falls back to width 100 when columns are unknown", async () => {
    const { deps } = makeDeps();
    const c = makeIO();
    await createResearchCommand(deps)(["-f", "text", "q"], c.io);
    expect(c.stdout()).toContain("(width 100)");
  });

  it("defaults to markdown when not a TTY", async () => {
    const { deps } = makeDeps();
    const c = makeIO({ isTTY: false });
    await createResearchCommand(deps)(["q"], c.io);
    expect(c.stdout().trim()).toBe(reportToMarkdown(fixtureReport()).trim());
    expect(c.stderr()).not.toContain("DEV FIXTURE report");
  });

  it("prints JSON with --format json", async () => {
    const { deps } = makeDeps();
    const c = makeIO({ isTTY: true });
    await createResearchCommand(deps)(["--format", "json", "q"], c.io);
    expect(JSON.parse(c.stdout())).toEqual(fixtureReport());
  });

  it("prints markdown with -f markdown in a TTY", async () => {
    const { deps } = makeDeps();
    const c = makeIO({ isTTY: true });
    await createResearchCommand(deps)(["-f", "markdown", "q"], c.io);
    expect(c.stdout()).toContain("DEV FIXTURE report");
    expect(c.stdout()).not.toContain("TEXT REPORT");
  });
});

describe("research command: --out", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rovanta-research-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const realWrite = (path: string, contents: string) => writeFile(path, contents, "utf8");

  it("writes markdown relative to cwd and reports the path on stderr", async () => {
    const { deps } = makeDeps({ writeFile: realWrite });
    const c = makeIO({ cwd: dir });
    expect(await createResearchCommand(deps)(["-o", "report.md", "q"], c.io)).toBe(0);
    const path = join(dir, "report.md");
    expect(await readFile(path, "utf8")).toContain("DEV FIXTURE report");
    expect(c.stderr()).toContain(`Saved report to ${path}`);
  });

  it("writes JSON for a .json path", async () => {
    const { deps } = makeDeps({ writeFile: realWrite });
    const c = makeIO({ cwd: dir });
    expect(await createResearchCommand(deps)(["--out", "r.json", "-f", "text", "q"], c.io)).toBe(0);
    expect(JSON.parse(await readFile(join(dir, "r.json"), "utf8"))).toEqual(fixtureReport());
  });

  it("exits 1 when the file cannot be written", async () => {
    const { deps } = makeDeps({ writeFile: realWrite });
    const c = makeIO({ cwd: dir });
    expect(await createResearchCommand(deps)(["-o", "missing/dir/r.md", "q"], c.io)).toBe(1);
    expect(c.stderr()).toContain("could not write");
  });
});

describe("research command: failures", () => {
  it("exits 1 and prints the last error event", async () => {
    const runResearch = okRun({
      status: "failed",
      report: null,
      events: [{ type: "error", error: { code: "RATE_LIMITED", message: "Slow down.", retryable: true }, at: AT }],
    });
    const { deps } = makeDeps({ runResearch });
    const c = makeIO();
    expect(await createResearchCommand(deps)(["q"], c.io)).toBe(1);
    expect(c.stderr()).toContain("RATE_LIMITED");
    expect(c.stderr()).toContain("Slow down.");
    expect(c.stdout()).toBe("");
    expect(rendererState.finished).toBe(1);
  });

  it("still prints a partial report on failure", async () => {
    const runResearch = okRun({ status: "failed" });
    const { deps } = makeDeps({ runResearch });
    const c = makeIO();
    expect(await createResearchCommand(deps)(["q"], c.io)).toBe(1);
    expect(c.stdout()).toContain("DEV FIXTURE report");
    expect(c.stderr()).toContain("INTERNAL");
  });

  it("exits 1 when runResearch throws and still finishes the renderer", async () => {
    const runResearch = vi.fn(async () => {
      throw new Error("boom");
    });
    const { deps } = makeDeps({ runResearch });
    const c = makeIO();
    expect(await createResearchCommand(deps)(["q"], c.io)).toBe(1);
    expect(c.stderr()).toContain("INTERNAL");
    expect(rendererState.finished).toBe(1);
  });

  it("exits 130 when the run is aborted", async () => {
    const runResearch = okRun({ status: "aborted", report: null });
    const { deps } = makeDeps({ runResearch });
    const c = makeIO();
    expect(await createResearchCommand(deps)(["q"], c.io)).toBe(130);
    expect(c.stderr()).toContain("cancelled");
  });
});

describe("research command: SIGINT", () => {
  it("aborts on first Ctrl-C, exits 130 on second, and removes the listener", async () => {
    const listeners = new Set<() => void>();
    const signalSource = {
      on: vi.fn((_s: "SIGINT", l: () => void) => listeners.add(l)),
      off: vi.fn((_s: "SIGINT", l: () => void) => listeners.delete(l)),
    };
    const exit = vi.fn();
    const runResearch = vi.fn(
      (options: AgentRunOptions) =>
        new Promise<AgentRunResult>((resolveRun) => {
          options.signal?.addEventListener("abort", () => {
            for (const l of listeners) l();
            resolveRun({ status: "aborted", report: null, events: [] });
          });
          for (const l of listeners) l();
        }),
    );
    const { deps } = makeDeps({ runResearch, signalSource, exit });
    const c = makeIO();
    const code = await createResearchCommand(deps)(["q"], c.io);
    expect(code).toBe(130);
    expect(c.stderr()).toContain("Cancelling…");
    expect(exit).toHaveBeenCalledWith(130);
    expect(signalSource.on).toHaveBeenCalledTimes(1);
    expect(signalSource.off).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
