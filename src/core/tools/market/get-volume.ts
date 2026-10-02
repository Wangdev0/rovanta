import { z } from "zod";
import { VolumeDataSchema } from "../../data/schemas";
import { defineTool } from "../define";
import { formatUsd } from "./format";
import { TokenInputShape, tokenLabel, toTokenRef } from "./token-input";

export const getVolumeTool = defineTool({
  name: "get_volume",
  description:
    "Get trading volume for one token: the latest 24h USD volume plus daily USD volume history for the last `days` days (oldest first), with the provider timestamp (asOf). Identify the token with assetId, symbol, or chain+address (at least one of assetId, symbol or address is required). volume24hUsd is null when unknown; history contains only days the provider reported.",
  category: "market",
  activityLabel: "Checking trading volume",
  input: z.object({
    ...TokenInputShape,
    days: z.number().int().min(1).max(90).default(7).describe("Number of days of daily volume history (1-90)."),
  }),
  output: VolumeDataSchema,
  async run(input, ctx) {
    return ctx.data.market.getVolume(toTokenRef(input), input.days);
  },
  summarize(output, input) {
    const points = output.history.length;
    return `${tokenLabel(input)} 24h volume ${formatUsd(output.volume24hUsd)} (${points} daily point${points === 1 ? "" : "s"} over ${input.days}d)`;
  },
});
