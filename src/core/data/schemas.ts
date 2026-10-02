import { z } from "zod";

/**
 * Domain models shared by data providers, tools and the UI.
 * Unknown values are `null`, never guessed.
 */

export const SourceRefSchema = z.object({
  provider: z.string(),
  name: z.string(),
  url: z.string().url().optional(),
  fetchedAt: z.string(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const TokenRefSchema = z
  .object({
    /** Chain slug, e.g. "ethereum", "robinhood". */
    chain: z.string().min(1).max(64).optional(),
    /** Contract address on `chain`. */
    address: z.string().min(1).max(128).optional(),
    /** CoinGecko-style asset id, e.g. "ethereum". */
    assetId: z.string().min(1).max(128).optional(),
    symbol: z.string().min(1).max(32).optional(),
  })
  .refine((v) => v.address || v.assetId || v.symbol, {
    message: "Provide at least one of address, assetId or symbol",
  });
export type TokenRef = z.infer<typeof TokenRefSchema>;

export const TokenSearchResultSchema = z.object({
  assetId: z.string().nullable(),
  name: z.string(),
  symbol: z.string(),
  chain: z.string().nullable(),
  address: z.string().nullable(),
  marketCapRank: z.number().nullable(),
  source: z.string(),
});
export type TokenSearchResult = z.infer<typeof TokenSearchResultSchema>;

export const TokenMetadataSchema = z.object({
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().int().nullable(),
  chain: z.string().nullable(),
  address: z.string().nullable(),
  assetId: z.string().nullable(),
  description: z.string().nullable(),
  website: z.string().nullable(),
  categories: z.array(z.string()),
  totalSupply: z.string().nullable(),
});
export type TokenMetadata = z.infer<typeof TokenMetadataSchema>;

export const TokenPriceSchema = z.object({
  priceUsd: z.number().nullable(),
  change24hPct: z.number().nullable(),
  asOf: z.string(),
});
export type TokenPrice = z.infer<typeof TokenPriceSchema>;

export const MarketDataSchema = z.object({
  priceUsd: z.number().nullable(),
  marketCapUsd: z.number().nullable(),
  fullyDilutedValuationUsd: z.number().nullable(),
  volume24hUsd: z.number().nullable(),
  change24hPct: z.number().nullable(),
  change7dPct: z.number().nullable(),
  circulatingSupply: z.number().nullable(),
  totalSupply: z.number().nullable(),
  athUsd: z.number().nullable(),
  asOf: z.string(),
});
export type MarketData = z.infer<typeof MarketDataSchema>;

export const VolumeDataSchema = z.object({
  volume24hUsd: z.number().nullable(),
  /** Daily volume points, oldest first. */
  history: z.array(z.object({ date: z.string(), volumeUsd: z.number() })),
  asOf: z.string(),
});
export type VolumeData = z.infer<typeof VolumeDataSchema>;

export const LiquidityPoolSchema = z.object({
  dex: z.string(),
  chain: z.string(),
  pairAddress: z.string(),
  baseSymbol: z.string(),
  quoteSymbol: z.string(),
  liquidityUsd: z.number().nullable(),
  volume24hUsd: z.number().nullable(),
  priceUsd: z.number().nullable(),
  txns24h: z.object({ buys: z.number(), sells: z.number() }).nullable(),
  pairCreatedAt: z.string().nullable(),
  url: z.string().nullable(),
});
export type LiquidityPool = z.infer<typeof LiquidityPoolSchema>;

export const LiquidityDataSchema = z.object({
  totalLiquidityUsd: z.number().nullable(),
  pools: z.array(LiquidityPoolSchema),
  asOf: z.string(),
});
export type LiquidityData = z.infer<typeof LiquidityDataSchema>;

export const ProtocolSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  chains: z.array(z.string()),
  tvlUsd: z.number().nullable(),
  change1dPct: z.number().nullable(),
  change7dPct: z.number().nullable(),
  url: z.string().nullable(),
});
export type ProtocolSummary = z.infer<typeof ProtocolSummarySchema>;

export const ProtocolMetadataSchema = ProtocolSummarySchema.extend({
  description: z.string().nullable(),
  twitter: z.string().nullable(),
  github: z.array(z.string()),
  audits: z.string().nullable(),
  tokenSymbol: z.string().nullable(),
  tokenAssetId: z.string().nullable(),
  tvlByChain: z.record(z.string(), z.number()),
  /** Recent daily TVL points, oldest first. */
  tvlHistory: z.array(z.object({ date: z.string(), tvlUsd: z.number() })),
});
export type ProtocolMetadata = z.infer<typeof ProtocolMetadataSchema>;

export const ChainStatusSchema = z.object({
  chain: z.string(),
  chainId: z.number().int().nullable(),
  configured: z.boolean(),
  reachable: z.boolean(),
  latestBlock: z.string().nullable(),
  latestBlockTime: z.string().nullable(),
  gasPriceGwei: z.number().nullable(),
  rpcLatencyMs: z.number().nullable(),
});
export type ChainStatus = z.infer<typeof ChainStatusSchema>;

export const BlockSchema = z.object({
  number: z.string(),
  hash: z.string(),
  timestamp: z.string(),
  transactionCount: z.number().int(),
  gasUsed: z.string(),
  gasLimit: z.string(),
});
export type Block = z.infer<typeof BlockSchema>;

export const TransactionSchema = z.object({
  hash: z.string(),
  chain: z.string(),
  blockNumber: z.string().nullable(),
  timestamp: z.string().nullable(),
  from: z.string(),
  to: z.string().nullable(),
  /** Native value in wei, decimal string. */
  value: z.string(),
  status: z.enum(["success", "reverted", "pending", "unknown"]),
  method: z.string().nullable(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const TokenBalanceSchema = z.object({
  tokenAddress: z.string(),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  decimals: z.number().int().nullable(),
  /** Raw integer balance, decimal string. */
  raw: z.string(),
  /** Human-readable balance using decimals, or null if decimals unknown. */
  formatted: z.string().nullable(),
});
export type TokenBalance = z.infer<typeof TokenBalanceSchema>;

export const NativeBalanceSchema = z.object({
  address: z.string(),
  chain: z.string(),
  symbol: z.string(),
  raw: z.string(),
  formatted: z.string(),
});
export type NativeBalance = z.infer<typeof NativeBalanceSchema>;

export const WalletActivitySchema = z.object({
  address: z.string(),
  chain: z.string(),
  native: NativeBalanceSchema.nullable(),
  tokens: z.array(TokenBalanceSchema),
  recentTransactions: z.array(TransactionSchema),
  /** Which parts could not be retrieved, e.g. "tokens: explorer API not configured". */
  gaps: z.array(z.string()),
});
export type WalletActivity = z.infer<typeof WalletActivitySchema>;

export const ContractInfoSchema = z.object({
  address: z.string(),
  chain: z.string(),
  isContract: z.boolean(),
  bytecodeSize: z.number().int().nullable(),
  verified: z.boolean().nullable(),
  name: z.string().nullable(),
  compiler: z.string().nullable(),
  token: TokenMetadataSchema.nullable(),
});
export type ContractInfo = z.infer<typeof ContractInfoSchema>;

export const WebDocumentSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  publishedAt: z.string().nullable(),
});
export type WebDocument = z.infer<typeof WebDocumentSchema>;
