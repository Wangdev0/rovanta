import { TokenMetadataSchema } from "../../data/schemas";
import { defineTool } from "../define";
import { TokenInputSchema, tokenLabel, toTokenRef } from "./token-input";

export const getTokenMetadataTool = defineTool({
  name: "get_token_metadata",
  description:
    "Read descriptive metadata for one token: name, symbol, decimals, chain, contract address, assetId, description, website, categories and total supply (raw string). Identify the token with assetId, symbol, or chain+address (at least one of assetId, symbol or address is required). When chain+address is given for a chain with on-chain support, metadata is read directly from the contract. Null fields are unknown, not zero.",
  category: "market",
  activityLabel: "Reading token metadata",
  input: TokenInputSchema,
  output: TokenMetadataSchema,
  async run(input, ctx) {
    const ref = toTokenRef(input);
    if (ref.chain && ref.address && ctx.data.onchain.supportedChains().includes(ref.chain)) {
      return ctx.data.onchain.getTokenMetadata(ref.chain, ref.address);
    }
    return ctx.data.market.getTokenMetadata(ref);
  },
  summarize(output, input) {
    const name = output.name ?? tokenLabel(input);
    const symbol = output.symbol ? ` (${output.symbol})` : "";
    const chain = output.chain ? ` on ${output.chain}` : "";
    return `Read metadata for ${name}${symbol}${chain}`;
  },
});
