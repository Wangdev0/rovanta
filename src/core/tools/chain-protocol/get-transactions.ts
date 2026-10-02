import { z } from "zod";
import { RovantaError } from "../../errors";
import { TransactionSchema } from "../../data/schemas";
import { TxHashSchema } from "../../security/validators";
import { defineTool } from "../define";
import { UNTRUSTED_NOTE, addressField, chainField, requireWallet, shortAddress } from "./shared";

export const getTransactionsTool = defineTool({
  name: "get_transactions",
  description:
    "Look up on-chain transactions. Provide exactly one of `hash` (returns that single transaction) or `address` (returns up to `limit` recent transactions involving the address). Each transaction has hash, block number, timestamp, from, to, native value in wei (decimal string), status and method. " +
    UNTRUSTED_NOTE,
  category: "onchain",
  activityLabel: "Checking recent transactions",
  input: z.object({
    chain: chainField(),
    hash: TxHashSchema.optional().describe("Transaction hash (0x-prefixed 32-byte hex). Omit when using address"),
    address: addressField("Wallet or contract address").optional(),
    limit: z.number().int().min(1).max(25).default(10).describe("Maximum transactions for an address lookup (1-25)"),
  }),
  output: z.object({ transactions: z.array(TransactionSchema) }),
  async run(input, ctx) {
    const hasHash = input.hash !== undefined;
    const hasAddress = input.address !== undefined && input.address.trim() !== "";
    if (hasHash === hasAddress) {
      throw new RovantaError("INVALID_INPUT", "Provide exactly one of hash or address");
    }
    if (hasHash) {
      const res = await ctx.data.onchain.getTransaction(input.chain, input.hash as string);
      return { data: { transactions: [res.data] }, sources: res.sources };
    }
    const address = requireWallet(input.address as string);
    const res = await ctx.data.onchain.getAddressTransactions(input.chain, address, input.limit);
    const transactions = Array.isArray(res.data) ? res.data.slice(0, input.limit) : res.data;
    return { data: { transactions }, sources: res.sources };
  },
  summarize(output, input) {
    if (input.hash) {
      const tx = output.transactions[0];
      return `Transaction ${shortAddress(input.hash)} on ${input.chain}: ${tx?.status ?? "unknown"}`;
    }
    const n = output.transactions.length;
    return `${n} recent transaction${n === 1 ? "" : "s"} for ${shortAddress(input.address ?? "")} on ${input.chain}`;
  },
});
