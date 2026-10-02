import { z } from "zod";
import { ProtocolSummarySchema } from "../../data/schemas";
import { SearchQuerySchema } from "../../security/validators";
import { defineTool } from "../define";
import { UNTRUSTED_NOTE } from "./shared";

export const searchProtocolsTool = defineTool({
  name: "search_protocols",
  description:
    "Search DeFi protocols by name or keyword. Returns up to `limit` protocol summaries (id/slug, name, category, chains, TVL in USD, 1d/7d TVL change %, website). Use the returned id as the `protocol` argument of get_protocol_metadata. " +
    UNTRUSTED_NOTE,
  category: "protocol",
  activityLabel: "Searching protocol data",
  input: z.object({
    query: SearchQuerySchema.describe("Protocol name or keyword, e.g. \"uniswap\""),
    limit: z.number().int().min(1).max(10).default(5).describe("Maximum results to return (1-10)"),
  }),
  output: z.object({ results: z.array(ProtocolSummarySchema) }),
  async run(input, ctx) {
    const res = await ctx.data.protocol.searchProtocols(input.query, input.limit);
    return { data: { results: res.data.slice(0, input.limit) }, sources: res.sources };
  },
  summarize(output, input) {
    const n = output.results.length;
    return `${n} protocol${n === 1 ? "" : "s"} matched "${input.query}"`;
  },
});
