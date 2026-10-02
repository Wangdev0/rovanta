import { describe, expect, it, vi } from "vitest";
import { RovantaError } from "@/core/errors";
import type { DataServices, Sourced } from "@/core/data/types";
import type { LiquidityData, MarketData, SourceRef, TokenRef } from "@/core/data/schemas";
import { ToolRegistry } from "@/core/tools/registry";
import { executeTool } from "@/core/tools/executor";
import { marketTools } from "@/core/tools/market";
import { formatUsd } from "@/core/tools/market/format";

// DEV FIXTURE: all values below are synthetic test data, not real market data.
const NOW = new Date("2026-01-01T00:00:00.000Z");
const ADDRESS = "0x1111111111111111111111111111111111111111";

function source(provider: string): SourceRef {
  return { provider, name: `${provider} fixture`, fetchedAt: NOW.toISOString() };
}

function sourced<T>(data: T, provider = "fixture-market"): Sourced<T> {
  return { data, sources: [source(provider)] };
}

const marketData = (priceUsd: number): MarketData => ({
  priceUsd,
  marketCapUsd: priceUsd * 1_000_000,
  fullyDilutedValuationUsd: null,
  volume24hUsd: 250_000,
  change24hPct: 1.5,
  change7dPct: null,
  circulatingSupply: null,
  totalSupply: null,
  athUsd: null,
  asOf: NOW.toISOString(),
});

const liquidityData: LiquidityData = {
  totalLiquidityUsd: 1_234_567,
  pools: [
    {
      dex: "fixture-dex",
      chain: "ethereum",
      pairAddress: ADDRESS,
      baseSymbol: "FXA",
      quoteSymbol: "USDC",
      liquidityUsd: 1_234_567,
      volume24hUsd: null,
      priceUsd: null,
      txns24h: null,
      pairCreatedAt: null,
      url: null,
    },
  ],
  asOf: NOW.toISOString(),
};

function fakeServices(): DataServices {
  const meta = { name: "Fixture", enabled: true };
  return {
    market: {
      id: "fixture-market",
      ...meta,
      searchTokens: vi.fn(async (query: string, limit?: number) =>
        sourced(
          Array.from({ length: Math.min(limit ?? 5, 2) }, (_, i) => ({
            assetId: `${query}-${i}`,
            name: `Fixture ${i}`,
            symbol: `FX${i}`,
            chain: null,
            address: null,
            marketCapRank: null,
            source: "fixture-market",
          })),
        ),
      ),
      getTokenMetadata: vi.fn(async (token: TokenRef) =>
        sourced({
          name: "Fixture Asset",
          symbol: token.symbol ?? "FXA",
          decimals: null,
          chain: null,
          address: null,
          assetId: token.assetId ?? null,
          description: null,
          website: null,
          categories: [],
          totalSupply: null,
        }),
      ),
      getTokenPrice: vi.fn(async () => sourced({ priceUsd: 2, change24hPct: null, asOf: NOW.toISOString() })),
      getMarketData: vi.fn(async () => sourced(marketData(2))),
      getVolume: vi.fn(async () =>
        sourced({ volume24hUsd: 100, history: [{ date: "2025-12-31", volumeUsd: 90 }], asOf: NOW.toISOString() }),
      ),
    },
    liquidity: {
      id: "fixture-liquidity",
      ...meta,
      getLiquidity: vi.fn(async () => sourced(liquidityData, "fixture-liquidity")),
      searchPairs: vi.fn(async () => sourced(liquidityData, "fixture-liquidity")),
    },
    protocol: {
      id: "fixture-protocol",
      ...meta,
      searchProtocols: vi.fn(),
      getProtocolMetadata: vi.fn(),
    },
    onchain: {
      id: "fixture-onchain",
      ...meta,
      supportedChains: () => ["robinhood"],
      getChainStatus: vi.fn(),
      getBlock: vi.fn(),
      getTransaction: vi.fn(),
      getNativeBalance: vi.fn(),
      getTokenBalances: vi.fn(),
      getAddressTransactions: vi.fn(),
      getContractInfo: vi.fn(),
      getTokenMetadata: vi.fn(async (chain: string, address: string) =>
        sourced(
          {
            name: "Onchain Fixture",
            symbol: "OCF",
            decimals: 18,
            chain,
            address,
            assetId: null,
            description: null,
            website: null,
            categories: [],
            totalSupply: "1000",
          },
          "fixture-onchain",
        ),
      ),
    },
    web: { id: "fixture-web", ...meta, search: vi.fn() },
  } as unknown as DataServices;
}

const registry = new ToolRegistry(marketTools);

function run(name: string, input: unknown, data: DataServices = fakeServices(), timeoutMs?: number) {
  return executeTool(registry, name, input, { callId: "call-1", context: { data, now: () => NOW }, timeoutMs });
}

const TOKEN_TOOLS = ["get_token_metadata", "get_token_price", "get_market_data", "get_volume", "get_liquidity"];

describe("market tools", () => {
  it("registers seven tools with object JSON schemas", () => {
    const specs = registry.toSpecs();
    expect(specs.map((s) => s.name).sort()).toEqual(
      [
        "compare_assets",
        "get_liquidity",
        "get_market_data",
        "get_token_metadata",
        "get_token_price",
        "get_volume",
        "search_tokens",
      ].sort(),
    );
    for (const spec of specs) {
      expect(spec.parameters.type).toBe("object");
      expect(spec.parameters.properties).toBeTypeOf("object");
      expect(Object.keys(spec.parameters.properties as object).length).toBeGreaterThan(0);
    }
  });

  it("search_tokens returns results with sources", async () => {
    const result = await run("search_tokens", { query: "fixture", limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { results: unknown[] }).results).toHaveLength(2);
    expect(result.sources).toEqual([source("fixture-market")]);
    expect(result.summary).toBe("Found 2 tokens matching 'fixture'");
  });

  it.each(TOKEN_TOOLS)("%s succeeds with valid input and passes sources through", async (name) => {
    const result = await run(name, { assetId: "fixture-asset" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it.each(TOKEN_TOOLS)("%s rejects missing token identifiers with INVALID_TOKEN", async (name) => {
    const result = await run(name, { chain: "ethereum" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_TOKEN");
  });

  it.each(TOKEN_TOOLS)("%s rejects malformed EVM addresses with INVALID_TOKEN", async (name) => {
    const result = await run(name, { chain: "ethereum", address: "0x123" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_TOKEN");
  });

  it("get_token_metadata reads on-chain metadata for supported chains", async () => {
    const data = fakeServices();
    const result = await run("get_token_metadata", { chain: "robinhood", address: ADDRESS }, data);
    expect(result.ok).toBe(true);
    expect(data.onchain.getTokenMetadata).toHaveBeenCalledWith("robinhood", ADDRESS);
    expect(data.market.getTokenMetadata).not.toHaveBeenCalled();
    if (result.ok) expect(result.sources).toEqual([source("fixture-onchain")]);
  });

  it("get_token_metadata falls back to market data for other chains", async () => {
    const data = fakeServices();
    const result = await run("get_token_metadata", { chain: "ethereum", address: ADDRESS }, data);
    expect(result.ok).toBe(true);
    expect(data.market.getTokenMetadata).toHaveBeenCalledWith({ chain: "ethereum", address: ADDRESS });
    expect(data.onchain.getTokenMetadata).not.toHaveBeenCalled();
  });

  it("get_liquidity summarizes total liquidity and pool count", async () => {
    const result = await run("get_liquidity", { symbol: "FXA" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toBe(`FXA: ${formatUsd(1_234_567)} total liquidity across 1 pool`);
  });

  it("get_liquidity reports unknown liquidity", async () => {
    const data = fakeServices();
    vi.mocked(data.liquidity.getLiquidity).mockResolvedValueOnce(
      sourced({ totalLiquidityUsd: null, pools: [], asOf: NOW.toISOString() }),
    );
    const result = await run("get_liquidity", { symbol: "FXA" }, data);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain("liquidity unknown");
  });

  it("returns MALFORMED_TOOL_RESULT when a provider returns malformed data", async () => {
    const data = fakeServices();
    vi.mocked(data.market.getTokenPrice).mockResolvedValueOnce({
      data: { priceUsd: "two" },
      sources: [],
    } as unknown as Sourced<never>);
    const result = await run("get_token_price", { symbol: "FXA" }, data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MALFORMED_TOOL_RESULT");
  });

  it("propagates RATE_LIMITED from providers", async () => {
    const data = fakeServices();
    vi.mocked(data.market.getMarketData).mockRejectedValueOnce(new RovantaError("RATE_LIMITED"));
    const result = await run("get_market_data", { symbol: "FXA" }, data);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(result.error.retryable).toBe(true);
  });

  it("returns TOOL_TIMEOUT for slow providers", async () => {
    const data = fakeServices();
    vi.mocked(data.market.getVolume).mockImplementationOnce(() => new Promise(() => {}));
    const result = await run("get_volume", { symbol: "FXA", days: 3 }, data, 20);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOOL_TIMEOUT");
  });

  it("compare_assets keeps successful rows on partial failure", async () => {
    const data = fakeServices();
    vi.mocked(data.market.getMarketData).mockImplementation(async (token: TokenRef) => {
      if (token.symbol === "BAD") throw new RovantaError("RATE_LIMITED");
      return sourced(marketData(token.symbol === "FXA" ? 2 : 3));
    });
    const result = await run(
      "compare_assets",
      { assets: [{ symbol: "FXA" }, { symbol: "BAD" }, { symbol: "FXB" }], metrics: ["price", "liquidity"] },
      data,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { rows, comparedAt } = result.data as {
      rows: { label: string; priceUsd: number | null; liquidityUsd: number | null; error: string | null }[];
      comparedAt: string;
    };
    expect(comparedAt).toBe(NOW.toISOString());
    expect(rows.map((r) => r.label)).toEqual(["FXA", "BAD", "FXB"]);
    expect(rows[0]).toMatchObject({ priceUsd: 2, liquidityUsd: 1_234_567, error: null });
    expect(rows[1].priceUsd).toBeNull();
    expect(rows[1].error).toContain("RATE_LIMITED");
    expect(rows[2]).toMatchObject({ priceUsd: 3, error: null });
    expect(result.sources).toContainEqual(source("fixture-market"));
    expect(result.sources).toContainEqual(source("fixture-liquidity"));
  });

  it("compare_assets turns invalid identifiers and malformed data into row errors", async () => {
    const data = fakeServices();
    vi.mocked(data.market.getMarketData).mockImplementation(async (token: TokenRef) => {
      if (token.symbol === "MAL") return { data: { priceUsd: "x" }, sources: [] } as unknown as Sourced<MarketData>;
      return sourced(marketData(2));
    });
    const result = await run(
      "compare_assets",
      { assets: [{ symbol: "FXA" }, { chain: "ethereum", address: "0xnope" }, { symbol: "MAL" }] },
      data,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = (result.data as { rows: { error: string | null; liquidityUsd: number | null }[] }).rows;
    expect(rows[0].error).toBeNull();
    expect(rows[0].liquidityUsd).toBeNull();
    expect(rows[1].error).toContain("INVALID_TOKEN");
    expect(rows[2].error).toContain("MALFORMED_TOOL_RESULT");
    expect(data.liquidity.getLiquidity).not.toHaveBeenCalled();
  });

  it("compare_assets throws DATA_UNAVAILABLE when every asset fails", async () => {
    const data = fakeServices();
    vi.mocked(data.market.getMarketData).mockRejectedValue(new RovantaError("RATE_LIMITED"));
    const result = await run("compare_assets", { assets: [{ symbol: "A" }, { symbol: "B" }] }, data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DATA_UNAVAILABLE");
  });

  it("compare_assets rejects fewer than two assets", async () => {
    const result = await run("compare_assets", { assets: [{ symbol: "A" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("formatUsd formats compactly and handles null", () => {
    expect(formatUsd(null)).toBe("unknown");
    expect(formatUsd(1_200_000)).toBe("$1.2M");
  });
});
