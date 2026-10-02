import { describe, expect, it } from "vitest";
import { CoinGeckoMarketProvider } from "@/core/data/coingecko";
import { RovantaError } from "@/core/errors";
import fixture from "../fixtures/data/coingecko.json";
import { includes, mockFetch } from "./helpers";

const ADDRESS = "0x1111111111111111111111111111111111111111";

function provider(routes: Parameters<typeof mockFetch>[0], opts: { apiKey?: string; plan?: "demo" | "pro" } = {}) {
  const fetchImpl = mockFetch(routes);
  return { fetchImpl, cg: new CoinGeckoMarketProvider({ ...opts, fetchImpl }) };
}

async function rejection(p: Promise<unknown>): Promise<RovantaError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RovantaError);
    return err as RovantaError;
  }
  throw new Error("expected rejection");
}

describe("CoinGeckoMarketProvider", () => {
  it("maps search results", async () => {
    const { cg } = provider([{ match: includes("/search?query=fxt"), body: fixture.search }]);
    const res = await cg.searchTokens("fxt", 2);
    expect(res.data).toHaveLength(2);
    expect(res.data[1]).toEqual({
      assetId: "fixture-token",
      name: "Fixture Token",
      symbol: "FXT",
      chain: null,
      address: null,
      marketCapRank: 120,
      source: "coingecko",
    });
    expect(res.sources[0]).toMatchObject({ provider: "coingecko", name: "CoinGecko" });
  });

  it("resolves a symbol to the exact match with the best market cap rank", async () => {
    const { cg, fetchImpl } = provider([
      { match: includes("/search?query="), body: fixture.search },
      { match: includes("/simple/price"), body: fixture.simplePrice },
    ]);
    const res = await cg.getTokenPrice({ symbol: "fxt" });
    expect(res.data).toEqual({ priceUsd: 1.23, change24hPct: -2.5, asOf: new Date(1767225600 * 1000).toISOString() });
    expect(fetchImpl.mock.calls[1][0]).toContain("ids=fixture-token&");
    expect(res.sources[0].url).toBe("https://www.coingecko.com/en/coins/fixture-token");
  });

  it("rejects symbols with no exact match", async () => {
    const { cg } = provider([{ match: includes("/search"), body: fixture.search }]);
    expect((await rejection(cg.getTokenPrice({ symbol: "NOPE" }))).code).toBe("INVALID_TOKEN");
  });

  it("resolves address + chain through the contract endpoint and maps metadata", async () => {
    const { cg, fetchImpl } = provider([{ match: includes(`/coins/base/contract/${ADDRESS}`), body: fixture.coin }]);
    const res = await cg.getTokenMetadata({ chain: "base", address: ADDRESS });
    expect(res.data).toEqual({
      name: "Fixture Token",
      symbol: "FXT",
      decimals: 6,
      chain: "base",
      address: ADDRESS,
      assetId: "fixture-token",
      description: "A synthetic token used only in tests.",
      website: "https://fixture.invalid",
      categories: ["Fixture Category"],
      totalSupply: "200000000",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps chain aliases to CoinGecko platform ids", async () => {
    const { cg, fetchImpl } = provider([{ match: includes("/coins/arbitrum-one/contract/"), body: fixture.coin }]);
    await cg.getMarketData({ chain: "arbitrum", address: ADDRESS });
    expect(fetchImpl.mock.calls[0][0]).toContain("/coins/arbitrum-one/contract/");
  });

  it("rejects unknown chains and missing chain for address lookups", async () => {
    const { cg, fetchImpl } = provider([]);
    const unknown = await rejection(cg.getMarketData({ chain: "robinhood", address: ADDRESS }));
    expect(unknown.code).toBe("INVALID_TOKEN");
    expect(unknown.message).toContain("robinhood");
    expect((await rejection(cg.getMarketData({ address: ADDRESS }))).code).toBe("INVALID_TOKEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 404 on contract lookup to INVALID_TOKEN", async () => {
    const { cg } = provider([{ match: includes("/contract/"), status: 404, body: { error: "not found" } }]);
    expect((await rejection(cg.getTokenPrice({ chain: "ethereum", address: ADDRESS }))).code).toBe("INVALID_TOKEN");
  });

  it("maps market data by asset id, keeping unknown values null", async () => {
    const { cg, fetchImpl } = provider([{ match: includes("/coins/fixture-token?"), body: fixture.coin }]);
    const res = await cg.getMarketData({ assetId: "fixture-token" });
    expect(res.data).toEqual({
      priceUsd: 1.23,
      marketCapUsd: 123000000,
      fullyDilutedValuationUsd: null,
      volume24hUsd: 4560000,
      change24hPct: -2.5,
      change7dPct: 4.25,
      circulatingSupply: 100000000,
      totalSupply: 200000000,
      athUsd: 9.87,
      asOf: "2026-01-01T00:00:00.000Z",
    });
    expect(fetchImpl.mock.calls[0][0]).toContain("localization=false&tickers=false&community_data=false&developer_data=false");
  });

  it("maps volume history and skips null points", async () => {
    const { cg, fetchImpl } = provider([{ match: includes("/market_chart"), body: fixture.marketChart }]);
    const res = await cg.getVolume({ assetId: "fixture-token" }, 9999);
    expect(fetchImpl.mock.calls[0][0]).toContain("days=365");
    expect(res.data.history).toHaveLength(2);
    expect(res.data.volume24hUsd).toBe(3000000);
  });

  it("raises MALFORMED_TOOL_RESULT for unexpected shapes", async () => {
    const { cg } = provider([{ match: includes("/search"), body: { coins: [{ nope: true }] } }]);
    expect((await rejection(cg.searchTokens("x"))).code).toBe("MALFORMED_TOOL_RESULT");
    const bad = provider([{ match: includes("/market_chart"), body: "not json at all" }]);
    expect((await rejection(bad.cg.getVolume({ assetId: "x" }))).code).toBe("MALFORMED_TOOL_RESULT");
  });

  it("maps 429 to RATE_LIMITED", async () => {
    const { cg } = provider([{ match: includes("/search"), status: 429, body: {} }]);
    const err = await rejection(cg.searchTokens("x"));
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
  });

  it("sends the demo key as a header, never in the URL or sources", async () => {
    const key = "CG-demo-fixture-key-123456";
    const { cg, fetchImpl } = provider([{ match: includes("/coins/fixture-token?"), body: fixture.coin }], { apiKey: key });
    const res = await cg.getMarketData({ assetId: "fixture-token" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url.startsWith("https://api.coingecko.com/api/v3/")).toBe(true);
    expect(url).not.toContain(key);
    expect((init?.headers as Record<string, string>)["x-cg-demo-api-key"]).toBe(key);
    expect(JSON.stringify(res)).not.toContain(key);
  });

  it("uses the pro base and header when plan is pro", async () => {
    const key = "CG-pro-fixture-key-123456";
    const { cg, fetchImpl } = provider([{ match: includes("/search"), body: fixture.search }], { apiKey: key, plan: "pro" });
    await cg.searchTokens("fxt");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url.startsWith("https://pro-api.coingecko.com/api/v3/")).toBe(true);
    expect(url).not.toContain(key);
    expect((init?.headers as Record<string, string>)["x-cg-pro-api-key"]).toBe(key);
  });

  it("redacts the key from network error messages", async () => {
    const key = "CG-demo-fixture-key-abcdef";
    const fetchImpl = async () => {
      throw new Error(`socket failure with ${key}`);
    };
    const cg = new CoinGeckoMarketProvider({ apiKey: key, fetchImpl });
    const err = await rejection(cg.searchTokens("x"));
    expect(err.code).toBe("DATA_UNAVAILABLE");
    expect(JSON.stringify({ m: err.message, c: String(err.cause) })).not.toContain(key);
  });
});
