import { z } from "zod";
import { ChainStatusSchema } from "../../data/schemas";
import { defineTool } from "../define";
import { UNTRUSTED_NOTE, chainField } from "./shared";

export const getChainStatusTool = defineTool({
  name: "get_chain_status",
  description:
    "Check a chain's RPC status: whether an RPC is configured and reachable, chain id, latest block number and time, gas price in gwei, and RPC latency in ms. " +
    UNTRUSTED_NOTE,
  category: "onchain",
  activityLabel: "Checking chain status",
  input: z.object({ chain: chainField() }),
  output: ChainStatusSchema,
  async run(input, ctx) {
    const res = await ctx.data.onchain.getChainStatus(input.chain);
    return { data: res.data, sources: res.sources };
  },
  summarize(output) {
    if (!output.configured) return `${output.chain}: RPC not configured`;
    if (!output.reachable) return `${output.chain}: RPC unreachable`;
    return `${output.chain}: latest block ${output.latestBlock ?? "unknown"}`;
  },
});
