import { main } from "./index";
import { createDefaultIO } from "./io";

const io = createDefaultIO({ noColor: process.argv.includes("--no-color") });

main(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    io.stderr.write(`rovanta: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
