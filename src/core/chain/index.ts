import type { ChainEnv } from "./config";
import type { EvmAdapterDeps } from "./evm-adapter";
import { createGenericEvmAdapters } from "./generic";
import { RobinhoodChainAdapter } from "./robinhood";
import type { ChainAdapter } from "./types";

export type { ChainAdapter, ChainConfig } from "./types";
export { parseChainId, parseEndpointUrl, type ChainEnv } from "./config";
export {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_RPC_TIMEOUT_MS,
  EvmChainAdapter,
  MAX_HISTORY_LIMIT,
  viemClientFactory,
  type EvmAdapterDeps,
  type EvmClientFactory,
  type EvmReadClient,
  type RpcBlock,
  type RpcTransaction,
} from "./evm-adapter";
export { ROBINHOOD_ENV, RobinhoodChainAdapter, robinhoodConfigFromEnv } from "./robinhood";
export { GENERIC_EVM_CHAINS, createGenericEvmAdapters, genericEvmConfigsFromEnv } from "./generic";
export { createOnChainProvider } from "./onchain-provider";

/** Robinhood Chain is always listed (possibly unconfigured); other chains only when configured. */
export function createChainAdaptersFromEnv(env: ChainEnv = process.env, deps: EvmAdapterDeps = {}): ChainAdapter[] {
  return [new RobinhoodChainAdapter(env, deps), ...createGenericEvmAdapters(env, deps)];
}
