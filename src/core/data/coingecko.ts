import { z } from "zod";
import { RovantaError } from "@/core/errors";
import { clampInt, defaultFetch, fetchJson, num, nowIso, parseUpstream, str, type FetchLike } from "./fetch-json";
import type {
  MarketData,
  SourceRef,
  TokenMetadata,
  TokenPrice,
  TokenRef,
  TokenSearchResult,
  VolumeData,
} from "./schemas";
import type { MarketDataProvider, Sourced } from "./types";

export type CoinGeckoPlan = "demo" | "pro";

export interface CoinGeckoOptions {
  apiKey?: string;
  plan?: CoinGeckoPlan;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const PUBLIC_BASE = "https://api.coingecko.com/api/v3";
const PRO_BASE = "https://pro-api.coingecko.com/api/v3";

/** App chain slug -> CoinGecko asset platform id. */
export const COINGECKO_PLATFORMS: Readonly<Record<string, string>> = {
  ethereum: "ethereum",
  arbitrum: "arbitrum-one",
  "arbitrum-one": "arbitrum-one",
  base: "base",
  optimism: "optimistic-ethereum",
  "optimistic-ethereum": "optimistic-ethereum",
  polygon: "polygon-pos",
  "polygon-pos": "polygon-pos",
  solana: "solana",
  bsc: "binance-smart-chain",
  bnb: "binance-smart-chain",
  "binance-smart-chain": "binance-smart-chain",
};

const PLATFORM_TO_CHAIN: Readonly<Record<string, string>> = {
  ethereum: "ethereum",
  "arbitrum-one": "arbitrum",
  base: "base",
  "optimistic-ethereum": "optimism",
  "polygon-pos": "polygon",
  solana: "solana",
  "binance-smart-chain": "bsc",
};

const numish = z.unknown().transform(num);
const usdField = z.object({ usd: numish.optional() }).partial().nullish();

const SearchSchema = z.object({
  coins: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      symbol: z.string(),
      market_cap_rank: numish.optional(),
    }),
  ),
});

const CoinSchema = z.object({
  id: z.string(),
  symbol: z.string().nullish(),
  name: z.string().nullish(),
  asset_platform_id: z.string().nullish(),
  platforms: z.record(z.string(), z.string().nullable()).nullish(),
  detail_platforms: z
    .record(
      z.string(),
      z.object({ decimal_place: numish.optional(), contract_address: z.string().nullish() }).nullable(),
    )
    .nullish(),
  categories: z.array(z.string().nullable()).nullish(),
  description: z.object({ en: z.string().nullish() }).nullish(),
  links: z.object({ homepage: z.array(z.string().nullable()).nullish() }).nullish(),
  last_updated: z.string().nullish(),
  market_data: z
    .object({
      current_price: usdField,
      market_cap: usdField,
      fully_diluted_valuation: usdField,
      total_volume: usdField,
      ath: usdField,
      price_change_percentage_24h: numish.optional(),
      price_change_percentage_7d: numish.optional(),
      circulating_supply: numish.optional(),
      total_supply: numish.optional(),
      last_updated: z.string().nullish(),
    })
    .nullish(),
});
type Coin = z.infer<typeof CoinSchema>;

const SimplePriceSchema = z.record(
  z.string(),
  z.object({ usd: numish.optional(), usd_24h_change: numish.optional(), last_updated_at: numish.optional() }),
);

const MarketChartSchema = z.object({
  total_volumes: z.array(z.tuple([z.number(), z.number().nullable()])),
});

interface Resolved {
  id: string;
  /** Present when resolution already fetched the full coin payload (contract lookups). */
  coin?: Coin;
  platform?: string;
}

const DETAIL_QUERY = "localization=false&tickers=false&community_data=false&developer_data=false";

export class CoinGeckoMarketProvider implements MarketDataProvider {
  readonly id = "coingecko";
  readonly name = "CoinGecko";
  readonly enabled = true;

  private readonly apiKey?: string;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs?: number;

  constructor(options: CoinGeckoOptions = {}) {
    this.apiKey = str(options.apiKey) ?? undefined;
    const pro = options.plan === "pro" && this.apiKey !== undefined;
    this.base = pro ? PRO_BASE : PUBLIC_BASE;
    this.headers = {};
    if (this.apiKey) this.headers[pro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = this.apiKey;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs;
  }

  async searchTokens(query: string, limit = 10): Promise<Sourced<TokenSearchResult[]>> {
    const fetchedAt = nowIso();
    const search = await this.search(query);
    const data = search.coins.slice(0, clampInt(limit, 1, 25, 10)).map((c) => ({
      assetId: c.id,
      name: c.name,
      symbol: c.symbol,
      chain: null,
      address: null,
      marketCapRank: c.market_cap_rank ?? null,
      source: this.id,
    }));
    return { data, sources: [this.source(null, fetchedAt)] };
  }

  async getTokenMetadata(token: TokenRef): Promise<Sourced<TokenMetadata>> {
    const fetchedAt = nowIso();
    const resolved = await this.resolve(token);
    const coin = resolved.coin ?? (await this.getCoin(resolved.id));
    const platform = resolved.platform ?? str(coin.asset_platform_id) ?? undefined;
    const address = platform ? str(token.address) ?? str(coin.platforms?.[platform]) : null;
    const decimals = platform ? num(coin.detail_platforms?.[platform]?.decimal_place) : null;
    const totalSupply = num(coin.market_data?.total_supply);
    const data: TokenMetadata = {
      name: str(coin.name),
      symbol: str(coin.symbol)?.toUpperCase() ?? null,
      decimals: decimals !== null && Number.isInteger(decimals) ? decimals : null,
      chain: platform ? PLATFORM_TO_CHAIN[platform] ?? platform : null,
      address: address ?? null,
      assetId: coin.id,
      description: str(coin.description?.en),
      website: (coin.links?.homepage ?? []).map(str).find((u) => u !== null) ?? null,
      categories: (coin.categories ?? []).map(str).filter((c): c is string => c !== null),
      totalSupply: totalSupply === null ? null : String(totalSupply),
    };
    return { data, sources: [this.source(coin.id, fetchedAt)] };
  }

  async getTokenPrice(token: TokenRef): Promise<Sourced<TokenPrice>> {
    const fetchedAt = nowIso();
    const resolved = await this.resolve(token);
    if (resolved.coin?.market_data) {
      const md = resolved.coin.market_data;
      return {
        data: {
          priceUsd: md.current_price?.usd ?? null,
          change24hPct: md.price_change_percentage_24h ?? null,
          asOf: str(md.last_updated) ?? fetchedAt,
        },
        sources: [this.source(resolved.id, fetchedAt)],
      };
    }
    const ids = encodeURIComponent(resolved.id);
    const raw = await this.get(
      `/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`,
    );
    const prices = parseUpstream(SimplePriceSchema, raw, "CoinGecko /simple/price");
    const entry = prices[resolved.id];
    if (!entry) throw new RovantaError("DATA_UNAVAILABLE", `CoinGecko has no USD price for "${resolved.id}".`);
    const updated = entry.last_updated_at ?? null;
    return {
      data: {
        priceUsd: entry.usd ?? null,
        change24hPct: entry.usd_24h_change ?? null,
        asOf: updated !== null ? new Date(updated * 1000).toISOString() : fetchedAt,
      },
      sources: [this.source(resolved.id, fetchedAt)],
    };
  }

  async getMarketData(token: TokenRef): Promise<Sourced<MarketData>> {
    const fetchedAt = nowIso();
    const resolved = await this.resolve(token);
    const coin = resolved.coin ?? (await this.getCoin(resolved.id));
    const md = coin.market_data;
    if (!md) throw new RovantaError("DATA_UNAVAILABLE", `CoinGecko has no market data for "${coin.id}".`);
    const data: MarketData = {
      priceUsd: md.current_price?.usd ?? null,
      marketCapUsd: md.market_cap?.usd ?? null,
      fullyDilutedValuationUsd: md.fully_diluted_valuation?.usd ?? null,
      volume24hUsd: md.total_volume?.usd ?? null,
      change24hPct: md.price_change_percentage_24h ?? null,
      change7dPct: md.price_change_percentage_7d ?? null,
      circulatingSupply: md.circulating_supply ?? null,
      totalSupply: md.total_supply ?? null,
      athUsd: md.ath?.usd ?? null,
      asOf: str(md.last_updated) ?? str(coin.last_updated) ?? fetchedAt,
    };
    return { data, sources: [this.source(coin.id, fetchedAt)] };
  }

  async getVolume(token: TokenRef, days = 30): Promise<Sourced<VolumeData>> {
    const fetchedAt = nowIso();
    const resolved = await this.resolve(token);
    const n = clampInt(days, 1, 365, 30);
    const raw = await this.get(
      `/coins/${encodeURIComponent(resolved.id)}/market_chart?vs_currency=usd&days=${n}&interval=daily`,
    );
    const chart = parseUpstream(MarketChartSchema, raw, "CoinGecko /market_chart");
    const history = chart.total_volumes
      .filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1]) && Number.isFinite(p[0]))
      .map(([ms, volumeUsd]) => ({ date: new Date(ms).toISOString(), volumeUsd }));
    return {
      data: {
        volume24hUsd: history.length ? history[history.length - 1].volumeUsd : null,
        history,
        asOf: fetchedAt,
      },
      sources: [this.source(resolved.id, fetchedAt)],
    };
  }

  private async resolve(token: TokenRef): Promise<Resolved> {
    const assetId = str(token.assetId);
    if (assetId) return { id: assetId };

    const address = str(token.address);
    if (address) {
      const chain = str(token.chain)?.toLowerCase();
      if (!chain) {
        throw new RovantaError("INVALID_TOKEN", "A chain is required to look up a token by contract address.");
      }
      const platform = COINGECKO_PLATFORMS[chain];
      if (!platform) {
        throw new RovantaError(
          "INVALID_TOKEN",
          `CoinGecko contract lookup does not support chain "${chain}". Supported: ${Object.keys(PLATFORM_TO_CHAIN)
            .map((p) => PLATFORM_TO_CHAIN[p])
            .join(", ")}.`,
        );
      }
      const raw = await this.get(`/coins/${platform}/contract/${encodeURIComponent(address)}`, {
        message: `CoinGecko has no asset for address ${address} on ${chain}.`,
      });
      const coin = parseUpstream(CoinSchema, raw, "CoinGecko /coins/contract");
      return { id: coin.id, coin, platform };
    }

    const symbol = str(token.symbol);
    if (symbol) {
      const search = await this.search(symbol);
      const wanted = symbol.toLowerCase();
      const best = search.coins
        .filter((c) => c.symbol.toLowerCase() === wanted)
        .sort((a, b) => (a.market_cap_rank ?? Infinity) - (b.market_cap_rank ?? Infinity))[0];
      if (!best) throw new RovantaError("INVALID_TOKEN", `CoinGecko has no asset with symbol "${symbol}".`);
      return { id: best.id };
    }

    throw new RovantaError("INVALID_TOKEN", "Provide at least one of address, assetId or symbol.");
  }

  private async search(query: string) {
    const raw = await this.get(`/search?query=${encodeURIComponent(query)}`);
    return parseUpstream(SearchSchema, raw, "CoinGecko /search");
  }

  private async getCoin(id: string): Promise<Coin> {
    const raw = await this.get(`/coins/${encodeURIComponent(id)}?${DETAIL_QUERY}`, {
      message: `CoinGecko has no asset with id "${id}".`,
    });
    return parseUpstream(CoinSchema, raw, "CoinGecko /coins");
  }

  private get(path: string, invalidToken?: { message: string }): Promise<unknown> {
    return fetchJson(this.fetchImpl, `${this.base}${path}`, {
      headers: this.headers,
      timeoutMs: this.timeoutMs,
      secrets: [this.apiKey],
      notFound: invalidToken ? { code: "INVALID_TOKEN", message: invalidToken.message } : undefined,
    });
  }

  private source(id: string | null, fetchedAt: string): SourceRef {
    return {
      provider: this.id,
      name: this.name,
      url: id ? `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}` : "https://www.coingecko.com",
      fetchedAt,
    };
  }
}
