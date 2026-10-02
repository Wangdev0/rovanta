import { parseChainId, parseEndpointUrl, parseSymbol, type ChainEnv } from "./config";
import { EvmChainAdapter, type EvmAdapterDeps } from "./evm-adapter";
import type { ChainConfig } from "./types";

export const ROBINHOOD_ENV = {
  rpcUrl: "ROBINHOOD_CHAIN_RPC_URL",
  chainId: "ROBINHOOD_CHAIN_ID",
  explorerUrl: "ROBINHOOD_CHAIN_EXPLORER_URL",
  explorerApiUrl: "ROBINHOOD_CHAIN_EXPLORER_API_URL",
  nativeSymbol: "ROBINHOOD_CHAIN_NATIVE_SYMBOL",
} as const;

/** No endpoint or chain id defaults: everything comes from the environment. */
export function robinhoodConfigFromEnv(env: ChainEnv = process.env): ChainConfig {
  return {
    slug: "robinhood",
    name: "Robinhood Chain",
    chainId: parseChainId(env[ROBINHOOD_ENV.chainId]),
    rpcUrl: parseEndpointUrl(env[ROBINHOOD_ENV.rpcUrl]),
    explorerUrl: parseEndpointUrl(env[ROBINHOOD_ENV.explorerUrl]),
    explorerApiUrl: parseEndpointUrl(env[ROBINHOOD_ENV.explorerApiUrl]),
    nativeSymbol: parseSymbol(env[ROBINHOOD_ENV.nativeSymbol], "ETH"),
    nativeDecimals: 18,
  };
}

export class RobinhoodChainAdapter extends EvmChainAdapter {
  constructor(source: ChainEnv | ChainConfig = process.env, deps: EvmAdapterDeps = {}) {
    super(isChainConfig(source) ? source : robinhoodConfigFromEnv(source), {
      envVars: { rpcUrl: ROBINHOOD_ENV.rpcUrl, explorerApiUrl: ROBINHOOD_ENV.explorerApiUrl },
      ...deps,
    });
  }
}

function isChainConfig(value: ChainEnv | ChainConfig): value is ChainConfig {
  return typeof (value as ChainConfig).slug === "string" && typeof (value as ChainConfig).nativeDecimals === "number";
}
