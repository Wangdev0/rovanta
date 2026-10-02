import { z } from "zod";
import { isRovantaError, toRovantaError } from "../../errors";
import { WalletActivitySchema, type SourceRef, type WalletActivity } from "../../data/schemas";
import { defineTool } from "../define";
import { UNTRUSTED_NOTE, addressField, chainField, requireWallet, shortAddress } from "./shared";

const RECENT_TX_LIMIT = 10;

function reasonMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export const getWalletActivityTool = defineTool({
  name: "get_wallet_activity",
  description:
    `Summarize a public wallet: native balance, ERC-20 token balances, and up to ${RECENT_TX_LIMIT} recent transactions. Parts that could not be retrieved are listed in \`gaps\` (e.g. "tokens: explorer API not configured") and left empty or null; a gap means unknown, not zero. ` +
    UNTRUSTED_NOTE,
  category: "onchain",
  activityLabel: "Checking wallet activity",
  input: z.object({
    chain: chainField(),
    address: addressField("Public wallet address"),
  }),
  output: WalletActivitySchema,
  async run(input, ctx) {
    const address = requireWallet(input.address);
    const { onchain } = ctx.data;
    const [native, tokens, txs] = await Promise.allSettled([
      onchain.getNativeBalance(input.chain, address),
      onchain.getTokenBalances(input.chain, address),
      onchain.getAddressTransactions(input.chain, address, RECENT_TX_LIMIT),
    ]);

    if (native.status === "rejected" && tokens.status === "rejected" && txs.status === "rejected") {
      const reasons = [native.reason, tokens.reason, txs.reason];
      throw reasons.find(isRovantaError) ?? toRovantaError(reasons[0], "DATA_UNAVAILABLE");
    }

    const gaps: string[] = [];
    const sources: SourceRef[] = [];
    const data: WalletActivity = {
      address,
      chain: input.chain,
      native: null,
      tokens: [],
      recentTransactions: [],
      gaps,
    };

    if (native.status === "fulfilled") {
      data.native = native.value.data;
      sources.push(...native.value.sources);
    } else {
      gaps.push(`native: ${reasonMessage(native.reason)}`);
    }
    if (tokens.status === "fulfilled") {
      data.tokens = tokens.value.data;
      sources.push(...tokens.value.sources);
    } else {
      gaps.push(`tokens: ${reasonMessage(tokens.reason)}`);
    }
    if (txs.status === "fulfilled") {
      data.recentTransactions = Array.isArray(txs.value.data) ? txs.value.data.slice(0, RECENT_TX_LIMIT) : txs.value.data;
      sources.push(...txs.value.sources);
    } else {
      gaps.push(`transactions: ${reasonMessage(txs.reason)}`);
    }

    return { data, sources };
  },
  summarize(output) {
    const balance = output.native ? `${output.native.formatted} ${output.native.symbol}` : "native balance unknown";
    const gapNote = output.gaps.length ? ` (${output.gaps.length} gap${output.gaps.length === 1 ? "" : "s"})` : "";
    return `${shortAddress(output.address)} on ${output.chain}: ${balance}, ${output.tokens.length} tokens, ${output.recentTransactions.length} recent txs${gapNote}`;
  },
});
