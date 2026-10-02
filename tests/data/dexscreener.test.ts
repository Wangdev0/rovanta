import { describe, expect, it } from "vitest";
import { DexScreenerLiquidityProvider } from "@/core/data/dexscreener";
import fixture from "../fixtures/data/dexscreener.json";
import { includes, mockFetch } from "./helpers";

const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("DexScreenerLiquidityProvider", () => {
  it("maps pairs, sorts by liquidity and sums known liquidity", async () => {
    const fetchImpl = mockFetch([{ match: includes(`/latest/dex/tokens/${ADDRESS}`), body: fixture.pairs }]);
    const dex = new DexScreenerLiquidityProvider({ fetchImpl });
    const res = await dex.getLiquidity({ address: ADDRESS });
    expect(res.data.pools.map((p) => p.pairAddress)).toEqual(["0xbbbb", "0xaaaa", "0xcccc"]);
    expect(res.data.totalLiquidityUsd).toBe(100000);
    expect(res.data.pools[1]).toEqual({
      dex: "fixtureswap",
      chain: "ethereum",
      pairAddress: "0xaaaa",
      baseSymbol: "FXT",
      quoteSymbol: "FXD",
      liquidityUsd: 20000,
      volume24hUsd: 5000,
      priceUsd: 1.23,
      txns24h: { buys: 10, sells: 7 },
      pairCreatedAt: new Date(1767225600000).toISOString(),
      url: "https://dexscreener.com/ethereum/0xaaaa",
    });
    expect(res.data.pools[2]).toMatchObject({ priceUsd: null, liquidityUsd: null, txns24h: null, pairCreatedAt: null, url: null });
    expect(res.sources[0]).toMatchObject({ provider: "dexscreener", url: "https://dexscreener.com" });
  });

  it("filters by chain when one is given", async () => {
    const fetchImpl = mockFetch([{ match: includes("/latest/dex/tokens/"), body: fixture.pairs }]);
    const res = await new DexScreenerLiquidityProvider({ fetchImpl }).getLiquidity({ address: ADDRESS, chain: "ethereum" });
    expect(res.data.pools.every((p) => p.chain === "ethereum")).toBe(true);
    expect(res.data.totalLiquidityUsd).toBe(20000);
  });

  it("uses search for symbol refs and keeps only matching base symbols", async () => {
    const fetchImpl = mockFetch([{ match: includes("/latest/dex/search?q=FXT"), body: fixture.pairs }]);
    const res = await new DexScreenerLiquidityProvider({ fetchImpl }).getLiquidity({ symbol: "FXT" });
    expect(res.data.pools.map((p) => p.pairAddress)).toEqual(["0xbbbb", "0xaaaa"]);
  });

  it("caps searchPairs results and handles null pairs", async () => {
    const many = { pairs: Array.from({ length: 30 }, (_, i) => ({ ...fixture.pairs.pairs[0], pairAddress: `0x${i}`, liquidity: { usd: i } })) };
    const fetchImpl = mockFetch([
      { match: includes("q=many"), body: many },
      { match: includes("q=none"), body: { schemaVersion: "1.0.0", pairs: null } },
    ]);
    const dex = new DexScreenerLiquidityProvider({ fetchImpl });
    const res = await dex.searchPairs("many", 5);
    expect(res.data.pools).toHaveLength(5);
    expect(res.data.pools[0].liquidityUsd).toBe(29);
    expect((await dex.searchPairs("many")).data.pools).toHaveLength(10);
    const empty = await dex.searchPairs("none");
    expect(empty.data).toMatchObject({ pools: [], totalLiquidityUsd: null });
  });

  it("raises MALFORMED_TOOL_RESULT on unexpected shapes", async () => {
    const fetchImpl = mockFetch([{ match: () => true, body: { pairs: [{ chainId: 1 }] } }]);
    await expect(new DexScreenerLiquidityProvider({ fetchImpl }).searchPairs("x")).rejects.toMatchObject({
      code: "MALFORMED_TOOL_RESULT",
    });
  });
});
