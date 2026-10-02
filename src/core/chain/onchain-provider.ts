import type { SourceRef } from "../data/schemas";
import type { OnChainDataProvider } from "../data/types";
import { RovantaError } from "../errors";
import type { ChainAdapter } from "./types";

type LinkKind = "tx" | "address" | "block" | "token";

/**
 * Sources only ever reference the public explorer, never the RPC or explorer
 * API URL, which may embed an API key.
 */
function explorerLink(adapter: ChainAdapter, kind?: LinkKind, id?: string): string | undefined {
  const base = adapter.config.explorerUrl?.replace(/\/+$/, "");
  if (!base) return undefined;
  return kind && id ? `${base}/${kind}/${id}` : base;
}

function rpcSource(adapter: ChainAdapter, url?: string): SourceRef {
  const { slug, name } = adapter.config;
  return { provider: `rpc:${slug}`, name: `${name} RPC`, ...(url ? { url } : {}), fetchedAt: new Date().toISOString() };
}

function explorerSource(adapter: ChainAdapter, url?: string): SourceRef {
  const { slug, name } = adapter.config;
  return {
    provider: `explorer:${slug}`,
    name: `${name} explorer API`,
    ...(url ? { url } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

export function createOnChainProvider(adapters: ChainAdapter[]): OnChainDataProvider {
  const bySlug = new Map(adapters.map((adapter) => [adapter.config.slug, adapter]));

  const resolve = (chain: string): ChainAdapter => {
    const slug = typeof chain === "string" ? chain.trim().toLowerCase() : "";
    const adapter = bySlug.get(slug);
    if (!adapter) {
      const supported = [...bySlug.keys()].join(", ") || "none";
      throw new RovantaError("INVALID_INPUT", `Unknown chain "${String(chain)}". Supported chains: ${supported}.`);
    }
    return adapter;
  };

  return {
    id: "onchain",
    name: "On-chain RPC",
    enabled: adapters.some((adapter) => adapter.configured),

    supportedChains: () => [...bySlug.keys()],

    async getChainStatus(chain) {
      const adapter = resolve(chain);
      return { data: await adapter.getChainStatus(), sources: [rpcSource(adapter, explorerLink(adapter))] };
    },

    async getBlock(chain, blockNumber) {
      const adapter = resolve(chain);
      let n: bigint | undefined;
      if (blockNumber !== undefined) {
        const trimmed = String(blockNumber).trim();
        if (!/^\d+$/.test(trimmed)) {
          throw new RovantaError("INVALID_INPUT", "Block number must be a non-negative integer.");
        }
        n = BigInt(trimmed);
      }
      const data = await adapter.getBlock(n);
      return { data, sources: [rpcSource(adapter, explorerLink(adapter, "block", data.number))] };
    },

    async getTransaction(chain, hash) {
      const adapter = resolve(chain);
      const data = await adapter.getTransaction(hash);
      return { data, sources: [rpcSource(adapter, explorerLink(adapter, "tx", data.hash))] };
    },

    async getNativeBalance(chain, address) {
      const adapter = resolve(chain);
      const data = await adapter.getBalance(address);
      return { data, sources: [rpcSource(adapter, explorerLink(adapter, "address", data.address))] };
    },

    async getTokenBalances(chain, address) {
      const adapter = resolve(chain);
      const data = await adapter.getTokenBalances(address);
      return { data, sources: [explorerSource(adapter, explorerLink(adapter, "address", address.trim()))] };
    },

    async getAddressTransactions(chain, address, limit) {
      const adapter = resolve(chain);
      const data = await adapter.getAddressTransactions(address, limit);
      return { data, sources: [explorerSource(adapter, explorerLink(adapter, "address", address.trim()))] };
    },

    async getContractInfo(chain, address) {
      const adapter = resolve(chain);
      const data = await adapter.getContractInfo(address);
      const url = explorerLink(adapter, "address", data.address);
      const sources: SourceRef[] = [rpcSource(adapter, url)];
      if (adapter.config.explorerApiUrl && data.isContract) sources.push(explorerSource(adapter, url));
      return { data, sources };
    },

    async getTokenMetadata(chain, address) {
      const adapter = resolve(chain);
      const data = await adapter.getTokenMetadata(address);
      return { data, sources: [rpcSource(adapter, explorerLink(adapter, "token", address.trim()))] };
    },
  };
}
