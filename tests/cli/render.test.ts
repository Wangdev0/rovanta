/* eslint-disable no-control-regex -- tests assert on terminal control sequences */
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/core/agent/types";
import type { CliIO } from "@/cli/io";
import { createEventRenderer, formatDuration } from "@/cli/render/events";
import { renderReportText, wrapText } from "@/cli/render/report";
import { renderKeyValue, renderTable } from "@/cli/render/table";
import { createStyle, sanitizeTerminalText, stripAnsi } from "@/cli/style";
import { fixtureReport } from "../report/fixtures";

const ESC_PATTERN = /[\u001b\u0007\u009b\u009d]/;
const AT = "2026-01-01T00:00:00.000Z";

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}

function fakeIO(overrides: Partial<CliIO> = {}) {
  const stdout = capture();
  const stderr = capture();
  const io: CliIO = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: new PassThrough(),
    env: {},
    cwd: "/tmp",
    isTTY: false,
    color: false,
    ...overrides,
  };
  return { io, stdout, stderr };
}

const SEQUENCE: AgentEvent[] = [
  { type: "run_start", runId: "r1", question: "What is DEVTOKEN?", at: AT },
  { type: "status", message: "Planning research", at: AT },
  { type: "plan", steps: ["Check price", "Check liquidity"], at: AT },
  { type: "tool_start", callId: "c1", tool: "get_market_data", label: "Checking market data", input: { symbol: "DEV" }, at: AT },
  { type: "tool_result", callId: "c1", tool: "get_market_data", evidenceId: "E1", summary: "Price 1.23", durationMs: 1234, at: AT },
  { type: "tool_start", callId: "c2", tool: "get_liquidity", label: "Checking liquidity", input: {}, at: AT },
  {
    type: "tool_error",
    callId: "c2",
    tool: "get_liquidity",
    error: { code: "DATA_UNAVAILABLE", message: "No pools", retryable: false },
    durationMs: 50,
    at: AT,
  },
  { type: "report", report: fixtureReport(), at: AT },
  { type: "run_end", status: "complete", at: AT },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("style", () => {
  it("returns plain text when disabled", () => {
    const style = createStyle(false);
    expect(style.enabled).toBe(false);
    for (const fn of [style.bold, style.dim, style.italic, style.underline, style.green, style.red, style.yellow, style.cyan, style.gray, style.magenta, style.accent]) {
      expect(fn("abc")).toBe("abc");
    }
    expect(style.link("Docs", "https://example.com")).toBe("Docs (https://example.com)");
    expect(style.link("https://example.com", "https://example.com")).toBe("https://example.com");
  });

  it("emits ANSI and OSC 8 links when enabled", () => {
    const style = createStyle(true);
    expect(style.bold("x")).toBe("\x1b[1mx\x1b[22m");
    expect(stripAnsi(style.accent("ROVANTA"))).toBe("ROVANTA");
    const link = style.link("Docs", "https://example.com");
    expect(link).toContain("\x1b]8;;https://example.com\x1b\\");
    expect(stripAnsi(link)).toBe("Docs");
  });

  it("does not let a url break out of the OSC 8 sequence", () => {
    const link = createStyle(true).link("x", "https://a.example/\x1b]8;;evil\x07\x1b[2J");
    expect(link.match(/\x1b\]8;;/g)).toHaveLength(2);
    expect(link).not.toContain("\x07");
    expect(link).not.toContain("[2J");
  });

  it("stripAnsi removes CSI, OSC and 8-bit sequences", () => {
    expect(stripAnsi("a\x1b[31mred\x1b[0m b")).toBe("ared b");
    expect(stripAnsi("\x1b]8;;evil\x07click\x1b]8;;\x07")).toBe("click");
    expect(stripAnsi("x\x1b[2Jy")).toBe("xy");
    expect(stripAnsi("x\x9b2Jy")).toBe("xy");
    expect(stripAnsi("\x1b]0;title\x1b\\ok")).toBe("ok");
  });

  it("sanitizeTerminalText strips escapes and control chars but keeps newlines and tabs", () => {
    const dirty = "line1\x1b]8;;evil\x07\n\tline2\x1b[2J\x07\x00\x08\x1b\r\nend\u202E";
    const clean = sanitizeTerminalText(dirty);
    expect(clean).toBe("line1\n\tline2\nend");
    expect(clean).not.toMatch(ESC_PATTERN);
  });
});

describe("renderTable", () => {
  it("aligns columns using visible width even with ANSI input", () => {
    const style = createStyle(true);
    const out = renderTable(
      [
        [style.green("a"), "1"],
        ["longer", style.red("22")],
      ],
      { header: ["Name", "N"], style },
    );
    const lines = stripAnsi(out).split("\n");
    expect(lines).toEqual(["Name    N", "──────  ──", "a       1", "longer  22"]);
  });

  it("renders plain ASCII rules when style is disabled", () => {
    const out = renderTable([["x", "y"]], { header: ["A", "B"] });
    expect(out).toBe("A  B\n-  -\nx  y");
    expect(renderTable([])).toBe("");
  });

  it("renders key/value pairs aligned", () => {
    expect(renderKeyValue([["a", "1"], ["long", "2"]])).toBe("a:     1\nlong:  2");
  });
});

describe("renderReportText", () => {
  it("renders title, findings, sources and disclaimer with no escapes when disabled", () => {
    const text = renderReportText(fixtureReport(), createStyle(false));
    expect(text).toContain("DEV FIXTURE report");
    expect(text).toContain("What is happening with DEVTOKEN?");
    expect(text).toContain("Summary");
    expect(text).toContain("DEV FIXTURE overview.");
    expect(text).toContain("[FACT]");
    expect(text).toContain("DEVTOKEN trades at 1.23 USD. [E1]");
    expect(text).toContain("[INFERENCE]");
    expect(text).toContain("[UNKNOWN]");
    expect(text).toContain("Who are the largest holders?");
    expect(text).toContain("Sources");
    expect(text).toContain("1. [E1] get_market_data");
    expect(text).toContain("Dev Market Feed (devfeed) (https://example.com/market)");
    expect(text).toContain("Generated by ROVANTA. Not investment advice.");
    expect(text).not.toMatch(ESC_PATTERN);
  });

  it("drops non-http(s) urls", () => {
    const text = renderReportText(fixtureReport(), createStyle(true));
    expect(text).not.toContain("javascript:");
    expect(stripAnsi(text)).toContain("Dev DEX (devdex)");
    expect(text).toContain("\x1b]8;;https://example.com/market\x1b\\");
  });

  it("neutralizes escape sequences in untrusted report text", () => {
    const report = fixtureReport({
      title: "Evil\x1b]8;;https://evil.example\x07title\x1b[2J",
      question: "q\x1b[31m?",
    });
    report.sections.market.claims[0].text = "claim\x1b]0;pwn\x07 text";
    const text = renderReportText(report, createStyle(false));
    expect(text).not.toMatch(ESC_PATTERN);
    expect(text).toContain("Eviltitle");
    expect(text).toContain("claim text");
  });

  it("wraps prose to the requested width", () => {
    const report = fixtureReport();
    report.sections.overview.summary = "word ".repeat(60).trim();
    const text = renderReportText(report, createStyle(false), 50);
    for (const line of text.split("\n")) {
      if (!line.includes("(http")) expect(Array.from(line).length).toBeLessThanOrEqual(50);
    }
    const narrow = renderReportText(report, createStyle(false), 10);
    expect(narrow.split("\n").find((l) => l.startsWith("---"))?.length).toBe(40);
  });

  it("wrapText hard-splits words longer than the width", () => {
    expect(wrapText("a".repeat(25), 10)).toEqual(["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
  });
});

describe("createEventRenderer", () => {
  it("writes one plain line per event to stderr in non-TTY mode", () => {
    const { io, stdout, stderr } = fakeIO();
    const renderer = createEventRenderer(io);
    for (const event of SEQUENCE) renderer.onEvent(event);
    renderer.finish();

    expect(stdout.text()).toBe("");
    expect(stderr.text()).not.toMatch(ESC_PATTERN);
    expect(stderr.text().split("\n")).toEqual([
      "run started: What is DEVTOKEN?",
      "status: Planning research",
      "plan:",
      "  1. Check price",
      "  2. Check liquidity",
      "tool start: Checking market data (get_market_data)",
      "tool done: Checking market data (get_market_data) in 1.2s - Price 1.23",
      "tool start: Checking liquidity (get_liquidity)",
      "tool failed: Checking liquidity (get_liquidity) in 50ms - DATA_UNAVAILABLE: No pools",
      "report ready: DEV FIXTURE report",
      "run complete",
      "",
    ]);
  });

  it("prints tool inputs and evidence ids in verbose mode", () => {
    const { io, stderr } = fakeIO();
    const renderer = createEventRenderer(io, { verbose: true });
    for (const event of SEQUENCE.slice(0, 5)) renderer.onEvent(event);
    renderer.finish();
    expect(stderr.text()).toContain('  input: {"symbol":"DEV"}');
    expect(stderr.text()).toContain("in 1.2s [E1] - Price 1.23");
  });

  it("truncates long verbose inputs", () => {
    const { io, stderr } = fakeIO();
    const renderer = createEventRenderer(io, { verbose: true });
    renderer.onEvent({ type: "tool_start", callId: "c", tool: "t", label: "L", input: { s: "x".repeat(1000) }, at: AT });
    const line = stderr.text().split("\n").find((l) => l.startsWith("  input:"));
    expect(line && Array.from(line).length).toBeLessThanOrEqual(220);
  });

  it("prints only errors in quiet mode", () => {
    const { io, stdout, stderr } = fakeIO();
    const renderer = createEventRenderer(io, { quiet: true });
    const events: AgentEvent[] = [
      ...SEQUENCE.slice(0, -1),
      { type: "error", error: { code: "INTERNAL", message: "boom", retryable: false }, at: AT },
      { type: "run_end", status: "failed", at: AT },
    ];
    for (const event of events) renderer.onEvent(event);
    renderer.finish();
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("error: INTERNAL: boom\n");
  });

  it("sanitizes untrusted event text", () => {
    const { io, stderr } = fakeIO();
    const renderer = createEventRenderer(io);
    renderer.onEvent({ type: "status", message: "hi\x1b]8;;evil\x07\x1b[2J there", at: AT });
    expect(stderr.text()).toBe("status: hi there\n");
  });

  it("animates a spinner in TTY mode and clears it on finish", () => {
    vi.useFakeTimers();
    const { io, stdout, stderr } = fakeIO({ isTTY: true, color: true });
    const renderer = createEventRenderer(io);
    renderer.onEvent(SEQUENCE[0]);
    renderer.onEvent(SEQUENCE[3]);
    vi.advanceTimersByTime(400);
    renderer.onEvent(SEQUENCE[4]);
    renderer.finish();
    const before = stderr.text();
    vi.advanceTimersByTime(1000);

    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe(before);
    const plain = stripAnsi(before);
    expect(plain).toContain("⠙ Checking market data");
    expect(plain).toContain("✓ Checking market data 1.2s");
    expect(before.endsWith("\r\x1b[2K")).toBe(true);
  });

  it("formats durations", () => {
    expect(formatDuration(320)).toBe("320ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(65_000)).toBe("1m5s");
  });
});
