import { MarketDataSchema } from "../../data/schemas";
import { defineTool } from "../define";
import { formatUsd } from "./format";
import { TokenInputSchema, tokenLabel, toTokenRef } from "./token-input";

export const getMarketDataTool = defineTool({
  name: "get_market_data",
  description:
    "Get a market snapshot for one token: USD price, market cap, fully diluted valuation, 24h volume, 24h and 7d percentage change, circulating and total supply, all-time high, and the provider timestamp (asOf). Identify the token with assetId, symbol, or chain+address (at least one of assetId, symbol or address is required). Any null field is unknown to the provider, not zero.",
  category: "market",
  activityLabel: "Checking market data",
  input: TokenInputSchema,
  output: MarketDataSchema,
  async run(input, ctx) {
    return ctx.data.market.getMarketData(toTokenRef(input));
  },
  summarize(output, input) {
    return `${tokenLabel(input)} price ${formatUsd(output.priceUsd)}, market cap ${formatUsd(output.marketCapUsd)}, 24h volume ${formatUsd(output.volume24hUsd)}`;
  },
});
