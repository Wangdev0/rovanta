import { parseArgs } from "node:util";
import { formatUnits } from "viem";
import { MAX_HISTORY_LIMIT, ROBINHOOD_ENV } from "@/core/chain";
import type { ChainStatus, NativeBalance, SourceRef, TokenBalance, Transaction } from "@/core/data/schemas";
import { createServerDataServices } from "@/core/data/server";
import type { DataServices, Sourced } from "@/core/data/types";
import { toRovantaError, type RovantaErrorCode } from "@/core/errors";
import { isEvmAddress } from "@/core/security/validators";
import { resolveDataEnv } from "../config";
import { writeLine, type CliIO, type CommandHandler } from "../io";
import { renderKeyValue, renderTable } from "../render/table";
import { createStyle, sanitizeTerminalText, type Style } from "../style";

export const DEFAULT_WALLET_LIMIT = 10;
const PREFERRED_CHAIN = "robinhood";

export const WALLET_HELP = `Usage: rovanta wallet <address> [options]

Look up a public EVM address: native balance, token balances and recent transactions.
Read-only. ROVANTA never asks for private keys or seed phrases.

Options:
  --chain <slug>   Chain to query (default: first configured chain, preferring robinhood)
  --limit <n>      Number of recent transactions (default ${DEFAULT_WALLET_LIMIT}, max ${MAX_HISTORY_LIMIT})
  --json           Print machine-readable JSON
  -h, --help       Show this help`;

export interface CommandDeps {
  /** Pre-built data services (tests). Defaults to the direct adapters built from the resolved env. */
  data?: DataServices;
}

export async function loadDataServices(io: CliIO, deps: CommandDeps): Promise<DataServices> {
  if (deps.data) return deps.data;
  return createServerDataServices(await resolveDataEnv(io.env));
}

/** RPC and explorer URLs may embed API keys; never echo a URL from an error message. */
export function safeErrorMessage(err: unknown): { code: RovantaErrorCode; message: string } {
  const e = toRovantaError(err);
  return { code: e.code, message: sanitizeTerminalText(e.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")) };
}

type SectionResult<T> =
  | { ok: true; data: T; sources: SourceRef[] }
  | { ok: false; error: { code: RovantaErrorCode; message: string } };

function settle<T>(promise: Promise<Sourced<T>>): Promise<SectionResult<T>> {
  return promise.then(
    (value) => ({ ok: true as const, data: value.data, sources: value.sources }),
    (err: unknown) => ({ ok: false as const, error: safeErrorMessage(err) }),
  );
}

export function shorten(raw: string, head = 6, tail = 4): string {
  const value = sanitizeTerminalText(raw);
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatAmount(formatted: string): string {
  const [whole, fraction = ""] = formatted.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

function formatWei(value: string): string {
  try {
    return formatAmount(formatUnits(BigInt(value), 18));
  } catch {
    return sanitizeTerminalText(value);
  }
}

function formatTime(timestamp: string | null): string {
  if (!timestamp) return "-";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "-" : date.toISOString().replace("T", " ").slice(0, 16);
}

function notConfiguredHelp(chains: string[]): string {
  return [
    `No chain RPC is configured${chains.length ? ` (supported: ${chains.join(", ")})` : ""}.`,
    `Set ${ROBINHOOD_ENV.rpcUrl} (and optionally ${ROBINHOOD_ENV.explorerApiUrl} for token balances and history),`,
    "or ETHEREUM_RPC_URL / ETHEREUM_EXPLORER_API_URL for Ethereum, in your environment.",
    `You can also save it with: rovanta config set ${ROBINHOOD_ENV.rpcUrl} <url>`,
  ].join("\n");
}

/** First configured chain, preferring robinhood. Returns its status so it is not fetched twice. */
async function pickDefaultChain(data: DataServices): Promise<{ chain: string; status: ChainStatus } | null> {
  const chains = data.onchain.supportedChains();
  const ordered = [...chains.filter((c) => c === PREFERRED_CHAIN), ...chains.filter((c) => c !== PREFERRED_CHAIN)];
  for (const chain of ordered) {
    try {
      const { data: status } = await data.onchain.getChainStatus(chain);
      if (status.configured) return { chain, status };
    } catch {
      // try the next chain
    }
  }
  return null;
}

function sourceLines(style: Style, sections: SectionResult<unknown>[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const section of sections) {
    if (!section.ok) continue;
    for (const source of section.sources) {
      if (!source.url || seen.has(source.url)) continue;
      seen.add(source.url);
      const name = sanitizeTerminalText(source.name);
      const url = sanitizeTerminalText(source.url);
      lines.push(`  ${name}: ${style.link(url, url)}`);
    }
  }
  return lines;
}

function warn(io: CliIO, style: Style, section: string, error: { code: string; message: string }): void {
  writeLine(io.stderr, style.yellow(`warning: ${section} unavailable (${error.code}): ${error.message}`));
}

export function createWalletCommand(deps: CommandDeps = {}): CommandHandler {
  return async (args, io) => {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
          chain: { type: "string" },
          limit: { type: "string" },
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (err) {
      writeLine(io.stderr, `${(err as Error).message}\n\n${WALLET_HELP}`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      writeLine(io.stdout, WALLET_HELP);
      return 0;
    }
    if (positionals.length !== 1) {
      writeLine(io.stderr, `${positionals.length === 0 ? "Missing <address>." : "Too many arguments."}\n\n${WALLET_HELP}`);
      return 2;
    }
    const address = positionals[0].trim();
    if (!isEvmAddress(address)) {
      writeLine(
        io.stderr,
        "Invalid address: expected a public 0x address (40 hex characters). ROVANTA never asks for private keys or seed phrases.",
      );
      return 2;
    }
    let limit = DEFAULT_WALLET_LIMIT;
    if (values.limit !== undefined) {
      const n = Number(values.limit);
      if (!/^\d+$/.test(values.limit.trim()) || n < 1 || n > MAX_HISTORY_LIMIT) {
        writeLine(io.stderr, `Invalid --limit: expected an integer from 1 to ${MAX_HISTORY_LIMIT}.`);
        return 2;
      }
      limit = n;
    }

    const style = createStyle(io.color && !values.json);
    let data: DataServices;
    try {
      data = await loadDataServices(io, deps);
    } catch (err) {
      writeLine(io.stderr, style.red(`error: ${safeErrorMessage(err).message}`));
      return 1;
    }

    let chain: string;
    let statusPromise: Promise<SectionResult<ChainStatus>>;
    if (values.chain !== undefined) {
      chain = values.chain.trim().toLowerCase();
      const supported = data.onchain.supportedChains();
      if (!supported.includes(chain)) {
        writeLine(io.stderr, `Unknown chain "${sanitizeTerminalText(values.chain)}". Supported chains: ${supported.join(", ") || "none"}.`);
        return 2;
      }
      statusPromise = settle(data.onchain.getChainStatus(chain));
    } else {
      const picked = await pickDefaultChain(data);
      if (!picked) {
        writeLine(io.stderr, style.red(notConfiguredHelp(data.onchain.supportedChains())));
        return 1;
      }
      chain = picked.chain;
      statusPromise = Promise.resolve({ ok: true, data: picked.status, sources: [] });
    }

    const [status, native, tokens, txs] = await Promise.all([
      statusPromise,
      settle<NativeBalance>(data.onchain.getNativeBalance(chain, address)),
      settle<TokenBalance[]>(data.onchain.getTokenBalances(chain, address)),
      settle<Transaction[]>(data.onchain.getAddressTransactions(chain, address, limit)),
    ]);
    const allFailed = !native.ok && !tokens.ok && !txs.ok;

    if (values.json) {
      const strip = <T>(s: SectionResult<T>) => (s.ok ? { data: s.data, sources: s.sources } : { error: s.error });
      writeLine(
        io.stdout,
        JSON.stringify(
          {
            address,
            chain,
            chainStatus: status.ok ? status.data : null,
            native: strip(native),
            tokens: strip(tokens),
            transactions: strip(txs),
          },
          null,
          2,
        ),
      );
      return allFailed ? 1 : 0;
    }

    const out: string[] = [];
    out.push(style.bold(`Wallet ${address}`));
    const summary: [string, string][] = [["Chain", chain]];
    if (status.ok) {
      if (status.data.chainId !== null) summary.push(["Chain ID", String(status.data.chainId)]);
      if (status.data.latestBlock) summary.push(["Latest block", sanitizeTerminalText(status.data.latestBlock)]);
    }
    if (native.ok) {
      summary.push([
        "Native balance",
        `${formatAmount(native.data.formatted)} ${sanitizeTerminalText(native.data.symbol)}`,
      ]);
    }
    out.push(renderKeyValue(summary, style));
    writeLine(io.stdout, out.join("\n"));
    if (!native.ok) warn(io, style, "native balance", native.error);

    writeLine(io.stdout);
    writeLine(io.stdout, style.bold("Token balances"));
    if (tokens.ok) {
      if (tokens.data.length === 0) {
        writeLine(io.stdout, style.dim("No token balances found."));
      } else {
        const rows = tokens.data.map((t) => [
          sanitizeTerminalText(t.symbol ?? "?"),
          sanitizeTerminalText(t.name ?? "Unknown"),
          t.formatted !== null ? formatAmount(t.formatted) : `${sanitizeTerminalText(t.raw)} raw`,
          shorten(t.tokenAddress),
        ]);
        writeLine(io.stdout, renderTable(rows, { header: ["Symbol", "Name", "Balance", "Contract"], style }));
      }
    } else {
      warn(io, style, "token balances", tokens.error);
    }

    writeLine(io.stdout);
    writeLine(io.stdout, style.bold("Recent transactions"));
    if (txs.ok) {
      if (txs.data.length === 0) {
        writeLine(io.stdout, style.dim("No transactions found."));
      } else {
        const symbol = native.ok ? ` ${sanitizeTerminalText(native.data.symbol)}` : "";
        const rows = txs.data.map((tx) => [
          shorten(tx.hash, 10, 6),
          shorten(tx.from),
          tx.to ? shorten(tx.to) : "-",
          `${formatWei(tx.value)}${symbol}`,
          sanitizeTerminalText(tx.blockNumber ?? "-"),
          formatTime(tx.timestamp),
          tx.status,
        ]);
        writeLine(
          io.stdout,
          renderTable(rows, { header: ["Hash", "From", "To", "Value", "Block", "Time (UTC)", "Status"], style }),
        );
      }
    } else {
      warn(io, style, "transactions", txs.error);
    }

    const links = sourceLines(style, [native, tokens, txs]);
    if (links.length) {
      writeLine(io.stdout);
      writeLine(io.stdout, style.bold("Explorer"));
      writeLine(io.stdout, links.join("\n"));
    }
    return allFailed ? 1 : 0;
  };
}

export const runWalletCommand = createWalletCommand();
