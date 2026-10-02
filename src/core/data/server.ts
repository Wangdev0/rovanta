import { createChainAdaptersFromEnv } from "@/core/chain";
import { createOnChainProvider } from "@/core/chain/onchain-provider";
import { CoinGeckoMarketProvider } from "./coingecko";
import { DefiLlamaProtocolProvider } from "./defillama";
import { DexScreenerLiquidityProvider } from "./dexscreener";
import type { FetchLike } from "./fetch-json";
import type { DataServices } from "./types";
import { DisabledWebResearchProvider } from "./web";

type Env = Record<string, string | undefined>;

let memo: DataServices | null = null;

function build(env: Env, fetchImpl: FetchLike): DataServices {
  const plan = env.COINGECKO_API_PLAN?.trim().toLowerCase() === "pro" ? "pro" : "demo";
  return {
    market: new CoinGeckoMarketProvider({ apiKey: env.COINGECKO_API_KEY, plan, fetchImpl }),
    liquidity: new DexScreenerLiquidityProvider({ fetchImpl }),
    protocol: new DefiLlamaProtocolProvider({ fetchImpl }),
    onchain: createOnChainProvider(createChainAdaptersFromEnv(env)),
    web: new DisabledWebResearchProvider(),
  };
}

/** Server-only. Memoized per process when called with the default env and fetch. */
export function createServerDataServices(env: Env = process.env, fetchImpl?: FetchLike): DataServices {
  if (env === process.env && fetchImpl === undefined) {
    memo ??= build(env, (input, init) => fetch(input, init));
    return memo;
  }
  return build(env, fetchImpl ?? ((input, init) => fetch(input, init)));
}
