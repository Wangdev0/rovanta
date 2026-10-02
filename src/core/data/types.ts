import type {
  Block,
  ChainStatus,
  ContractInfo,
  LiquidityData,
  MarketData,
  NativeBalance,
  ProtocolMetadata,
  ProtocolSummary,
  SourceRef,
  TokenBalance,
  TokenMetadata,
  TokenPrice,
  TokenRef,
  TokenSearchResult,
  Transaction,
  VolumeData,
  WebDocument,
} from "./schemas";

/** Every provider result carries the sources it came from. */
export interface Sourced<T> {
  data: T;
  sources: SourceRef[];
}

export interface ProviderMeta {
  readonly id: string;
  readonly name: string;
  /** False when required configuration (e.g. an API key) is missing. */
  readonly enabled: boolean;
}

export interface MarketDataProvider extends ProviderMeta {
  searchTokens(query: string, limit?: number): Promise<Sourced<TokenSearchResult[]>>;
  getTokenMetadata(token: TokenRef): Promise<Sourced<TokenMetadata>>;
  getTokenPrice(token: TokenRef): Promise<Sourced<TokenPrice>>;
  getMarketData(token: TokenRef): Promise<Sourced<MarketData>>;
  getVolume(token: TokenRef, days?: number): Promise<Sourced<VolumeData>>;
}

export interface LiquidityDataProvider extends ProviderMeta {
  getLiquidity(token: TokenRef): Promise<Sourced<LiquidityData>>;
  searchPairs(query: string, limit?: number): Promise<Sourced<LiquidityData>>;
}

export interface ProtocolDataProvider extends ProviderMeta {
  searchProtocols(query: string, limit?: number): Promise<Sourced<ProtocolSummary[]>>;
  getProtocolMetadata(idOrSlug: string): Promise<Sourced<ProtocolMetadata>>;
}

export interface OnChainDataProvider extends ProviderMeta {
  /** Chain slugs this provider can serve (configured or not). */
  supportedChains(): string[];
  getChainStatus(chain: string): Promise<Sourced<ChainStatus>>;
  getBlock(chain: string, blockNumber?: string): Promise<Sourced<Block>>;
  getTransaction(chain: string, hash: string): Promise<Sourced<Transaction>>;
  getNativeBalance(chain: string, address: string): Promise<Sourced<NativeBalance>>;
  getTokenBalances(chain: string, address: string): Promise<Sourced<TokenBalance[]>>;
  getAddressTransactions(chain: string, address: string, limit?: number): Promise<Sourced<Transaction[]>>;
  getContractInfo(chain: string, address: string): Promise<Sourced<ContractInfo>>;
  getTokenMetadata(chain: string, address: string): Promise<Sourced<TokenMetadata>>;
}

export interface WebResearchProvider extends ProviderMeta {
  search(query: string, limit?: number): Promise<Sourced<WebDocument[]>>;
}

/**
 * The full set of data services available to research tools.
 * The CLI uses the direct adapters from `createServerDataServices`.
 */
export interface DataServices {
  market: MarketDataProvider;
  liquidity: LiquidityDataProvider;
  protocol: ProtocolDataProvider;
  onchain: OnChainDataProvider;
  web: WebResearchProvider;
}

export type DataServiceName = keyof DataServices;
