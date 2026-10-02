import type {
  Block,
  ChainStatus,
  ContractInfo,
  NativeBalance,
  TokenBalance,
  TokenMetadata,
  Transaction,
} from "../data/schemas";

export interface ChainConfig {
  /** Stable slug used across the app, e.g. "robinhood". */
  slug: string;
  name: string;
  chainId: number | null;
  rpcUrl: string | null;
  explorerUrl: string | null;
  /** Blockscout-compatible explorer API base, used for address history and token lists. */
  explorerApiUrl: string | null;
  nativeSymbol: string;
  nativeDecimals: number;
}

export interface ChainAdapter {
  readonly config: ChainConfig;
  readonly configured: boolean;
  getChainStatus(): Promise<ChainStatus>;
  getBlock(blockNumber?: bigint): Promise<Block>;
  getTransaction(hash: string): Promise<Transaction>;
  getBalance(address: string): Promise<NativeBalance>;
  getTokenBalance(address: string, tokenAddress: string): Promise<TokenBalance>;
  getTokenMetadata(tokenAddress: string): Promise<TokenMetadata>;
  /** Requires an explorer API; throws DATA_UNAVAILABLE otherwise. */
  getTokenBalances(address: string): Promise<TokenBalance[]>;
  /** Requires an explorer API; throws DATA_UNAVAILABLE otherwise. */
  getAddressTransactions(address: string, limit?: number): Promise<Transaction[]>;
  getContractInfo(address: string): Promise<ContractInfo>;
}
