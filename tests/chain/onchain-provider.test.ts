import { describe, expect, it, vi } from "vitest";
import { EvmChainAdapter } from "@/core/chain/evm-adapter";
import { createOnChainProvider } from "@/core/chain/onchain-provider";
import { RovantaError } from "@/core/errors";
import {
  EXPLORER_API_URL,
  EXPLORER_URL,
  FAKE_KEY,
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

function provider() {
  const configured = new EvmChainAdapter(
    fixtureConfig({ explorerUrl: EXPLORER_URL, explorerApiUrl: EXPLORER_API_URL }),
    {
      clientFactory: factoryFor(fakeClient()),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/token-balances")) return jsonResponse([]);
        if (url.endsWith("/transactions")) return jsonResponse({ items: [] });
        return jsonResponse({ is_verified: true });
      }),
    },
  );
  const unconfigured = new EvmChainAdapter(fixtureConfig({ slug: "idle", name: "Idle Chain", rpcUrl: null }));
  return createOnChainProvider([configured, unconfigured]);
}

describe("createOnChainProvider", () => {
  it("exposes metadata and supported chains", () => {
    const p = provider();
    expect(p.id).toBe("onchain");
    expect(p.name).toBe("On-chain RPC");
    expect(p.enabled).toBe(true);
    expect(p.supportedChains()).toEqual(["fixture", "idle"]);
    expect(createOnChainProvider([new EvmChainAdapter(fixtureConfig({ rpcUrl: null }))]).enabled).toBe(false);
  });

  it("rejects unknown chains with INVALID_INPUT listing supported slugs", async () => {
    const err = await rejectionOf(provider().getChainStatus("solana"));
    expect(err).toBeInstanceOf(RovantaError);
    expect(err.code).toBe("INVALID_INPUT");
    expect(err.message).toContain("fixture, idle");
  });

  it("resolves chain slugs case-insensitively", async () => {
    await expect(provider().getChainStatus(" FIXTURE ")).resolves.toMatchObject({ data: { chain: "fixture" } });
  });

  it("propagates RPC_NOT_CONFIGURED for unconfigured chains", async () => {
    const p = provider();
    await expect(p.getChainStatus("idle")).resolves.toMatchObject({ data: { configured: false } });
    await expect(p.getNativeBalance("idle", WALLET)).rejects.toMatchObject({ code: "RPC_NOT_CONFIGURED" });
  });

  it("attaches explorer links as sources", async () => {
    const p = provider();
    const tx = await p.getTransaction("fixture", TX_HASH);
    expect(tx.sources).toEqual([
      { provider: "rpc:fixture", name: "Fixture Chain RPC", url: `${EXPLORER_URL}/tx/${TX_HASH}`, fetchedAt: expect.any(String) },
    ]);
    const balance = await p.getNativeBalance("fixture", WALLET);
    expect(balance.sources[0].url).toBe(`${EXPLORER_URL}/address/${WALLET}`);
    const history = await p.getAddressTransactions("fixture", WALLET);
    expect(history.sources[0]).toMatchObject({ provider: "explorer:fixture", url: `${EXPLORER_URL}/address/${WALLET}` });
    const block = await p.getBlock("fixture", "1234");
    expect(block.sources[0].url).toBe(`${EXPLORER_URL}/block/1234`);
  });

  it("omits the url when no explorer is configured", async () => {
    const p = createOnChainProvider([
      new EvmChainAdapter(fixtureConfig(), { clientFactory: factoryFor(fakeClient()) }),
    ]);
    const res = await p.getNativeBalance("fixture", WALLET);
    expect(res.sources[0]).not.toHaveProperty("url");
  });

  it("rejects malformed block numbers", async () => {
    await expect(provider().getBlock("fixture", "12a")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("never exposes the RPC or explorer API URL in sources", async () => {
    const p = provider();
    const results = await Promise.all([
      p.getChainStatus("fixture"),
      p.getBlock("fixture"),
      p.getTransaction("fixture", TX_HASH),
      p.getNativeBalance("fixture", WALLET),
      p.getTokenBalances("fixture", WALLET),
      p.getAddressTransactions("fixture", WALLET),
      p.getContractInfo("fixture", TOKEN),
      p.getTokenMetadata("fixture", TOKEN),
    ]);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain(RPC_URL);
    expect(serialized).not.toContain(EXPLORER_API_URL);
  });
});
