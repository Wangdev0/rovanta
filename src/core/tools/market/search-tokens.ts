import { z } from "zod";
import { TokenSearchResultSchema } from "../../data/schemas";
import { defineTool } from "../define";

export const searchTokensTool = defineTool({
  name: "search_tokens",
  description:
    "Search market data providers for tokens matching a name, symbol or contract address. Returns up to `limit` candidates with assetId, name, symbol, chain, address, marketCapRank and the source provider. Use it to resolve an ambiguous name or symbol into an assetId or chain+address before calling other token tools. Fields that are null are unknown to the provider.",
  category: "market",
  activityLabel: "Searching token data",
  input: z.object({
    query: z.string().trim().min(1).max(120).describe("Token name, ticker symbol or contract address to search for."),
    limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of results to return (1-10)."),
  }),
  output: z.object({ results: z.array(TokenSearchResultSchema) }),
  async run(input, ctx) {
    const { data, sources } = await ctx.data.market.searchTokens(input.query, input.limit);
    return { data: { results: data }, sources };
  },
  summarize(output, input) {
    const n = output.results.length;
    return `Found ${n} token${n === 1 ? "" : "s"} matching '${input.query}'`;
  },
});
