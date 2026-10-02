import { describe, expect, it } from "vitest";
import { DefiLlamaProtocolProvider } from "@/core/data/defillama";
import fixture from "../fixtures/data/defillama.json";
import { includes, mockFetch } from "./helpers";

describe("DefiLlamaProtocolProvider", () => {
  it("ranks exact > prefix > contains, then by TVL", async () => {
    const fetchImpl = mockFetch([{ match: includes("/protocols"), body: fixture.protocols }]);
    const llama = new DefiLlamaProtocolProvider({ fetchImpl });
    const res = await llama.searchProtocols("FIXTURE");
    expect(res.data.map((p) => p.id)).toEqual(["fixture", "fixture-bridge", "fixture-lend", "mega-fixture-vaults"]);
    expect(res.data[2]).toEqual({
      id: "fixture-lend",
      name: "Fixture Lend",
      category: "Lending",
      chains: ["Ethereum"],
      tvlUsd: 5000,
      change1dPct: 1.5,
      change7dPct: -3,
      url: "https://lend.fixture.invalid",
    });
    expect((await llama.searchProtocols("fxl")).data.map((p) => p.id)).toEqual(["fixture-lend"]);
  });

  it("caches the protocol list for 10 minutes", async () => {
    let now = 0;
    const fetchImpl = mockFetch([{ match: includes("/protocols"), body: fixture.protocols }]);
    const llama = new DefiLlamaProtocolProvider({ fetchImpl, now: () => now });
    await llama.searchProtocols("fixture");
    now = 9 * 60 * 1000;
    await llama.searchProtocols("lend");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 11 * 60 * 1000;
    await llama.searchProtocols("lend");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("maps metadata, excluding borrowed/staking/pool2 buckets", async () => {
    const fetchImpl = mockFetch([{ match: includes("/protocol/fixture-lend"), body: fixture.protocol }]);
    const res = await new DefiLlamaProtocolProvider({ fetchImpl }).getProtocolMetadata("fixture-lend");
    const d = res.data;
    expect(d.tvlByChain).toEqual({ Ethereum: 3000, Base: 2000 });
    expect(d.tvlUsd).toBe(5000);
    expect(d).toMatchObject({
      id: "fixture-lend",
      name: "Fixture Lend",
      description: "Synthetic lending protocol for tests.",
      twitter: "fixture_lend",
      github: ["fixture-lend-org"],
      audits: "2",
      tokenSymbol: "FXL",
      tokenAssetId: "fixture-lend-token",
      chains: ["Ethereum", "Base"],
      category: "Lending",
      url: "https://lend.fixture.invalid",
    });
    expect(d.change1dPct).toBeCloseTo(25);
    expect(d.change7dPct).toBeCloseTo(((5000 - 4100) / 4100) * 100);
    expect(d.tvlHistory).toHaveLength(9);
    expect(d.tvlHistory[8]).toEqual({ date: new Date(1767225600 * 1000).toISOString(), tvlUsd: 5000 });
    expect(res.sources[0].url).toBe("https://defillama.com/protocol/fixture-lend");
  });

  it("keeps only the last 90 history points", async () => {
    const tvl = Array.from({ length: 120 }, (_, i) => ({ date: 1700000000 + i * 86400, totalLiquidityUSD: i + 1 }));
    const fetchImpl = mockFetch([{ match: includes("/protocol/"), body: { name: "Fixture", tvl } }]);
    const res = await new DefiLlamaProtocolProvider({ fetchImpl }).getProtocolMetadata("fixture");
    expect(res.data.tvlHistory).toHaveLength(90);
    expect(res.data.tvlHistory[0].tvlUsd).toBe(31);
    expect(res.data.tvlUsd).toBe(120);
  });

  it("maps 400/404 to DATA_UNAVAILABLE 'Protocol not found'", async () => {
    for (const status of [400, 404]) {
      const fetchImpl = mockFetch([{ match: () => true, status, body: {} }]);
      await expect(new DefiLlamaProtocolProvider({ fetchImpl }).getProtocolMetadata("missing")).rejects.toMatchObject({
        code: "DATA_UNAVAILABLE",
        message: expect.stringContaining("Protocol not found"),
      });
    }
  });

  it("raises MALFORMED_TOOL_RESULT on unexpected shapes", async () => {
    const fetchImpl = mockFetch([{ match: () => true, body: { protocols: "nope" } }]);
    await expect(new DefiLlamaProtocolProvider({ fetchImpl }).searchProtocols("x")).rejects.toMatchObject({
      code: "MALFORMED_TOOL_RESULT",
    });
  });
});
