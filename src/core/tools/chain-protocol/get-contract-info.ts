import { z } from "zod";
import { ContractInfoSchema } from "../../data/schemas";
import { defineTool } from "../define";
import { UNTRUSTED_NOTE, addressField, chainField, requireWallet, shortAddress } from "./shared";

export const getContractInfoTool = defineTool({
  name: "get_contract_info",
  description:
    "Inspect an address: whether it has deployed bytecode, bytecode size, explorer verification status, contract name, compiler, and ERC-20 token metadata when it is a token. Verification or a name does not imply the contract is safe. " +
    UNTRUSTED_NOTE,
  category: "onchain",
  activityLabel: "Inspecting contract",
  input: z.object({
    chain: chainField(),
    address: addressField("Contract address"),
  }),
  output: ContractInfoSchema,
  async run(input, ctx) {
    const address = requireWallet(input.address);
    const res = await ctx.data.onchain.getContractInfo(input.chain, address);
    return { data: res.data, sources: res.sources };
  },
  summarize(output) {
    const label = output.name ?? output.token?.symbol ?? shortAddress(output.address);
    if (!output.isContract) return `${shortAddress(output.address)} on ${output.chain}: not a contract`;
    const verified = output.verified === null ? "verification unknown" : output.verified ? "verified" : "unverified";
    return `${label} on ${output.chain}: contract, ${verified}`;
  },
});
