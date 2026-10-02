// DEV FIXTURE: fake RPC client and explorer responses for tests only.
import type { Hex } from "viem";
import type { EvmClientFactory, EvmReadClient } from "@/core/chain/evm-adapter";
import type { ChainConfig } from "@/core/chain/types";
import { RovantaError } from "@/core/errors";

export const WALLET = "0x1111111111111111111111111111111111111111";
export const TOKEN = "0x2222222222222222222222222222222222222222";
export const OTHER = "0x3333333333333333333333333333333333333333";
export const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
export const FAKE_KEY = "sk-fixture-SECRET-9f8e7d";
export const RPC_URL = `https://rpc.fixture.invalid/v1/${FAKE_KEY}`;
export const EXPLORER_URL = "https://explorer.fixture.invalid";
export const EXPLORER_API_URL = "https://explorer-api.fixture.invalid";

export function fixtureConfig(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    slug: "fixture",
    name: "Fixture Chain",
    chainId: 999_001,
    rpcUrl: RPC_URL,
    explorerUrl: null,
    explorerApiUrl: null,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    ...overrides,
  };
}

export function fakeClient(overrides: Partial<EvmReadClient> = {}): EvmReadClient {
  return {
    getChainId: async () => 999_001,
    getBlock: async (blockNumber) => ({
      number: blockNumber ?? BigInt(1234),
      hash: `0x${"cd".repeat(32)}` as Hex,
      timestamp: BigInt(1_700_000_000),
      transactionCount: 3,
      gasUsed: BigInt(21_000),
      gasLimit: BigInt(30_000_000),
    }),
    getGasPrice: async () => BigInt(2_500_000_000),
    getTransaction: async () => ({
      hash: TX_HASH,
      blockNumber: BigInt(1234),
      from: WALLET,
      to: OTHER,
      value: BigInt("1000000000000000000"),
      input: "0xa9059cbb0000",
    }),
    getTransactionReceipt: async () => ({ status: "success" }),
    getBalance: async () => BigInt("1500000000000000000"),
    getCode: async () => "0x6080604052",
    readContract: async (_address, _abi, functionName) => {
      switch (functionName) {
        case "name":
          return "Fixture Token";
        case "symbol":
          return "FIX";
        case "decimals":
          return 6;
        case "totalSupply":
          return BigInt(1_000_000_000);
        case "balanceOf":
          return BigInt(12_345_678);
        default:
          throw new Error("unexpected call");
      }
    },
    ...overrides,
  };
}

export function factoryFor(client: EvmReadClient): EvmClientFactory {
  return () => client;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function rejectionOf(promise: Promise<unknown>): Promise<RovantaError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RovantaError) return err;
    throw err;
  }
  throw new Error("expected rejection");
}
