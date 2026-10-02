import { describe, expect, it } from "vitest";
import { createChainAdaptersFromEnv } from "@/core/chain";
import { parseEndpointUrl } from "@/core/chain/config";
import { genericEvmConfigsFromEnv } from "@/core/chain/generic";
import { RobinhoodChainAdapter, robinhoodConfigFromEnv } from "@/core/chain/robinhood";
import { EXPLORER_API_URL, EXPLORER_URL, RPC_URL, WALLET, rejectionOf } from "./fixtures";

describe("robinhoodConfigFromEnv", () => {
  it("invents nothing when the environment is empty", () => {
    expect(robinhoodConfigFromEnv({})).toEqual({
      slug: "robinhood",
      name: "Robinhood Chain",
      chainId: null,
      rpcUrl: null,
      explorerUrl: null,
      explorerApiUrl: null,
      nativeSymbol: "ETH",
      nativeDecimals: 18,
    });
  });

  it("reads all values from env", () => {
    const config = robinhoodConfigFromEnv({
      ROBINHOOD_CHAIN_RPC_URL: RPC_URL,
      ROBINHOOD_CHAIN_ID: "999001",
      ROBINHOOD_CHAIN_EXPLORER_URL: `${EXPLORER_URL}/`,
      ROBINHOOD_CHAIN_EXPLORER_API_URL: EXPLORER_API_URL,
      ROBINHOOD_CHAIN_NATIVE_SYMBOL: "XYZ",
    });
    expect(config).toMatchObject({
      rpcUrl: RPC_URL,
      chainId: 999001,
      explorerUrl: EXPLORER_URL,
      explorerApiUrl: EXPLORER_API_URL,
      nativeSymbol: "XYZ",
    });
  });

  it("treats invalid URLs and chain ids as not configured", () => {
    const config = robinhoodConfigFromEnv({
      ROBINHOOD_CHAIN_RPC_URL: "http://rpc.fixture.invalid",
      ROBINHOOD_CHAIN_ID: "abc",
      ROBINHOOD_CHAIN_EXPLORER_URL: "ftp://explorer.fixture.invalid",
      ROBINHOOD_CHAIN_EXPLORER_API_URL: "not a url",
    });
    expect(config).toMatchObject({ rpcUrl: null, chainId: null, explorerUrl: null, explorerApiUrl: null });
    expect(new RobinhoodChainAdapter(config).configured).toBe(false);
  });

  it("allows plain http only for local hosts", () => {
    expect(parseEndpointUrl("http://localhost:8545")).toBe("http://localhost:8545");
    expect(parseEndpointUrl("http://127.0.0.1:8545/")).toBe("http://127.0.0.1:8545");
    expect(parseEndpointUrl("http://example.invalid")).toBeNull();
    expect(parseEndpointUrl("javascript:alert(1)")).toBeNull();
    expect(parseEndpointUrl("  ")).toBeNull();
  });

  it("names the env var in configuration errors", async () => {
    const adapter = new RobinhoodChainAdapter({});
    const err = await rejectionOf(adapter.getBalance(WALLET));
    expect(err.code).toBe("RPC_NOT_CONFIGURED");
    expect(err.message).toContain("ROBINHOOD_CHAIN_RPC_URL");
  });
});

describe("chain adapter registry", () => {
  it("always includes Robinhood Chain and adds Ethereum only when configured", () => {
    expect(createChainAdaptersFromEnv({}).map((a) => [a.config.slug, a.configured])).toEqual([["robinhood", false]]);
    expect(genericEvmConfigsFromEnv({ ETHEREUM_RPC_URL: "http://insecure.invalid" })).toEqual([]);

    const adapters = createChainAdaptersFromEnv({ ETHEREUM_RPC_URL: RPC_URL });
    expect(adapters.map((a) => [a.config.slug, a.configured])).toEqual([
      ["robinhood", false],
      ["ethereum", true],
    ]);
    expect(adapters[1].config.chainId).toBe(1);
  });
});
