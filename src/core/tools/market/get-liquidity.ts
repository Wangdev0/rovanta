import { LiquidityDataSchema } from "../../data/schemas";
import { defineTool } from "../define";
import { formatUsd } from "./format";
import { TokenInputSchema, tokenLabel, toTokenRef } from "./token-input";

export const getLiquidityTool = defineTool({
  name: "get_liquidity",
  description:
    "Get on-chain DEX liquidity for one token: total USD liquidity across discovered pools and the list of pools (dex, chain, pair address, base/quote symbols, pool liquidity, 24h volume, price, 24h buy/sell transaction counts, creation time, url), with the provider timestamp (asOf). Identify the token with assetId, symbol, or chain+address (chain+address is most reliable; at least one of assetId, symbol or address is required). Null values are unknown; an empty pool list means no pools were found by the provider.",
  category: "liquidity",
  activityLabel: "Checking liquidity",
  input: TokenInputSchema,
  output: LiquidityDataSchema,
  async run(input, ctx) {
    return ctx.data.liquidity.getLiquidity(toTokenRef(input));
  },
  summarize(output, input) {
    const n = output.pools.length;
    const pools = `${n} pool${n === 1 ? "" : "s"}`;
    if (output.totalLiquidityUsd === null) return `${tokenLabel(input)}: liquidity unknown across ${pools}`;
    return `${tokenLabel(input)}: ${formatUsd(output.totalLiquidityUsd)} total liquidity across ${pools}`;
  },
});
