import { z } from "zod";
import { ProtocolMetadataSchema } from "../../data/schemas";
import { SlugSchema } from "../../security/validators";
import { defineTool } from "../define";
import { UNTRUSTED_NOTE } from "./shared";

export const TVL_HISTORY_POINTS = 30;

export const getProtocolMetadataTool = defineTool({
  name: "get_protocol_metadata",
  description:
    `Read metadata for one DeFi protocol: description, category, chains, TVL in USD (total and by chain), 1d/7d TVL change %, token symbol, audits, links, and the last ${TVL_HISTORY_POINTS} daily TVL points (oldest first). ` +
    UNTRUSTED_NOTE,
  category: "protocol",
  activityLabel: "Reading protocol metadata",
  input: z.object({
    protocol: SlugSchema.describe(
      "DefiLlama-style protocol slug, e.g. \"aave-v3\". Use search_protocols first if unsure of the slug",
    ),
  }),
  output: ProtocolMetadataSchema,
  async run(input, ctx) {
    const res = await ctx.data.protocol.getProtocolMetadata(input.protocol);
    const history = Array.isArray(res.data?.tvlHistory) ? res.data.tvlHistory.slice(-TVL_HISTORY_POINTS) : res.data?.tvlHistory;
    return { data: { ...res.data, tvlHistory: history }, sources: res.sources };
  },
  summarize(output) {
    const tvl = output.tvlUsd === null ? "TVL unknown" : `TVL $${Math.round(output.tvlUsd).toLocaleString("en-US")}`;
    return `${output.name}: ${tvl}`;
  },
});
