import { parseEndpointUrl, type ChainEnv } from "./config";
import { EvmChainAdapter, type EvmAdapterDeps } from "./evm-adapter";
import type { ChainConfig } from "./types";

export interface GenericChainDefinition {
  slug: string;
  name: string;
  chainId: number;
  nativeSymbol: string;
  env: { rpcUrl: string; explorerUrl: string; explorerApiUrl: string };
}

export const GENERIC_EVM_CHAINS: readonly GenericChainDefinition[] = [
  {
    slug: "ethereum",
    name: "Ethereum",
    chainId: 1,
    nativeSymbol: "ETH",
    env: {
      rpcUrl: "ETHEREUM_RPC_URL",
      explorerUrl: "ETHEREUM_EXPLORER_URL",
      explorerApiUrl: "ETHEREUM_EXPLORER_API_URL",
    },
  },
];

/** Only chains with a valid RPC URL in the environment are returned. */
export function genericEvmConfigsFromEnv(env: ChainEnv = process.env): ChainConfig[] {
  const configs: ChainConfig[] = [];
  for (const def of GENERIC_EVM_CHAINS) {
    const rpcUrl = parseEndpointUrl(env[def.env.rpcUrl]);
    if (!rpcUrl) continue;
    configs.push({
      slug: def.slug,
      name: def.name,
      chainId: def.chainId,
      rpcUrl,
      explorerUrl: parseEndpointUrl(env[def.env.explorerUrl]),
      explorerApiUrl: parseEndpointUrl(env[def.env.explorerApiUrl]),
      nativeSymbol: def.nativeSymbol,
      nativeDecimals: 18,
    });
  }
  return configs;
}

export function createGenericEvmAdapters(env: ChainEnv = process.env, deps: EvmAdapterDeps = {}): EvmChainAdapter[] {
  return genericEvmConfigsFromEnv(env).map((config) => {
    const def = GENERIC_EVM_CHAINS.find((d) => d.slug === config.slug);
    return new EvmChainAdapter(config, {
      envVars: def ? { rpcUrl: def.env.rpcUrl, explorerApiUrl: def.env.explorerApiUrl } : undefined,
      ...deps,
    });
  });
}
