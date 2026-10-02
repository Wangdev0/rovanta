import { describe, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionExecutionError, HttpRequestError, TransactionNotFoundError, type Abi } from "viem";
import { EvmChainAdapter } from "@/core/chain/evm-adapter";
import { RovantaError } from "@/core/errors";
import {
  EXPLORER_API_URL,
  FAKE_KEY,
  OTHER,
  RPC_URL,
  TOKEN,
  TX_HASH,
  WALLET,
  factoryFor,
  fakeClient,
  fixtureConfig,
  jsonResponse,
  rejectionOf,
} from "./fixtures";

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RovantaError);
    return (err as RovantaError).code;
  }
  throw new Error("expected rejection");
}

describe("EvmChainAdapter unconfigured", () => {
  const adapter = new EvmChainAdapter(fixtureConfig({ rpcUrl: null }), {
    clientFactory: () => {
      throw new Error("factory must not be called");
    },
  });

  it("reports configured false without contacting anything", async () => {
    expect(adapter.configured).toBe(false);
    await expect(adapter.getChainStatus()).resolves.toEqual({
      chain: "fixture",
      chainId: 999_001,
      configured: false,
      reachable: false,
      latestBlock: null,
      latestBlockTime: null,
      gasPriceGwei: null,
      rpcLatencyMs: null,
    });
  });

  it("throws RPC_NOT_CONFIGURED from every data method", async () => {
    const calls = [
      adapter.getBlock(),
      adapter.getTransaction(TX_HASH),
      adapter.getBalance(WALLET),
      adapter.getTokenBalance(WALLET, TOKEN),
      adapter.getTokenMetadata(TOKEN),
      adapter.getTokenBalances(WALLET),
      adapter.getAddressTransactions(WALLET),
      adapter.getContractInfo(TOKEN),
    ];
    for (const call of calls) expect(await codeOf(call)).toBe("RPC_NOT_CONFIGURED");
  });
});

describe("EvmChainAdapter RPC reads", () => {
  it("returns chain status with block, gas and RPC-reported chain id", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig({ chainId: null }), {
      clientFactory: factoryFor(fakeClient({ getChainId: async () => 424242 })),
    });
    const status = await adapter.getChainStatus();
    expect(status).toMatchObject({
      configured: true,
      reachable: true,
      chainId: 424242,
      latestBlock: "1234",
      latestBlockTime: "2023-11-14T22:13:20.000Z",
      gasPriceGwei: 2.5,
    });
    expect(status.rpcLatencyMs).toBeTypeOf("number");
  });

  it("reports reachable false when the RPC is down", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient({ getBlock: async () => Promise.reject(new Error("fetch failed")) })),
    });
    await expect(adapter.getChainStatus()).resolves.toMatchObject({ configured: true, reachable: false, latestBlock: null });
  });

  it("formats native balance with native decimals", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), { clientFactory: factoryFor(fakeClient()) });
    await expect(adapter.getBalance(WALLET)).resolves.toEqual({
      address: WALLET,
      chain: "fixture",
      symbol: "ETH",
      raw: "1500000000000000000",
      formatted: "1.5",
    });
  });

  it("rejects invalid wallet addresses with INVALID_WALLET", async () => {
    const getBalance = vi.fn();
    const adapter = new EvmChainAdapter(fixtureConfig(), { clientFactory: factoryFor(fakeClient({ getBalance })) });
    expect(await codeOf(adapter.getBalance("0x123"))).toBe("INVALID_WALLET");
    expect(await codeOf(adapter.getBalance("not an address"))).toBe("INVALID_WALLET");
    expect(await codeOf(adapter.getTokenBalances("0xzz"))).toBe("INVALID_WALLET");
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("rejects invalid tx hashes with INVALID_INPUT", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), { clientFactory: factoryFor(fakeClient()) });
    expect(await codeOf(adapter.getTransaction("0xabc"))).toBe("INVALID_INPUT");
  });

  it("maps viem transport errors to RPC_UNAVAILABLE without leaking the RPC URL", async () => {
    const transportError = new HttpRequestError({ url: RPC_URL, status: 502, body: { method: "eth_getBalance" } });
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient({ getBalance: async () => Promise.reject(transportError) })),
    });
    const err = await rejectionOf(adapter.getBalance(WALLET));
    expect(err).toBeInstanceOf(RovantaError);
    expect(err.code).toBe("RPC_UNAVAILABLE");
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain(FAKE_KEY);
  });

  it("maps plain network failures to RPC_UNAVAILABLE", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient({ getBlock: async () => Promise.reject(new TypeError("fetch failed")) })),
    });
    expect(await codeOf(adapter.getBlock())).toBe("RPC_UNAVAILABLE");
  });

  it("maps missing transactions to DATA_UNAVAILABLE", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(
        fakeClient({ getTransaction: async () => Promise.reject(new TransactionNotFoundError({ hash: TX_HASH })) }),
      ),
    });
    expect(await codeOf(adapter.getTransaction(TX_HASH))).toBe("DATA_UNAVAILABLE");
  });
});

describe("EvmChainAdapter transaction status", () => {
  it("maps a mined successful tx", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), { clientFactory: factoryFor(fakeClient()) });
    await expect(adapter.getTransaction(TX_HASH)).resolves.toEqual({
      hash: TX_HASH,
      chain: "fixture",
      blockNumber: "1234",
      timestamp: "2023-11-14T22:13:20.000Z",
      from: WALLET,
      to: OTHER,
      value: "1000000000000000000",
      status: "success",
      method: "0xa9059cbb",
    });
  });

  it("maps a reverted tx", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient({ getTransactionReceipt: async () => ({ status: "reverted" }) })),
    });
    await expect(adapter.getTransaction(TX_HASH)).resolves.toMatchObject({ status: "reverted" });
  });

  it("maps a tx without a block to pending and skips the receipt", async () => {
    const getTransactionReceipt = vi.fn();
    const base = fakeClient();
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(
        fakeClient({
          getTransaction: async (hash) => ({ ...(await base.getTransaction(hash)), blockNumber: null }),
          getTransactionReceipt,
        }),
      ),
    });
    await expect(adapter.getTransaction(TX_HASH)).resolves.toMatchObject({
      status: "pending",
      blockNumber: null,
      timestamp: null,
    });
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("maps a missing receipt to unknown", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient({ getTransactionReceipt: async () => Promise.reject(new Error("nope")) })),
    });
    await expect(adapter.getTransaction(TX_HASH)).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("EvmChainAdapter ERC-20 reads", () => {
  const revert = (fn: string) =>
    new ContractFunctionExecutionError(new BaseError("execution reverted"), { abi: [] as Abi, functionName: fn });

  it("returns full metadata for a standard token", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), { clientFactory: factoryFor(fakeClient()) });
    await expect(adapter.getTokenMetadata(TOKEN)).resolves.toMatchObject({
      name: "Fixture Token",
      symbol: "FIX",
      decimals: 6,
      totalSupply: "1000000000",
      address: TOKEN,
      chain: "fixture",
    });
  });

  it("tolerates reverting metadata calls with null fields", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(
        fakeClient({
          readContract: async (_a, _abi, fn) => {
            if (fn === "totalSupply") return BigInt(5);
            throw revert(fn);
          },
        }),
      ),
    });
    await expect(adapter.getTokenMetadata(TOKEN)).resolves.toMatchObject({
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: "5",
    });
  });

  it("decodes bytes32 name and symbol from non-standard tokens", async () => {
    const bytes32 = (text: string) =>
      `0x${Buffer.from(text).toString("hex").padEnd(64, "0")}`;
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(
        fakeClient({
          readContract: async (_a, abi, fn) => {
            const isBytes32 = JSON.stringify(abi).includes("bytes32");
            if (fn === "name") {
              if (!isBytes32) throw revert(fn);
              return bytes32("Old Token");
            }
            if (fn === "symbol") {
              if (!isBytes32) throw revert(fn);
              return bytes32("OLD");
            }
            if (fn === "decimals") return 18;
            throw revert(fn);
          },
        }),
      ),
    });
    await expect(adapter.getTokenMetadata(TOKEN)).resolves.toMatchObject({ name: "Old Token", symbol: "OLD", decimals: 18 });
  });

  it("rejects a token address with no deployed code", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient({ getCode: async () => undefined })),
    });
    expect(await codeOf(adapter.getTokenMetadata(TOKEN))).toBe("INVALID_TOKEN");
  });

  it("formats token balances and leaves formatted null when decimals are unknown", async () => {
    const ok = new EvmChainAdapter(fixtureConfig(), { clientFactory: factoryFor(fakeClient()) });
    await expect(ok.getTokenBalance(WALLET, TOKEN)).resolves.toEqual({
      tokenAddress: TOKEN,
      symbol: "FIX",
      name: "Fixture Token",
      decimals: 6,
      raw: "12345678",
      formatted: "12.345678",
    });

    const noDecimals = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(
        fakeClient({
          readContract: async (_a, _abi, fn) => {
            if (fn === "balanceOf") return BigInt(7);
            throw revert(fn);
          },
        }),
      ),
    });
    await expect(noDecimals.getTokenBalance(WALLET, TOKEN)).resolves.toMatchObject({ raw: "7", formatted: null });
  });

  it("reports contract info with explorer verification", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ name: "FixtureToken", compiler_version: "v0.8.24+commit.e11b9ed9", is_verified: true }),
    );
    const adapter = new EvmChainAdapter(fixtureConfig({ explorerApiUrl: EXPLORER_API_URL }), {
      clientFactory: factoryFor(fakeClient()),
      fetch: fetchMock,
    });
    const info = await adapter.getContractInfo(TOKEN);
    expect(info).toMatchObject({
      isContract: true,
      bytecodeSize: 5,
      verified: true,
      name: "FixtureToken",
      compiler: "v0.8.24+commit.e11b9ed9",
    });
    expect(info.token?.symbol).toBe("FIX");
    expect(fetchMock).toHaveBeenCalledWith(`${EXPLORER_API_URL}/api/v2/smart-contracts/${TOKEN}`, expect.anything());
  });

  it("reports an EOA as not a contract", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient({ getCode: async () => undefined })),
    });
    await expect(adapter.getContractInfo(WALLET)).resolves.toMatchObject({
      isContract: false,
      bytecodeSize: 0,
      verified: null,
      token: null,
    });
  });
});

describe("EvmChainAdapter explorer API", () => {
  it("throws DATA_UNAVAILABLE when no explorer API is configured", async () => {
    const adapter = new EvmChainAdapter(fixtureConfig(), {
      clientFactory: factoryFor(fakeClient()),
      envVars: { explorerApiUrl: "ROBINHOOD_CHAIN_EXPLORER_API_URL" },
    });
    const err = await rejectionOf(adapter.getAddressTransactions(WALLET));
    expect(err.code).toBe("DATA_UNAVAILABLE");
    expect(err.message).toBe("Address history requires an explorer API (set ROBINHOOD_CHAIN_EXPLORER_API_URL)");
    expect(await codeOf(adapter.getTokenBalances(WALLET))).toBe("DATA_UNAVAILABLE");
  });

  it("parses Blockscout token balances defensively", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { token: { address_hash: TOKEN, name: "Fixture Token", symbol: "FIX", decimals: "6", type: "ERC-20" }, value: "2500000" },
        { token: { address: OTHER, name: null, symbol: null, decimals: null, type: "ERC-20" }, value: "42" },
        { token: { address_hash: OTHER, name: "NFT", symbol: "NFT", decimals: null, type: "ERC-721" }, value: "1" },
        { token: { address_hash: "0xbad", symbol: "BAD", type: "ERC-20" }, value: "1" },
        { nonsense: true },
      ]),
    );
    const adapter = new EvmChainAdapter(fixtureConfig({ explorerApiUrl: `${EXPLORER_API_URL}/api` }), {
      clientFactory: factoryFor(fakeClient()),
      fetch: fetchMock,
    });
    await expect(adapter.getTokenBalances(WALLET)).resolves.toEqual([
      { tokenAddress: TOKEN, symbol: "FIX", name: "Fixture Token", decimals: 6, raw: "2500000", formatted: "2.5" },
      { tokenAddress: OTHER, symbol: null, name: null, decimals: null, raw: "42", formatted: null },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${EXPLORER_API_URL}/api/v2/addresses/${WALLET}/token-balances`,
      expect.anything(),
    );
  });

  it("parses Blockscout transactions with status mapping and limit", async () => {
    const item = (overrides: Record<string, unknown>) => ({
      hash: TX_HASH,
      block_number: 100,
      timestamp: "2024-01-01T00:00:00.000000Z",
      from: { hash: WALLET },
      to: { hash: OTHER },
      value: "1000",
      status: "ok",
      result: "success",
      method: "transfer",
      ...overrides,
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [
          item({}),
          item({ status: "error", result: "Reverted" }),
          item({ block_number: null, status: null, result: "pending", timestamp: null }),
          item({ to: null, method: null, status: null, result: null }),
          item({ hash: "0xnothash" }),
          item({}),
        ],
        next_page_params: null,
      }),
    );
    const adapter = new EvmChainAdapter(fixtureConfig({ explorerApiUrl: EXPLORER_API_URL }), {
      clientFactory: factoryFor(fakeClient()),
      fetch: fetchMock,
    });
    const txs = await adapter.getAddressTransactions(WALLET, 4);
    expect(txs.map((t) => t.status)).toEqual(["success", "reverted", "pending", "unknown"]);
    expect(txs[0]).toEqual({
      hash: TX_HASH,
      chain: "fixture",
      blockNumber: "100",
      timestamp: "2024-01-01T00:00:00.000Z",
      from: WALLET,
      to: OTHER,
      value: "1000",
      status: "success",
      method: "transfer",
    });
    expect(txs[2]).toMatchObject({ blockNumber: null, timestamp: null });
    expect(txs[3]).toMatchObject({ to: null, method: null });
  });

  it("clamps the history limit to 50", async () => {
    const items = Array.from({ length: 60 }, () => ({
      hash: TX_HASH,
      block_number: 1,
      from: { hash: WALLET },
      to: { hash: OTHER },
      value: "0",
      status: "ok",
    }));
    const adapter = new EvmChainAdapter(fixtureConfig({ explorerApiUrl: EXPLORER_API_URL }), {
      clientFactory: factoryFor(fakeClient()),
      fetch: vi.fn(async () => jsonResponse({ items })),
    });
    expect(await adapter.getAddressTransactions(WALLET, 500)).toHaveLength(50);
    expect(await adapter.getAddressTransactions(WALLET)).toHaveLength(20);
  });

  it("maps explorer HTTP and shape failures to error codes", async () => {
    const make = (res: Response | Error) =>
      new EvmChainAdapter(fixtureConfig({ explorerApiUrl: EXPLORER_API_URL }), {
        clientFactory: factoryFor(fakeClient()),
        fetch: vi.fn(async () => {
          if (res instanceof Error) throw res;
          return res;
        }),
      });
    expect(await codeOf(make(jsonResponse({}, 429)).getAddressTransactions(WALLET))).toBe("RATE_LIMITED");
    expect(await codeOf(make(jsonResponse({}, 500)).getAddressTransactions(WALLET))).toBe("DATA_UNAVAILABLE");
    expect(await codeOf(make(jsonResponse({ items: "nope" })).getAddressTransactions(WALLET))).toBe("DATA_UNAVAILABLE");
    expect(await codeOf(make(jsonResponse({ not: "an array" })).getTokenBalances(WALLET))).toBe("DATA_UNAVAILABLE");
    expect(await codeOf(make(new TypeError("fetch failed")).getTokenBalances(WALLET))).toBe("DATA_UNAVAILABLE");
  });
});
