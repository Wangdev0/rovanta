import { runChainCommand } from "./commands/chain";
import { runConfigCommand } from "./commands/config";
import { runProvidersCommand } from "./commands/providers";
import { runResearchCommand } from "./commands/research";
import { runToolsCommand } from "./commands/tools";
import { runWalletCommand } from "./commands/wallet";
import { writeLine, type CliIO, type CommandHandler } from "./io";
import { VERSION } from "./version";

const COMMANDS: Record<string, { handler: CommandHandler; summary: string }> = {
  research: { handler: runResearchCommand, summary: "Run an AI research job and print a sourced report" },
  wallet: { handler: runWalletCommand, summary: "Look up an address: balances and recent transactions" },
  chain: { handler: runChainCommand, summary: "Show status of configured chains" },
  tools: { handler: runToolsCommand, summary: "List the research tools the agent can call" },
  providers: { handler: runProvidersCommand, summary: "List supported LLM providers" },
  config: { handler: runConfigCommand, summary: "Set up and inspect your LLM provider settings" },
};

export function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = [
    `rovanta ${VERSION} - terminal-based AI research agent for crypto markets`,
    "",
    "Usage:",
    "  rovanta <command> [options]",
    '  rovanta "<question>"            Shorthand for: rovanta research "<question>"',
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`),
    "",
    "Global options:",
    "  -h, --help       Show help (also: rovanta <command> --help)",
    "  -v, --version    Print version",
    "      --no-color   Disable colors (NO_COLOR is also respected)",
    "",
    "Get started:",
    "  rovanta config init",
    '  rovanta research "What is the liquidity profile of ETH?"',
  ];
  return lines.join("\n");
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const args = argv.filter((arg) => arg !== "--no-color");
  const [first, ...rest] = args;

  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    writeLine(io.stdout, helpText());
    return first === undefined ? 1 : 0;
  }
  if (first === "-v" || first === "--version") {
    writeLine(io.stdout, VERSION);
    return 0;
  }

  const command = COMMANDS[first];
  if (command) return command.handler(rest, io);

  if (first.startsWith("-")) {
    writeLine(io.stderr, `Unknown option: ${first}\n\n${helpText()}`);
    return 2;
  }
  return runResearchCommand(args, io);
}
