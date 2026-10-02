import { TokenPriceSchema } from "../../data/schemas";
import { defineTool } from "../define";
import { formatPct, formatUsd } from "./format";
import { TokenInputSchema, tokenLabel, toTokenRef } from "./token-input";

export const getTokenPriceTool = defineTool({
  name: "get_token_price",
  description:
    "Get the current USD price of one token and its 24h percentage change, with the provider timestamp (asOf). Identify the token with assetId, symbol, or chain+address (at least one of assetId, symbol or address is required). priceUsd or change24hPct are null when the provider does not report them, meaning unknown.",
  category: "market",
  activityLabel: "Checking token price",
  input: TokenInputSchema,
  output: TokenPriceSchema,
  async run(input, ctx) {
    return ctx.data.market.getTokenPrice(toTokenRef(input));
  },
  summarize(output, input) {
    return `${tokenLabel(input)} price ${formatUsd(output.priceUsd)} (24h ${formatPct(output.change24hPct)})`;
  },
});
