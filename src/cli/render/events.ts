import { activityLabelFor } from "../../core/agent/prompt";
import type { AgentEvent } from "../../core/agent/types";
import type { RovantaErrorJSON } from "../../core/errors";
import type { CliIO } from "../io";
import { createStyle, sanitizeTerminalText } from "../style";

export interface EventRenderer {
  onEvent(event: AgentEvent): void;
  finish(): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const INPUT_PREVIEW_CAP = 200;
const SUMMARY_CAP = 120;

function oneLine(text: string, cap = 500): string {
  const flat = sanitizeTerminalText(String(text)).replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : flat;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

function previewInput(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input) ?? "undefined";
  } catch {
    json = "[unserializable]";
  }
  return oneLine(json, INPUT_PREVIEW_CAP);
}

function errorText(error: RovantaErrorJSON): string {
  return `${oneLine(error.code, 40)}: ${oneLine(error.message)}`;
}

/**
 * Writes live progress to io.stderr (stdout stays clean for the report so it can be piped).
 * TTY + color: animated spinner for the current activity, ✓/✗ lines per tool call, numbered plan.
 * Non-TTY: plain one-line-per-event log, no spinner, no ANSI.
 * quiet: print nothing except errors. verbose: also print tool inputs and evidence ids.
 */
export function createEventRenderer(io: CliIO, options: { quiet?: boolean; verbose?: boolean } = {}): EventRenderer {
  const quiet = Boolean(options.quiet);
  const verbose = Boolean(options.verbose) && !quiet;
  const live = io.isTTY && io.color;
  const style = createStyle(live);
  const out = io.stderr;

  const labels = new Map<string, string>();
  const active: string[] = [];
  let status = "";
  let planPrinted = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let spinnerVisible = false;
  let finished = false;
  let startedAt = Date.now();

  const currentActivity = (): string => {
    const callId = active[active.length - 1];
    return (callId && labels.get(callId)) || status || "Working";
  };

  const clearSpinner = (): void => {
    if (spinnerVisible) {
      out.write("\r\x1b[2K");
      spinnerVisible = false;
    }
  };

  const drawSpinner = (): void => {
    if (!live || quiet || finished || !timer) return;
    const elapsed = formatDuration(Date.now() - startedAt);
    const extra = active.length > 1 ? style.dim(` (+${active.length - 1} more)`) : "";
    out.write(
      `\r\x1b[2K${style.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${currentActivity()}${extra} ${style.dim(elapsed)}`,
    );
    spinnerVisible = true;
  };

  const startSpinner = (): void => {
    if (!live || quiet || finished || timer) return;
    timer = setInterval(() => {
      frame += 1;
      drawSpinner();
    }, SPINNER_INTERVAL_MS);
    timer.unref?.();
    drawSpinner();
  };

  const stopSpinner = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearSpinner();
  };

  /** Print complete lines above the spinner. */
  const print = (...lines: string[]): void => {
    clearSpinner();
    for (const line of lines) out.write(`${line}\n`);
    drawSpinner();
  };

  const labelFor = (callId: string, tool: string): string => labels.get(callId) ?? oneLine(activityLabelFor(tool), 80);

  const onEvent = (event: AgentEvent): void => {
    if (finished) return;
    switch (event.type) {
      case "run_start": {
        startedAt = Date.parse(event.at) || Date.now();
        if (quiet) return;
        if (live) {
          print(`${style.accent("ROVANTA")} ${style.dim("›")} ${oneLine(event.question)}`);
          startSpinner();
        } else {
          print(`run started: ${oneLine(event.question)}`);
        }
        return;
      }
      case "status": {
        status = oneLine(event.message, 120);
        if (quiet) return;
        if (live) {
          startSpinner();
          drawSpinner();
        } else {
          print(`status: ${status}`);
        }
        return;
      }
      case "plan": {
        if (quiet || planPrinted || event.steps.length === 0) return;
        planPrinted = true;
        const steps = event.steps.map((step, i) => `  ${live ? style.dim(`${i + 1}.`) : `${i + 1}.`} ${oneLine(step)}`);
        print(live ? style.bold("Plan") : "plan:", ...steps);
        return;
      }
      case "tool_start": {
        const label = oneLine(event.label || activityLabelFor(event.tool), 80);
        labels.set(event.callId, label);
        active.push(event.callId);
        if (quiet) return;
        if (live) {
          startSpinner();
          if (verbose) print(style.dim(`  → ${oneLine(event.tool, 60)} ${previewInput(event.input)}`));
          else drawSpinner();
        } else {
          print(`tool start: ${label} (${oneLine(event.tool, 60)})`);
          if (verbose) print(`  input: ${previewInput(event.input)}`);
        }
        return;
      }
      case "tool_result": {
        const label = labelFor(event.callId, event.tool);
        removeActive(event.callId);
        if (quiet) return;
        const duration = formatDuration(event.durationMs);
        const summary = oneLine(event.summary, SUMMARY_CAP);
        const evidence = verbose ? ` [${oneLine(event.evidenceId, 20)}]` : "";
        if (live) {
          print(
            `${style.green("✓")} ${label} ${style.dim(duration)}${verbose ? style.cyan(evidence) : ""}` +
              (summary ? `\n  ${style.dim(summary)}` : ""),
          );
        } else {
          print(`tool done: ${label} (${oneLine(event.tool, 60)}) in ${duration}${evidence}${summary ? ` - ${summary}` : ""}`);
        }
        return;
      }
      case "tool_error": {
        const label = labelFor(event.callId, event.tool);
        removeActive(event.callId);
        if (quiet) return;
        const duration = formatDuration(event.durationMs);
        if (live) {
          print(`${style.red("✗")} ${label} ${style.dim(duration)}\n  ${style.red(errorText(event.error))}`);
        } else {
          print(`tool failed: ${label} (${oneLine(event.tool, 60)}) in ${duration} - ${errorText(event.error)}`);
        }
        return;
      }
      case "report": {
        if (quiet) return;
        const title = oneLine(event.report.title, 160);
        print(live ? `${style.green("✓")} ${style.bold("Report ready")} ${style.dim(title)}` : `report ready: ${title}`);
        return;
      }
      case "error": {
        print(live ? `${style.red("✗ Error")} ${style.red(errorText(event.error))}` : `error: ${errorText(event.error)}`);
        return;
      }
      case "run_end": {
        stopSpinner();
        if (quiet) return;
        const elapsed = formatDuration((Date.parse(event.at) || Date.now()) - startedAt);
        if (live) {
          const mark =
            event.status === "complete" ? style.green("✓") : event.status === "aborted" ? style.yellow("■") : style.red("✗");
          print(`${mark} Run ${event.status} ${style.dim(`in ${elapsed}`)}`);
        } else {
          print(`run ${event.status}`);
        }
        return;
      }
    }
  };

  function removeActive(callId: string): void {
    const index = active.lastIndexOf(callId);
    if (index !== -1) active.splice(index, 1);
  }

  return {
    onEvent,
    finish() {
      if (finished) return;
      stopSpinner();
      finished = true;
    },
  };
}
