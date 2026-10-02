import { describe, expect, it, vi } from "vitest";
import { RovantaError } from "@/core/errors";
import type { DataServices, OnChainDataProvider, ProtocolDataProvider } from "@/core/data/types";
import type { ProtocolMetadata, SourceRef, Transaction } from "@/core/data/schemas";
import { ToolRegistry, toParameterSchema } from "@/core/tools/registry";
import { executeTool } from "@/core/tools/executor";
import { REPORT_TOOL_NAME, chainProtocolTools } from "@/core/tools/chain-protocol";

// DEV FIXTURE: fake data services and sample records used only by these tests.
const NOW = new Date("2026-01-01T00:00:00.000Z");
const SRC: SourceRef = { provider: "fixture", name: "Fixture", fetchedAt: NOW.toISOString() };
const ADDRESS = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"a".repeat(64)}`;

const tx = (i: number): Transaction => ({
  hash: `0x${i.toString(16).padStart(64, "0")}`,
  chain: "robinhood",
  blockNumber: String(100 + i),
  timestamp: null,
  from: ADDRESS,
  to: null,
  value: "0",
  status: "success",
  method: null,
});

const metadata = (points: number): ProtocolMetadata => ({
  id: "fixture-protocol",
  name: "Fixture Protocol",
  category: null,
  chains: ["robinhood"],
  tvlUsd: null,
  change1dPct: null,
  change7dPct: null,
  url: null,
  description: null,
  twitter: null,
  github: [],
  audits: null,
  tokenSymbol: null,
  tokenAssetId: null,
  tvlByChain: {},
  tvlHistory: Array.from({ length: points }, (_, i) => ({ date: `day-${i}`, tvlUsd: i })),
});

function fakeData(overrides: { onchain?: Partial<OnChainDataProvider>; protocol?: Partial<ProtocolDataProvider> } = {}) {
  const meta = { id: "fixture", name: "Fixture", enabled: true };
  const unused = () => Promise.reject(new Error("not used in test"));
  const onchain: OnChainDataProvider = {
    ...meta,
    supportedChains: () => ["robinhood"],
    getChainStatus: async (chain) => ({
      data: {
        chain,
        chainId: null,
        configured: true,
        reachable: true,
        latestBlock: "123",
        latestBlockTime: null,
        gasPriceGwei: null,
        rpcLatencyMs: null,
      },
      sources: [SRC],
    }),
    getBlock: unused,
    getTransaction: vi.fn(async () => ({ data: tx(1), sources: [SRC] })),
    getNativeBalance: async (chain, address) => ({
      data: { address, chain, symbol: "ETH", raw: "1000000000000000000", formatted: "1" },
      sources: [SRC],
    }),
    getTokenBalances: async () => ({ data: [], sources: [SRC] }),
    getAddressTransactions: vi.fn(async (_c: string, _a: string, limit?: number) => ({
      data: Array.from({ length: limit ?? 10 }, (_, i) => tx(i)),
      sources: [SRC],
    })),
    getContractInfo: async (chain, address) => ({
      data: {
        address,
        chain,
        isContract: true,
        bytecodeSize: null,
        verified: null,
        name: null,
        compiler: null,
        token: null,
      },
      sources: [SRC],
    }),
    getTokenMetadata: unused,
    ...overrides.onchain,
  };
  const protocol: ProtocolDataProvider = {
    ...meta,
    searchProtocols: async () => ({ data: [], sources: [SRC] }),
    getProtocolMetadata: async () => ({ data: metadata(90), sources: [SRC] }),
    ...overrides.protocol,
  };
  return { onchain, protocol, market: {}, liquidity: {}, web: {} } as unknown as DataServices;
}

const registry = new ToolRegistry(chainProtocolTools);

function run(name: string, input: unknown, data: DataServices = fakeData()) {
  return executeTool(registry, name, input, { callId: "call-1", context: { data, now: () => NOW } });
}

describe("chain-protocol tools", () => {
  it("exports seven tools with JSON-schema representable inputs", () => {
    expect(chainProtocolTools.map((t) => t.name)).toEqual([
      "search_protocols",
      "get_protocol_metadata",
      "get_chain_status",
      "get_transactions",
      "get_wallet_activity",
      "get_contract_info",
      "generate_research_report",
    ]);
    for (const tool of chainProtocolTools) {
      const schema = toParameterSchema(tool.input);
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties as object).length).toBeGreaterThan(0);
      expect(tool.description).toMatch(/null/);
    }
    const tx = toParameterSchema(registry.get("get_transactions")!.input);
    expect((tx.properties as Record<string, { default?: unknown }>).chain.default).toBe("robinhood");
  });

  it("defaults chain to robinhood", async () => {
    const res = await run("get_chain_status", {});
    expect(res.ok && (res.data as { chain: string }).chain).toBe("robinhood");
  });

  it("get_transactions requires exactly one of hash or address", async () => {
    const none = await run("get_transactions", {});
    const both = await run("get_transactions", { hash: HASH, address: ADDRESS });
    expect(!none.ok && none.error.code).toBe("INVALID_INPUT");
    expect(!both.ok && both.error.code).toBe("INVALID_INPUT");

    const data = fakeData();
    const byHash = await run("get_transactions", { hash: HASH }, data);
    expect(byHash.ok && (byHash.data as { transactions: unknown[] }).transactions).toHaveLength(1);
    expect(data.onchain.getTransaction).toHaveBeenCalledWith("robinhood", HASH);

    const byAddress = await run("get_transactions", { address: ADDRESS, limit: 3 }, data);
    expect(byAddress.ok && (byAddress.data as { transactions: unknown[] }).transactions).toHaveLength(3);
    expect(data.onchain.getAddressTransactions).toHaveBeenCalledWith("robinhood", ADDRESS, 3);
  });

  it("rejects invalid addresses with INVALID_WALLET", async () => {
    for (const name of ["get_transactions", "get_wallet_activity", "get_contract_info"]) {
      const res = await run(name, { address: "0x123" });
      expect(!res.ok && res.error.code).toBe("INVALID_WALLET");
    }
  });

  it("get_wallet_activity reports partial failures as gaps", async () => {
    const data = fakeData({
      onchain: {
        getTokenBalances: () => Promise.reject(new RovantaError("DATA_UNAVAILABLE", "explorer API not configured")),
      },
    });
    const res = await run("get_wallet_activity", { address: ADDRESS }, data);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.data as { native: unknown; tokens: unknown[]; recentTransactions: unknown[]; gaps: string[] };
    expect(out.gaps).toEqual(["tokens: explorer API not configured"]);
    expect(out.tokens).toEqual([]);
    expect(out.native).not.toBeNull();
    expect(out.recentTransactions).toHaveLength(10);
    expect(res.sources).toHaveLength(2);
  });

  it("get_wallet_activity rethrows the first RovantaError when all parts fail", async () => {
    const fail = () => Promise.reject(new RovantaError("RPC_NOT_CONFIGURED"));
    const data = fakeData({
      onchain: {
        getNativeBalance: () => Promise.reject(new Error("plain failure")),
        getTokenBalances: fail,
        getAddressTransactions: fail,
      },
    });
    const res = await run("get_wallet_activity", { address: ADDRESS }, data);
    expect(!res.ok && res.error.code).toBe("RPC_NOT_CONFIGURED");
  });

  it("get_protocol_metadata truncates tvlHistory to the last 30 points", async () => {
    const res = await run("get_protocol_metadata", { protocol: "fixture-protocol" });
    expect(res.ok).toBe(true);
    const history = (res.ok ? res.data : null) as ProtocolMetadata | null;
    expect(history?.tvlHistory).toHaveLength(30);
    expect(history?.tvlHistory[0].date).toBe("day-60");
    expect(history?.tvlHistory[29].date).toBe("day-89");
  });

  it("generate_research_report signals readiness", async () => {
    expect(REPORT_TOOL_NAME).toBe("generate_research_report");
    const res = await run(REPORT_TOOL_NAME, { subject: "Fixture Protocol" });
    expect(res.ok && res.data).toEqual({ ready: true, subject: "Fixture Protocol", focus: [] });
    expect(res.ok && res.sources).toEqual([]);
    const focused = await run(REPORT_TOOL_NAME, { subject: "X", focus: ["liquidity"] });
    expect(focused.ok && (focused.data as { focus: string[] }).focus).toEqual(["liquidity"]);
    const tooMany = await run(REPORT_TOOL_NAME, { subject: "X", focus: Array(9).fill("a") });
    expect(!tooMany.ok && tooMany.error.code).toBe("INVALID_INPUT");
  });

  it("malformed provider data becomes MALFORMED_TOOL_RESULT", async () => {
    const data = fakeData({
      onchain: { getChainStatus: async () => ({ data: { chain: 42 } as never, sources: [SRC] }) },
      protocol: { getProtocolMetadata: async () => ({ data: { name: "x" } as never, sources: [SRC] }) },
    });
    const status = await run("get_chain_status", {}, data);
    const meta = await run("get_protocol_metadata", { protocol: "x" }, data);
    expect(!status.ok && status.error.code).toBe("MALFORMED_TOOL_RESULT");
    expect(!meta.ok && meta.error.code).toBe("MALFORMED_TOOL_RESULT");
  });
});
