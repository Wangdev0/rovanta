/* DEV FIXTURE: in-memory DataServices stub for agent, tool and integration tests. Values are synthetic. */
import { vi } from "vitest";
import { RovantaError } from "@/core/errors";
import type { DataServices } from "@/core/data/types";

const fetchedAt = "2026-01-01T00:00:00.000Z";
const source = { provider: "fixture", name: "Fixture Source", fetchedAt };

export function createFakeServices(): DataServices {
  const notUsed = () => Promise.reject(new RovantaError("DATA_UNAVAILABLE", "fixture: not implemented"));
  return {
    market: {
      id: "fixture-market",
      name: "Fixture Market",
      enabled: true,
      searchTokens: vi.fn(async (query: string) => ({
        data: [{ assetId: "fixture-token", name: `Fixture Token (${query})`, symbol: "FXT", chain: null, address: null, marketCapRank: 1, source: "fixture" }],
        sources: [source],
      })),
      getTokenMetadata: notUsed,
      getTokenPrice: vi.fn(async () => ({ data: { priceUsd: 1.23, change24hPct: null, asOf: fetchedAt }, sources: [source] })),
      getMarketData: vi.fn(async () => {
        throw new RovantaError("RATE_LIMITED", "fixture upstream limit");
      }),
      getVolume: notUsed,
    },
    liquidity: { id: "fixture-liquidity", name: "Fixture Liquidity", enabled: true, getLiquidity: notUsed, searchPairs: notUsed },
    protocol: {
      id: "fixture-protocol",
      name: "Fixture Protocol",
      enabled: true,
      searchProtocols: notUsed,
      getProtocolMetadata: notUsed,
    },
    onchain: {
      id: "fixture-onchain",
      name: "Fixture Onchain",
      enabled: true,
      supportedChains: () => ["fixturechain"],
      getChainStatus: notUsed,
      getBlock: notUsed,
      getTransaction: notUsed,
      getNativeBalance: notUsed,
      getTokenBalances: notUsed,
      getAddressTransactions: notUsed,
      getContractInfo: notUsed,
      getTokenMetadata: notUsed,
    },
    web: { id: "web:disabled", name: "Web", enabled: false, search: notUsed },
  };
}
