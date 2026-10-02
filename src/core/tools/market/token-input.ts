import { z } from "zod";
import { RovantaError } from "../../errors";
import type { TokenRef } from "../../data/schemas";
import { isEvmAddress } from "../../security/validators";

const NON_EVM_CHAINS: ReadonlySet<string> = new Set([
  "solana",
  "bitcoin",
  "tron",
  "ton",
  "sui",
  "aptos",
  "near",
  "cosmos",
  "osmosis",
  "cardano",
  "polkadot",
  "stellar",
  "ripple",
  "xrp",
  "algorand",
  "tezos",
  "hedera",
  "starknet",
]);

export const TokenInputShape = {
  assetId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe("Market data asset id (CoinGecko-style), e.g. \"ethereum\" or \"usd-coin\". Most precise identifier."),
  symbol: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .optional()
    .describe("Ticker symbol, e.g. \"ETH\". Can be ambiguous; prefer assetId or chain+address when known."),
  chain: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .optional()
    .describe("Chain slug the address lives on, e.g. \"ethereum\", \"base\", \"robinhood\". Use together with address."),
  address: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe("Token contract address on `chain`. EVM addresses must be 0x-prefixed 40-hex-character strings."),
};

export const TokenInputSchema = z.object(TokenInputShape);
export type TokenInput = z.output<typeof TokenInputSchema>;

function isEvmLikeChain(chain: string | undefined, address: string): boolean {
  if (chain) return !NON_EVM_CHAINS.has(chain.toLowerCase());
  return address.toLowerCase().startsWith("0x");
}

export function toTokenRef(input: TokenInput): TokenRef {
  const { assetId, symbol, chain, address } = input;
  if (!assetId && !symbol && !address) {
    throw new RovantaError("INVALID_TOKEN", "Provide assetId, symbol or address");
  }
  if (address && isEvmLikeChain(chain, address) && !isEvmAddress(address)) {
    throw new RovantaError("INVALID_TOKEN", "Address is not a valid 0x-prefixed 20-byte EVM address");
  }
  const ref: TokenRef = {};
  if (assetId) ref.assetId = assetId;
  if (symbol) ref.symbol = symbol;
  if (chain) ref.chain = chain;
  if (address) ref.address = address;
  return ref;
}

export function tokenLabel(input: TokenInput): string {
  return input.symbol ?? input.assetId ?? input.address ?? "token";
}
