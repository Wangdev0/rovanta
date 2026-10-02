import { z } from "zod";
import { RovantaError, toRovantaError } from "../../errors";
import {
  LiquidityDataSchema,
  MarketDataSchema,
  type LiquidityData,
  type MarketData,
  type SourceRef,
} from "../../data/schemas";
import type { Sourced } from "../../data/types";
import { defineTool } from "../define";
import type { ToolContext } from "../types";
import { formatUsd } from "./format";
import { TokenInputSchema, tokenLabel, toTokenRef, type TokenInput } from "./token-input";

const METRICS = ["price", "market_cap", "volume", "liquidity", "change_24h", "change_7d"] as const;

const CompareRowSchema = z.object({
  label: z.string(),
  assetId: z.string().nullable(),
  symbol: z.string().nullable(),
  priceUsd: z.number().nullable(),
  marketCapUsd: z.number().nullable(),
  volume24hUsd: z.number().nullable(),
  liquidityUsd: z.number().nullable(),
  change24hPct: z.number().nullable(),
  change7dPct: z.number().nullable(),
  error: z.string().nullable(),
});
type CompareRow = z.infer<typeof CompareRowSchema>;

interface RowResult {
  row: CompareRow;
  sources: SourceRef[];
  failed: boolean;
}

async function fetchValidated<T>(
  load: () => Promise<Sourced<T>>,
  schema: z.ZodType<T>,
  what: string,
): Promise<Sourced<T>> {
  const result = await load();
  const parsed = schema.safeParse(result?.data);
  if (!parsed.success) {
    throw new RovantaError("MALFORMED_TOOL_RESULT", `${what} returned data that failed validation`);
  }
  return { data: parsed.data, sources: result.sources ?? [] };
}

function describeError(reason: unknown): string {
  const error = toRovantaError(reason, "DATA_UNAVAILABLE");
  return `${error.code}: ${error.message}`;
}

async function compareOne(input: TokenInput, withLiquidity: boolean, ctx: ToolContext): Promise<RowResult> {
  const row: CompareRow = {
    label: tokenLabel(input),
    assetId: input.assetId ?? null,
    symbol: input.symbol ?? null,
    priceUsd: null,
    marketCapUsd: null,
    volume24hUsd: null,
    liquidityUsd: null,
    change24hPct: null,
    change7dPct: null,
    error: null,
  };

  let ref;
  try {
    ref = toTokenRef(input);
  } catch (error) {
    return { row: { ...row, error: describeError(error) }, sources: [], failed: true };
  }

  const [market, liquidity] = await Promise.allSettled([
    fetchValidated<MarketData>(() => ctx.data.market.getMarketData(ref), MarketDataSchema, "Market data"),
    withLiquidity
      ? fetchValidated<LiquidityData>(() => ctx.data.liquidity.getLiquidity(ref), LiquidityDataSchema, "Liquidity data")
      : Promise.resolve(null),
  ]);

  const sources: SourceRef[] = [];
  const errors: string[] = [];

  if (market.status === "fulfilled") {
    const m = market.value.data;
    row.priceUsd = m.priceUsd;
    row.marketCapUsd = m.marketCapUsd;
    row.volume24hUsd = m.volume24hUsd;
    row.change24hPct = m.change24hPct;
    row.change7dPct = m.change7dPct;
    sources.push(...market.value.sources);
  } else {
    errors.push(`market data ${describeError(market.reason)}`);
  }

  if (liquidity.status === "fulfilled") {
    if (liquidity.value) {
      row.liquidityUsd = liquidity.value.data.totalLiquidityUsd;
      sources.push(...liquidity.value.sources);
    }
  } else {
    errors.push(`liquidity ${describeError(liquidity.reason)}`);
  }

  row.error = errors.length > 0 ? errors.join("; ") : null;
  const failed = market.status === "rejected" && (!withLiquidity || liquidity.status === "rejected");
  return { row, sources, failed };
}

export const compareAssetsTool = defineTool({
  name: "compare_assets",
  description:
    "Fetch the same market fields for 2-5 tokens side by side: USD price, market cap, 24h volume, 24h and 7d percentage change, and (only when `metrics` includes \"liquidity\") total DEX liquidity. Returns one row per asset in the order given, plus comparedAt. Null values are unknown. If data for an asset could not be retrieved, its row has `error` set (\"CODE: message\") and the other rows are still returned. Does not rank assets or make recommendations.",
  category: "analysis",
  activityLabel: "Comparing assets",
  input: z.object({
    assets: z
      .array(TokenInputSchema)
      .min(2)
      .max(5)
      .describe("2-5 tokens to compare. Each needs at least one of assetId, symbol or address."),
    metrics: z
      .array(z.enum(METRICS))
      .optional()
      .describe("Fields of interest. Liquidity is only fetched when \"liquidity\" is included; market fields are always returned."),
  }),
  output: z.object({
    rows: z.array(CompareRowSchema),
    comparedAt: z.string(),
  }),
  async run(input, ctx) {
    const withLiquidity = input.metrics?.includes("liquidity") ?? false;
    const settled = await Promise.allSettled(input.assets.map((asset) => compareOne(asset, withLiquidity, ctx)));
    const results: RowResult[] = settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : {
            row: {
              label: tokenLabel(input.assets[i]),
              assetId: input.assets[i].assetId ?? null,
              symbol: input.assets[i].symbol ?? null,
              priceUsd: null,
              marketCapUsd: null,
              volume24hUsd: null,
              liquidityUsd: null,
              change24hPct: null,
              change7dPct: null,
              error: describeError(s.reason),
            },
            sources: [],
            failed: true,
          },
    );

    if (results.every((r) => r.failed)) {
      const detail = results.map((r) => `${r.row.label}: ${r.row.error}`).join("; ");
      throw new RovantaError("DATA_UNAVAILABLE", `No data could be retrieved for any asset (${detail})`);
    }

    return {
      data: { rows: results.map((r) => r.row), comparedAt: ctx.now().toISOString() },
      sources: results.flatMap((r) => r.sources),
    };
  },
  summarize(output) {
    const ok = output.rows.filter((r) => r.priceUsd !== null || r.marketCapUsd !== null || r.liquidityUsd !== null);
    const parts = output.rows.map((r) => `${r.label} ${formatUsd(r.priceUsd)}`).join(", ");
    return `Compared ${output.rows.length} assets (${ok.length} with data): ${parts}`;
  },
});
