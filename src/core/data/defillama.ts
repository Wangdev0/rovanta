import { z } from "zod";
import { RovantaError } from "@/core/errors";
import { clampInt, defaultFetch, fetchJson, num, nowIso, parseUpstream, str, type FetchLike } from "./fetch-json";
import type { ProtocolMetadata, ProtocolSummary, SourceRef } from "./schemas";
import type { ProtocolDataProvider, Sourced } from "./types";

export interface DefiLlamaOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

const BASE = "https://api.llama.fi";
const LIST_TTL_MS = 10 * 60 * 1000;
const HISTORY_POINTS = 90;
const DAY_S = 86_400;
/** currentChainTvls keys that are accounting buckets rather than chains. */
const NON_CHAIN_KEYS = new Set(["staking", "pool2", "borrowed", "doublecounted", "liquidstaking", "vesting", "offers"]);

const numish = z.unknown().transform(num);

const ListItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  slug: z.string().nullish(),
  symbol: z.string().nullish(),
  category: z.string().nullish(),
  chains: z.array(z.string()).nullish(),
  tvl: numish.optional(),
  change_1d: numish.optional(),
  change_7d: numish.optional(),
  url: z.string().nullish(),
});
type ListItem = z.infer<typeof ListItemSchema>;

const ListSchema = z.array(ListItemSchema);

const ProtocolSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).nullish(),
  name: z.string(),
  url: z.string().nullish(),
  description: z.string().nullish(),
  symbol: z.string().nullish(),
  gecko_id: z.string().nullish(),
  twitter: z.string().nullish(),
  github: z.array(z.string()).nullish(),
  audits: z.union([z.string(), z.number()]).nullish(),
  category: z.string().nullish(),
  chains: z.array(z.string()).nullish(),
  currentChainTvls: z.record(z.string(), numish).nullish(),
  tvl: z.array(z.object({ date: numish, totalLiquidityUSD: numish })).nullish(),
  change_1d: numish.optional(),
  change_7d: numish.optional(),
});

function isChainKey(key: string): boolean {
  return !key.includes("-") && !NON_CHAIN_KEYS.has(key.toLowerCase());
}

function changePct(history: Array<{ ts: number; tvl: number }>, seconds: number): number | null {
  const last = history[history.length - 1];
  if (!last) return null;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].ts <= last.ts - seconds) {
      const prev = history[i].tvl;
      return prev > 0 ? ((last.tvl - prev) / prev) * 100 : null;
    }
  }
  return null;
}

function matchScore(item: ListItem, q: string): number {
  let best = 0;
  for (const field of [item.name, item.slug, item.symbol]) {
    const v = str(field)?.toLowerCase();
    if (!v || v === "-") continue;
    if (v === q) return 3;
    if (v.startsWith(q)) best = Math.max(best, 2);
    else if (v.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

export function rankProtocols(list: ListItem[], query: string): ListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return list
    .map((item) => ({ item, score: matchScore(item, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.tvl ?? -Infinity) - (a.item.tvl ?? -Infinity))
    .map((r) => r.item);
}

export class DefiLlamaProtocolProvider implements ProtocolDataProvider {
  readonly id = "defillama";
  readonly name = "DefiLlama";
  readonly enabled = true;

  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs?: number;
  private readonly now: () => number;
  private listCache: { at: number; items: ListItem[] } | null = null;
  private listInflight: Promise<ListItem[]> | null = null;

  constructor(options: DefiLlamaOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? Date.now;
  }

  async searchProtocols(query: string, limit = 10): Promise<Sourced<ProtocolSummary[]>> {
    const fetchedAt = nowIso();
    const list = await this.getList();
    const data = rankProtocols(list, query)
      .slice(0, clampInt(limit, 1, 25, 10))
      .map((p) => ({
        id: str(p.slug) ?? p.id,
        name: p.name,
        category: str(p.category),
        chains: p.chains ?? [],
        tvlUsd: p.tvl ?? null,
        change1dPct: p.change_1d ?? null,
        change7dPct: p.change_7d ?? null,
        url: str(p.url),
      }));
    return { data, sources: [this.source(null, fetchedAt)] };
  }

  async getProtocolMetadata(idOrSlug: string): Promise<Sourced<ProtocolMetadata>> {
    const fetchedAt = nowIso();
    const slug = idOrSlug.trim().toLowerCase();
    if (!slug) throw new RovantaError("INVALID_INPUT", "A protocol slug is required.");
    const raw = await fetchJson(this.fetchImpl, `${BASE}/protocol/${encodeURIComponent(slug)}`, {
      timeoutMs: this.timeoutMs,
      notFound: { statuses: [400, 404], code: "DATA_UNAVAILABLE", message: `Protocol not found: "${slug}".` },
    });
    const p = parseUpstream(ProtocolSchema, raw, "DefiLlama /protocol");

    const tvlByChain: Record<string, number> = {};
    for (const [key, value] of Object.entries(p.currentChainTvls ?? {})) {
      if (value !== null && isChainKey(key)) tvlByChain[key] = value;
    }

    const fullHistory = (p.tvl ?? [])
      .filter((pt): pt is { date: number; totalLiquidityUSD: number } => pt.date !== null && pt.totalLiquidityUSD !== null)
      .map((pt) => ({ ts: pt.date, tvl: pt.totalLiquidityUSD }))
      .sort((a, b) => a.ts - b.ts);
    const recent = fullHistory.slice(-HISTORY_POINTS);

    const chainValues = Object.values(tvlByChain);
    const tvlUsd = chainValues.length
      ? chainValues.reduce((sum, v) => sum + v, 0)
      : (fullHistory[fullHistory.length - 1]?.tvl ?? null);
    const tokenSymbol = str(p.symbol);
    const audits = p.audits === null || p.audits === undefined ? null : String(p.audits);

    const data: ProtocolMetadata = {
      id: slug,
      name: p.name,
      category: str(p.category),
      chains: p.chains ?? Object.keys(tvlByChain),
      tvlUsd,
      change1dPct: p.change_1d ?? changePct(fullHistory, DAY_S),
      change7dPct: p.change_7d ?? changePct(fullHistory, 7 * DAY_S),
      url: str(p.url),
      description: str(p.description),
      twitter: str(p.twitter),
      github: (p.github ?? []).map(str).filter((g): g is string => g !== null),
      audits,
      tokenSymbol: tokenSymbol && tokenSymbol !== "-" ? tokenSymbol : null,
      tokenAssetId: str(p.gecko_id),
      tvlByChain,
      tvlHistory: recent.map((pt) => ({ date: new Date(pt.ts * 1000).toISOString(), tvlUsd: pt.tvl })),
    };
    return { data, sources: [this.source(slug, fetchedAt)] };
  }

  private async getList(): Promise<ListItem[]> {
    if (this.listCache && this.now() - this.listCache.at < LIST_TTL_MS) return this.listCache.items;
    if (!this.listInflight) {
      this.listInflight = (async () => {
        const raw = await fetchJson(this.fetchImpl, `${BASE}/protocols`, { timeoutMs: this.timeoutMs });
        const items = parseUpstream(ListSchema, raw, "DefiLlama /protocols");
        this.listCache = { at: this.now(), items };
        return items;
      })().finally(() => {
        this.listInflight = null;
      });
    }
    return this.listInflight;
  }

  private source(slug: string | null, fetchedAt: string): SourceRef {
    return {
      provider: this.id,
      name: this.name,
      url: slug ? `https://defillama.com/protocol/${encodeURIComponent(slug)}` : "https://defillama.com",
      fetchedAt,
    };
  }
}
