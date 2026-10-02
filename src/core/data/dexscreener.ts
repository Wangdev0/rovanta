import { z } from "zod";
import { RovantaError } from "@/core/errors";
import { clampInt, defaultFetch, fetchJson, num, nowIso, parseUpstream, str, type FetchLike } from "./fetch-json";
import type { LiquidityData, LiquidityPool, TokenRef } from "./schemas";
import type { LiquidityDataProvider, Sourced } from "./types";

export interface DexScreenerOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const BASE = "https://api.dexscreener.com";
const MAX_POOLS = 10;

/** App chain slug -> DexScreener chainId, where they differ. */
const CHAIN_ALIASES: Readonly<Record<string, string>> = {
  "arbitrum-one": "arbitrum",
  "optimistic-ethereum": "optimism",
  "polygon-pos": "polygon",
  "binance-smart-chain": "bsc",
  bnb: "bsc",
};

const numish = z.unknown().transform(num);

const PairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  url: z.string().nullish(),
  pairAddress: z.string(),
  baseToken: z.object({ address: z.string().nullish(), symbol: z.string().nullish() }),
  quoteToken: z.object({ symbol: z.string().nullish() }),
  priceUsd: numish.optional(),
  txns: z.object({ h24: z.object({ buys: numish, sells: numish }).nullish() }).nullish(),
  volume: z.object({ h24: numish.optional() }).nullish(),
  liquidity: z.object({ usd: numish.optional() }).nullish(),
  pairCreatedAt: numish.optional(),
});
type Pair = z.infer<typeof PairSchema>;

const PairsResponseSchema = z.object({ pairs: z.array(PairSchema).nullish() });

export function mapPair(pair: Pair): LiquidityPool {
  const buys = pair.txns?.h24?.buys ?? null;
  const sells = pair.txns?.h24?.sells ?? null;
  const created = pair.pairCreatedAt ?? null;
  return {
    dex: pair.dexId,
    chain: pair.chainId,
    pairAddress: pair.pairAddress,
    baseSymbol: str(pair.baseToken.symbol) ?? "",
    quoteSymbol: str(pair.quoteToken.symbol) ?? "",
    liquidityUsd: pair.liquidity?.usd ?? null,
    volume24hUsd: pair.volume?.h24 ?? null,
    priceUsd: pair.priceUsd ?? null,
    txns24h: buys !== null && sells !== null ? { buys, sells } : null,
    pairCreatedAt: created !== null && created > 0 ? new Date(created).toISOString() : null,
    url: str(pair.url),
  };
}

export function summarizePools(pools: LiquidityPool[], limit: number): LiquidityData {
  const sorted = [...pools]
    .sort((a, b) => (b.liquidityUsd ?? -Infinity) - (a.liquidityUsd ?? -Infinity))
    .slice(0, limit);
  const known = sorted.map((p) => p.liquidityUsd).filter((v): v is number => v !== null);
  return {
    totalLiquidityUsd: known.length ? known.reduce((sum, v) => sum + v, 0) : null,
    pools: sorted,
    asOf: nowIso(),
  };
}

export class DexScreenerLiquidityProvider implements LiquidityDataProvider {
  readonly id = "dexscreener";
  readonly name = "DEX Screener";
  readonly enabled = true;

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs?: number;

  constructor(options: DexScreenerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs;
  }

  async getLiquidity(token: TokenRef): Promise<Sourced<LiquidityData>> {
    const fetchedAt = nowIso();
    const address = str(token.address);
    let pairs: Pair[];
    if (address) {
      pairs = await this.fetchPairs(`/latest/dex/tokens/${encodeURIComponent(address)}`);
      const chain = str(token.chain)?.toLowerCase();
      if (chain) {
        const wanted = CHAIN_ALIASES[chain] ?? chain;
        pairs = pairs.filter((p) => p.chainId.toLowerCase() === wanted);
      }
    } else {
      const query = str(token.symbol) ?? str(token.assetId);
      if (!query) throw new RovantaError("INVALID_TOKEN", "Provide at least one of address, assetId or symbol.");
      pairs = await this.fetchPairs(`/latest/dex/search?q=${encodeURIComponent(query)}`);
      const symbol = str(token.symbol)?.toLowerCase();
      if (symbol) pairs = pairs.filter((p) => str(p.baseToken.symbol)?.toLowerCase() === symbol);
    }
    return { data: summarizePools(pairs.map(mapPair), MAX_POOLS), sources: [this.source(fetchedAt)] };
  }

  async searchPairs(query: string, limit = MAX_POOLS): Promise<Sourced<LiquidityData>> {
    const fetchedAt = nowIso();
    const pairs = await this.fetchPairs(`/latest/dex/search?q=${encodeURIComponent(query)}`);
    return {
      data: summarizePools(pairs.map(mapPair), clampInt(limit, 1, 25, MAX_POOLS)),
      sources: [this.source(fetchedAt)],
    };
  }

  private async fetchPairs(path: string): Promise<Pair[]> {
    const raw = await fetchJson(this.fetchImpl, `${BASE}${path}`, { timeoutMs: this.timeoutMs });
    return parseUpstream(PairsResponseSchema, raw, "DEX Screener").pairs ?? [];
  }

  private source(fetchedAt: string) {
    return { provider: this.id, name: this.name, url: "https://dexscreener.com", fetchedAt };
  }
}
