import { parseArgs } from "node:util";
import { ALL_TOOLS, type AnyToolDefinition, type ToolCategory } from "@/core/tools";
import { writeLine, type CommandHandler } from "../io";
import { renderTable } from "../render/table";
import { createStyle } from "../style";

export const TOOLS_HELP = `Usage: rovanta tools [options]

List the research tools the agent can call.

Options:
  --json       Print machine-readable JSON (full descriptions)
  -h, --help   Show this help`;

export type ToolGroup = "market" | "chain" | "analysis";

const GROUP_OF: Record<ToolCategory, ToolGroup> = {
  market: "market",
  liquidity: "market",
  onchain: "chain",
  protocol: "chain",
  analysis: "analysis",
};

const GROUP_TITLES: Record<ToolGroup, string> = {
  market: "Market & liquidity",
  chain: "Chain & protocol",
  analysis: "Analysis",
};

/** First sentence of a tool description, for compact terminal output. */
export function summarizeDescription(description: string, maxLength = 100): string {
  const text = description.replace(/\s+/g, " ").trim();
  const sentence = text.match(/^(.+?[.!?])(?=\s+[A-Z]|$)/)?.[1] ?? text;
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 1).trimEnd()}…`;
}

export function createToolsCommand(deps: { tools?: AnyToolDefinition[] } = {}): CommandHandler {
  return async (args, io) => {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        allowPositionals: false,
        strict: true,
        options: {
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
      }));
    } catch (err) {
      writeLine(io.stderr, `${(err as Error).message}\n\n${TOOLS_HELP}`);
      return 2;
    }
    if (values.help) {
      writeLine(io.stdout, TOOLS_HELP);
      return 0;
    }

    const tools = deps.tools ?? ALL_TOOLS;
    if (values.json) {
      const list = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        group: GROUP_OF[tool.category] ?? "analysis",
      }));
      writeLine(io.stdout, JSON.stringify({ tools: list }, null, 2));
      return 0;
    }

    const style = createStyle(io.color);
    const sections: string[] = [];
    for (const group of Object.keys(GROUP_TITLES) as ToolGroup[]) {
      const members = tools.filter((tool) => (GROUP_OF[tool.category] ?? "analysis") === group);
      if (members.length === 0) continue;
      const rows = members.map((tool) => [style.cyan(tool.name), summarizeDescription(tool.description)]);
      sections.push(`${style.bold(GROUP_TITLES[group])}\n${renderTable(rows, { header: ["Tool", "Description"], style })}`);
    }
    writeLine(io.stdout, sections.join("\n\n"));
    writeLine(io.stdout);
    writeLine(io.stdout, style.dim(`${tools.length} tools. Use --json for full descriptions.`));
    return 0;
  };
}

export const runToolsCommand = createToolsCommand();
