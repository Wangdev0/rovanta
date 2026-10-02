import { parseArgs } from "node:util";
import type { ChainStatus } from "@/core/data/schemas";
import type { DataServices } from "@/core/data/types";
import { writeLine, type CommandHandler } from "../io";
import { renderTable } from "../render/table";
import { createStyle, sanitizeTerminalText, type Style } from "../style";
import { loadDataServices, safeErrorMessage, type CommandDeps } from "./wallet";

export const CHAIN_HELP = `Usage: rovanta chain [status] [options]

Show the supported chains, whether an RPC is configured, and live RPC health.
RPC URLs are never printed (they may contain API keys).

Options:
  --json       Print machine-readable JSON
  -h, --help   Show this help`;

export type ChainRow =
  | { chain: string; ok: true; status: ChainStatus }
  | { chain: string; ok: false; error: { code: string; message: string } };

export async function collectChainStatuses(data: DataServices): Promise<ChainRow[]> {
  const chains = data.onchain.supportedChains();
  return Promise.all(
    chains.map(async (chain): Promise<ChainRow> => {
      try {
        const { data: status } = await data.onchain.getChainStatus(chain);
        return { chain, ok: true, status };
      } catch (err) {
        return { chain, ok: false, error: safeErrorMessage(err) };
      }
    }),
  );
}

function healthCell(row: ChainRow, style: Style): string {
  if (!row.ok) return style.red(`error ${row.error.code}: ${row.error.message}`);
  const { status } = row;
  if (!status.configured) return style.gray("not configured");
  if (!status.reachable) return style.red("unreachable");
  return style.green(status.rpcLatencyMs !== null ? `ok (${status.rpcLatencyMs} ms)` : "ok");
}

export function createChainCommand(deps: CommandDeps = {}): CommandHandler {
  return async (args, io) => {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (err) {
      writeLine(io.stderr, `${(err as Error).message}\n\n${CHAIN_HELP}`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      writeLine(io.stdout, CHAIN_HELP);
      return 0;
    }
    const [sub, ...extra] = positionals;
    if ((sub !== undefined && sub !== "status") || extra.length > 0) {
      writeLine(io.stderr, `Unknown chain subcommand: ${sanitizeTerminalText(positionals.join(" "))}\n\n${CHAIN_HELP}`);
      return 2;
    }

    const style = createStyle(io.color && !values.json);
    let data: DataServices;
    try {
      data = await loadDataServices(io, deps);
    } catch (err) {
      writeLine(io.stderr, style.red(`error: ${safeErrorMessage(err).message}`));
      return 1;
    }

    const rows = await collectChainStatuses(data);

    if (values.json) {
      writeLine(
        io.stdout,
        JSON.stringify(
          { chains: rows.map((row) => (row.ok ? { ...row.status, chain: row.chain } : { chain: row.chain, error: row.error })) },
          null,
          2,
        ),
      );
      return 0;
    }

    if (rows.length === 0) {
      writeLine(io.stdout, "No chains are supported in this build.");
      return 0;
    }
    const table = rows.map((row) => {
      const status = row.ok ? row.status : null;
      return [
        sanitizeTerminalText(row.chain),
        status ? (status.configured ? style.green("yes") : style.gray("no")) : "?",
        status?.chainId != null ? String(status.chainId) : "-",
        status?.latestBlock ? sanitizeTerminalText(status.latestBlock) : "-",
        healthCell(row, style),
      ];
    });
    writeLine(io.stdout, renderTable(table, { header: ["Chain", "Configured", "Chain ID", "Latest block", "RPC"], style }));
    if (rows.some((row) => row.ok && !row.status.configured)) {
      writeLine(io.stdout);
      writeLine(
        io.stdout,
        style.dim("Configure a chain by setting its RPC URL, e.g. ROBINHOOD_CHAIN_RPC_URL or ETHEREUM_RPC_URL."),
      );
    }
    return 0;
  };
}

export const runChainCommand = createChainCommand();
