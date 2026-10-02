import { Writable, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createChainCommand } from "@/cli/commands/chain";
import { createProvidersCommand } from "@/cli/commands/providers";
import { createToolsCommand } from "@/cli/commands/tools";
import { createWalletCommand } from "@/cli/commands/wallet";
import type { CliIO } from "@/cli/io";
import { RovantaError } from "@/core/errors";
import type { ChainStatus } from "@/core/data/schemas";
import type { DataServices } from "@/core/data/types";
import { listProviders } from "@/core/llm/registry";
import { ALL_TOOLS } from "@/core/tools";
import { createFakeServices } from "../data/fake-services";
import { OTHER, RPC_URL, TOKEN, TX_HASH, WALLET } from "../chain/fixtures";

const fetchedAt = "2026-01-01T00:00:00.000Z";
const EXPLORER = "https://explorer.fixture.invalid";

function captureIO(env: NodeJS.ProcessEnv = {}): { io: CliIO; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  const sink = (append: (s: string) => void) =>
    new Writable({
      write(chunk, _enc, cb) {
        append(String(chunk));
        cb();
      },
    });
  const io: CliIO = {
    stdout: sink((s) => (out += s)),
    stderr: sink((s) => (err += s)),
    stdin: Readable.from([]),
    env,
    cwd: "/tmp",
    isTTY: false,
    color: false,
  };
  return { io, out: () => out, err: () => err };
}

function status(chain: string, overrides: Partial<ChainStatus> = {}): ChainStatus {
  return {
    chain,
    chainId: 999_001,
    configured: true,
    reachable: true,
    latestBlock: "1234",
    latestBlockTime: fetchedAt,
    gasPriceGwei: 2.5,
    rpcLatencyMs: 42,
    ...overrides,
  };
}

function walletServices(overrides: Partial<DataServices["onchain"]> = {}): DataServices {
  const base = createFakeServices();
  const addressSource = { provider: "explorer:robinhood", name: "Robinhood explorer API", url: `${EXPLORER}/address/${WALLET}`, fetchedAt };
  base.onchain = {
    ...base.onchain,
    supportedChains: () => ["robinhood", "ethereum"],
    getChainStatus: vi.fn(async (chain: string) => ({ data: status(chain), sources: [] })),
    getNativeBalance: vi.fn(async (chain: string, address: string) => ({
      data: { address, chain, symbol: "ETH", raw: "1500000000000000000", formatted: "1.5" },
      sources: [addressSource],
    })),
    getTokenBalances: vi.fn(async () => ({
      data: [
        {
          tokenAddress: TOKEN,
          symbol: "FIX",
          name: "Fixture \u001b[31mToken",
          decimals: 6,
          raw: "12345678",
          formatted: "12.345678",
        },
      ],
      sources: [addressSource],
    })),
    getAddressTransactions: vi.fn(async (chain: string) => ({
      data: [
        {
          hash: TX_HASH,
          chain,
          blockNumber: "1200",
          timestamp: fetchedAt,
          from: WALLET,
          to: OTHER,
          value: "1000000000000000000",
          status: "success" as const,
          method: "transfer",
        },
      ],
      sources: [addressSource],
    })),
    ...overrides,
  };
  return base;
}

describe("rovanta wallet", () => {
  it("exits 2 for an invalid address", async () => {
    const data = walletServices();
    const { io, err } = captureIO();
    expect(await createWalletCommand({ data })(["0x1234"], io)).toBe(2);
    expect(err()).toContain("Invalid address");
    expect(data.onchain.getNativeBalance).not.toHaveBeenCalled();
  });

  it("exits 2 for a missing address, bad --limit or unknown flag", async () => {
    const run = createWalletCommand({ data: walletServices() });
    expect(await run([], captureIO().io)).toBe(2);
    expect(await run([WALLET, "--limit", "0"], captureIO().io)).toBe(2);
    expect(await run([WALLET, "--limit", "999"], captureIO().io)).toBe(2);
    expect(await run([WALLET, "--bogus"], captureIO().io)).toBe(2);
  });

  it("prints help with -h", async () => {
    const { io, out } = captureIO();
    expect(await createWalletCommand({ data: walletServices() })(["-h"], io)).toBe(0);
    expect(out()).toContain("Usage: rovanta wallet");
  });

  it("prints balances, transactions and explorer links", async () => {
    const data = walletServices();
    const { io, out, err } = captureIO();
    expect(await createWalletCommand({ data })([WALLET], io)).toBe(0);
    const text = out();
    expect(text).toContain("robinhood");
    expect(text).toContain("1.5 ETH");
    expect(text).toContain("FIX");
    expect(text).toContain("Fixture Token");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("12.345678");
    expect(text).toContain(TX_HASH.slice(0, 10));
    expect(text).toContain("1 ETH");
    expect(text).toContain("2026-01-01 00:00");
    expect(text).toContain(`${EXPLORER}/address/${WALLET}`);
    expect(err()).toBe("");
    expect(data.onchain.getAddressTransactions).toHaveBeenCalledWith("robinhood", WALLET, 10);
  });

  it("prefers the first configured chain when robinhood is not configured", async () => {
    const data = walletServices({
      getChainStatus: vi.fn(async (chain: string) => ({
        data: status(chain, { configured: chain !== "robinhood" }),
        sources: [],
      })),
    });
    const { io } = captureIO();
    expect(await createWalletCommand({ data })([WALLET, "--limit", "5"], io)).toBe(0);
    expect(data.onchain.getNativeBalance).toHaveBeenCalledWith("ethereum", WALLET);
    expect(data.onchain.getAddressTransactions).toHaveBeenCalledWith("ethereum", WALLET, 5);
  });

  it("explains which env vars to set when no chain is configured", async () => {
    const data = walletServices({
      getChainStatus: vi.fn(async (chain: string) => ({ data: status(chain, { configured: false }), sources: [] })),
    });
    const { io, err } = captureIO();
    expect(await createWalletCommand({ data })([WALLET], io)).toBe(1);
    expect(err()).toContain("ROBINHOOD_CHAIN_RPC_URL");
    expect(err()).toContain("rovanta config set");
  });

  it("rejects an unknown --chain with exit 2", async () => {
    const { io, err } = captureIO();
    expect(await createWalletCommand({ data: walletServices() })([WALLET, "--chain", "nope"], io)).toBe(2);
    expect(err()).toContain("Supported chains: robinhood, ethereum");
  });

  it("emits parseable JSON with --json", async () => {
    const { io, out } = captureIO();
    expect(await createWalletCommand({ data: walletServices() })([WALLET, "--chain", "ethereum", "--json"], io)).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.address).toBe(WALLET);
    expect(parsed.chain).toBe("ethereum");
    expect(parsed.native.data.formatted).toBe("1.5");
    expect(parsed.tokens.data).toHaveLength(1);
    expect(parsed.transactions.data[0].hash).toBe(TX_HASH);
  });

  it("degrades gracefully when one section fails", async () => {
    const data = walletServices({
      getTokenBalances: vi.fn(async () => {
        throw new RovantaError("DATA_UNAVAILABLE", `explorer API not configured at ${RPC_URL}`);
      }),
    });
    const { io, out, err } = captureIO();
    expect(await createWalletCommand({ data })([WALLET], io)).toBe(0);
    expect(out()).toContain("1.5 ETH");
    expect(out()).toContain(TX_HASH.slice(0, 10));
    expect(err()).toContain("warning: token balances unavailable (DATA_UNAVAILABLE)");
    expect(err()).not.toContain(RPC_URL);

    const json = captureIO();
    expect(await createWalletCommand({ data })([WALLET, "--json"], json.io)).toBe(0);
    const parsed = JSON.parse(json.out());
    expect(parsed.tokens.error.code).toBe("DATA_UNAVAILABLE");
    expect(parsed.native.data.formatted).toBe("1.5");
  });

  it("exits 1 when every section fails", async () => {
    const fail = vi.fn(async () => {
      throw new RovantaError("RPC_UNAVAILABLE");
    });
    const data = walletServices({ getNativeBalance: fail, getTokenBalances: fail, getAddressTransactions: fail });
    const { io, err } = captureIO();
    expect(await createWalletCommand({ data })([WALLET], io)).toBe(1);
    expect(err()).toContain("RPC_UNAVAILABLE");
  });
});

describe("rovanta chain", () => {
  function chainServices(): DataServices {
    const base = createFakeServices();
    base.onchain = {
      ...base.onchain,
      supportedChains: () => ["robinhood", "ethereum", "broken"],
      getChainStatus: vi.fn(async (chain: string) => {
        if (chain === "broken") throw new RovantaError("RPC_UNAVAILABLE", `failed to reach ${RPC_URL}`);
        if (chain === "robinhood") return { data: status(chain, { configured: false, reachable: false, latestBlock: null, rpcLatencyMs: null }), sources: [] };
        return { data: status(chain, { chainId: 1, latestBlock: "20000000" }), sources: [] };
      }),
    };
    return base;
  }

  it("lists chains with configured state, block and per-row errors, without RPC URLs", async () => {
    const { io, out } = captureIO();
    expect(await createChainCommand({ data: chainServices() })(["status"], io)).toBe(0);
    const text = out();
    expect(text).toMatch(/robinhood\s+no/);
    expect(text).toMatch(/ethereum\s+yes\s+1\s+20000000\s+ok \(42 ms\)/);
    expect(text).toContain("RPC_UNAVAILABLE");
    expect(text).not.toContain(RPC_URL);
    expect(text).not.toContain("rpc.fixture.invalid");
  });

  it("emits JSON without RPC URLs", async () => {
    const { io, out } = captureIO();
    expect(await createChainCommand({ data: chainServices() })(["--json"], io)).toBe(0);
    expect(out()).not.toContain("rpc.fixture.invalid");
    const parsed = JSON.parse(out());
    expect(parsed.chains.map((c: { chain: string }) => c.chain)).toEqual(["robinhood", "ethereum", "broken"]);
    expect(parsed.chains[2].error.code).toBe("RPC_UNAVAILABLE");
  });

  it("exits 2 for an unknown subcommand", async () => {
    expect(await createChainCommand({ data: chainServices() })(["restart"], captureIO().io)).toBe(2);
  });
});

describe("rovanta tools", () => {
  it("lists every tool, grouped", async () => {
    const { io, out } = captureIO();
    expect(await createToolsCommand()([], io)).toBe(0);
    for (const tool of ALL_TOOLS) expect(out()).toContain(tool.name);
    expect(out()).toContain("Market & liquidity");
    expect(out()).toContain("Chain & protocol");
  });

  it("emits JSON with every tool", async () => {
    const { io, out } = captureIO();
    expect(await createToolsCommand()(["--json"], io)).toBe(0);
    const parsed = JSON.parse(out());
    expect(parsed.tools.map((t: { name: string }) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it("exits 2 on unexpected arguments", async () => {
    expect(await createToolsCommand()(["extra"], captureIO().io)).toBe(2);
  });
});

describe("rovanta providers", () => {
  const SECRET = "sk-test-SECRET-123";

  it("lists all providers and marks the configured one without printing the key", async () => {
    const run = createProvidersCommand({
      resolveConfig: async () => ({ provider: "anthropic", model: "test-model", apiKey: SECRET }),
    });
    const { io, out } = captureIO();
    expect(await run([], io)).toBe(0);
    for (const p of listProviders()) {
      expect(out()).toContain(p.id);
      expect(out()).toContain(p.docsUrl);
    }
    expect(out()).toMatch(/\*\s+anthropic/);
    expect(out()).toContain("Configured: anthropic / test-model");
    expect(out()).not.toContain(SECRET);
  });

  it("emits parseable JSON", async () => {
    const run = createProvidersCommand({
      resolveConfig: async () => ({ provider: "google", model: "m", apiKey: SECRET }),
    });
    const { io, out } = captureIO();
    expect(await run(["--json"], io)).toBe(0);
    expect(out()).not.toContain(SECRET);
    const parsed = JSON.parse(out());
    expect(parsed.providers.map((p: { id: string }) => p.id)).toEqual(listProviders().map((p) => p.id));
    expect(parsed.providers.find((p: { id: string }) => p.id === "google").configured).toBe(true);
    expect(parsed.configured).toEqual({ provider: "google", model: "m" });
  });

  it("survives config errors", async () => {
    const run = createProvidersCommand({
      resolveConfig: async () => {
        throw new RovantaError("INVALID_INPUT", "bad config file");
      },
    });
    const { io, out } = captureIO();
    expect(await run([], io)).toBe(0);
    expect(out()).toContain("Could not read LLM config: bad config file");
  });
});
