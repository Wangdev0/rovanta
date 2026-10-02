import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { CliIO } from "./io";

/** Thrown when input ends (EOF) or the user cancels (Ctrl+C) before answering. */
export class PromptClosedError extends Error {
  constructor(message = "Input ended before a value was entered.") {
    super(message);
    this.name = "PromptClosedError";
  }
}

export function isInteractive(io: CliIO): boolean {
  return (io.stdin as NodeJS.ReadStream).isTTY === true;
}

interface PipedReader {
  buffer: string;
  lines: string[];
  ended: boolean;
  waiters: ((line: string | null) => void)[];
}

// Piped input may arrive in one chunk holding several answers, so lines are buffered per stream
// and shared across prompts instead of being dropped when a readline interface closes.
const pipedReaders = new WeakMap<NodeJS.ReadableStream, PipedReader>();

function pipedReader(stream: NodeJS.ReadableStream): PipedReader {
  let reader = pipedReaders.get(stream);
  if (reader) return reader;
  const state: PipedReader = { buffer: "", lines: [], ended: false, waiters: [] };
  const flush = () => {
    while (state.waiters.length > 0 && (state.lines.length > 0 || state.ended)) {
      state.waiters.shift()?.(state.lines.shift() ?? null);
    }
    if (state.waiters.length === 0) stream.pause();
  };
  stream.on("data", (chunk: Buffer | string) => {
    state.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = state.buffer.split("\n");
    state.buffer = parts.pop() ?? "";
    state.lines.push(...parts.map((line) => line.replace(/\r$/, "")));
    flush();
  });
  const end = () => {
    if (state.ended) return;
    if (state.buffer) state.lines.push(state.buffer.replace(/\r$/, ""));
    state.buffer = "";
    state.ended = true;
    flush();
  };
  stream.on("end", end);
  stream.on("close", end);
  stream.on("error", end);
  pipedReaders.set(stream, state);
  reader = state;
  return reader;
}

function readPipedLine(io: CliIO, question: string): Promise<string> {
  io.stderr.write(question);
  const reader = pipedReader(io.stdin);
  return new Promise((resolve, reject) => {
    const done = (line: string | null) => {
      io.stderr.write("\n");
      if (line === null) reject(new PromptClosedError());
      else resolve(line);
    };
    if (reader.lines.length > 0 || reader.ended) {
      done(reader.lines.shift() ?? null);
      return;
    }
    reader.waiters.push(done);
    io.stdin.resume();
  });
}

function readTTYLine(io: CliIO, question: string, hidden: boolean): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) io.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: io.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on("SIGINT", () => {
      io.stderr.write("\n");
      rl.close();
    });
    rl.on("close", () => {
      if (!answered) reject(new PromptClosedError("Cancelled."));
    });
    rl.question(question, (answer) => {
      answered = true;
      if (hidden) io.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
    if (hidden) muted = true;
  });
}

async function readLine(io: CliIO, question: string, hidden: boolean): Promise<string> {
  return isInteractive(io) ? readTTYLine(io, question, hidden) : readPipedLine(io, question);
}

/** Prompts on stderr (stdout stays clean for data). Empty answer returns the default when given. */
export async function ask(io: CliIO, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await readLine(io, `${question}${suffix}: `, false)).trim();
  return answer || defaultValue || "";
}

/** Like ask, but typed characters are not echoed when stdin is a terminal. */
export async function askSecret(io: CliIO, question: string): Promise<string> {
  return (await readLine(io, `${question}: `, true)).trim();
}

export async function choose(
  io: CliIO,
  question: string,
  options: { value: string; label: string }[],
  defaultValue?: string,
): Promise<string> {
  if (options.length === 0) throw new Error("choose() needs at least one option.");
  const defaultIndex = options.findIndex((option) => option.value === defaultValue);
  io.stderr.write(`${question}\n`);
  options.forEach((option, index) => {
    const marker = index === defaultIndex ? " (default)" : "";
    io.stderr.write(`  ${index + 1}) ${option.label}${marker}\n`);
  });
  for (;;) {
    const answer = await ask(io, `Choose 1-${options.length}`, defaultIndex >= 0 ? String(defaultIndex + 1) : undefined);
    const byNumber = /^\d+$/.test(answer) ? options[Number(answer) - 1] : undefined;
    const match = byNumber ?? options.find((option) => option.value === answer);
    if (match) return match.value;
    io.stderr.write(`Please enter a number from 1 to ${options.length}.\n`);
  }
}
