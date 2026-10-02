export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** True when stdout is an interactive terminal. */
  isTTY: boolean;
  /** True when ANSI colors should be used (TTY, no NO_COLOR, not --no-color). */
  color: boolean;
}

/** Every subcommand has this shape and returns a process exit code. */
export type CommandHandler = (args: string[], io: CliIO) => Promise<number>;

export function createDefaultIO(options: { noColor?: boolean } = {}): CliIO {
  const isTTY = Boolean(process.stdout.isTTY);
  const color = isTTY && !options.noColor && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    isTTY,
    color,
  };
}

export function writeLine(stream: NodeJS.WritableStream, text = ""): void {
  stream.write(`${text}\n`);
}
