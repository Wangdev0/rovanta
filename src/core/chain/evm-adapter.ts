import { createPublicClient, erc20Abi, formatGwei, formatUnits, hexToString, http, type Abi, type Hex } from "viem";
import { z } from "zod";
import type {
  Block,
  ChainStatus,
  ContractInfo,
  NativeBalance,
  TokenBalance,
  TokenMetadata,
  Transaction,
} from "../data/schemas";
import { RovantaError, codeFromHttpStatus, isRovantaError, type RovantaErrorCode } from "../errors";
import { isEvmAddress, isTxHash } from "../security/validators";
import type { ChainAdapter, ChainConfig } from "./types";

type Address = `0x${string}`;

export interface RpcBlock {
  number: bigint | null;
  hash: Hex | null;
  timestamp: bigint;
  transactionCount: number;
  gasUsed: bigint;
  gasLimit: bigint;
}

export interface RpcTransaction {
  hash: Hex;
  blockNumber: bigint | null;
  from: Address;
  to: Address | null;
  value: bigint;
  input: Hex;
}

/** The read-only subset of RPC calls the adapter uses. Injectable for tests. */
export interface EvmReadClient {
  getChainId(): Promise<number>;
  getBlock(blockNumber?: bigint): Promise<RpcBlock>;
  getGasPrice(): Promise<bigint>;
  getTransaction(hash: Hex): Promise<RpcTransaction>;
  getTransactionReceipt(hash: Hex): Promise<{ status: "success" | "reverted" }>;
  getBalance(address: Address): Promise<bigint>;
  getCode(address: Address): Promise<Hex | undefined>;
  readContract(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<unknown>;
}

export type EvmClientFactory = (rpcUrl: string, options: { timeoutMs: number }) => EvmReadClient;

export interface EvmAdapterDeps {
  clientFactory?: EvmClientFactory;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Env var names quoted in configuration error messages. */
  envVars?: { rpcUrl?: string; explorerApiUrl?: string };
}

export const DEFAULT_RPC_TIMEOUT_MS = 10_000;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 50;

export const viemClientFactory: EvmClientFactory = (rpcUrl, { timeoutMs }) => {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 1 }) });
  return {
    getChainId: () => client.getChainId(),
    async getBlock(blockNumber) {
      const block = blockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber });
      return {
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
        transactionCount: block.transactions.length,
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
      };
    },
    getGasPrice: () => client.getGasPrice(),
    async getTransaction(hash) {
      const tx = await client.getTransaction({ hash });
      return {
        hash: tx.hash,
        blockNumber: tx.blockNumber,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        input: tx.input,
      };
    },
    async getTransactionReceipt(hash) {
      const receipt = await client.getTransactionReceipt({ hash });
      return { status: receipt.status };
    },
    getBalance: (address) => client.getBalance({ address }),
    getCode: (address) => client.getCode({ address }),
    readContract: (address, abi, functionName, args) =>
      client.readContract({ address, abi, functionName, args: args as unknown[] | undefined }),
  };
};

const NOT_FOUND_ERRORS = new Set([
  "TransactionNotFoundError",
  "TransactionReceiptNotFoundError",
  "BlockNotFoundError",
]);

function errorChainNames(err: unknown): string[] {
  const names: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    names.push(current.name);
    current = current.cause;
  }
  return names;
}

/**
 * Upstream viem errors embed the RPC URL (which may carry an API key) in
 * their message, so they are never attached as a cause.
 */
function toRpcError(err: unknown, notFoundMessage?: string): RovantaError {
  if (isRovantaError(err)) return err;
  const names = errorChainNames(err);
  if (names.includes("AbortError")) return new RovantaError("ABORTED");
  if (names.some((name) => NOT_FOUND_ERRORS.has(name))) {
    return new RovantaError("DATA_UNAVAILABLE", notFoundMessage ?? "The requested item was not found on chain.");
  }
  return new RovantaError("RPC_UNAVAILABLE");
}

function requireAddress(value: string, code: RovantaErrorCode, label: string): Address {
  const trimmed = typeof value === "string" ? value.trim() : value;
  if (!isEvmAddress(trimmed)) {
    throw new RovantaError(code, `${label} must be a 0x-prefixed 20-byte hex address.`);
  }
  return trimmed;
}

function isoFromUnixSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function parseDecimals(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\0/g, "").trim();
  return text ? text.slice(0, 128) : null;
}

const bytes32MetadataAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const satisfies Abi;

const OptionalText = z.string().nullish();
const AddressRef = z.object({ hash: z.string() }).nullish();

const ExplorerTokenBalance = z.object({
  token: z.object({
    address_hash: z.string().optional(),
    address: z.string().optional(),
    name: OptionalText,
    symbol: OptionalText,
    decimals: z.union([z.string(), z.number()]).nullish(),
    type: OptionalText,
  }),
  value: OptionalText,
});

const ExplorerTransaction = z.object({
  hash: z.string(),
  block_number: z.number().nullish(),
  block: z.number().nullish(),
  timestamp: OptionalText,
  from: AddressRef,
  to: AddressRef,
  value: OptionalText,
  status: OptionalText,
  result: OptionalText,
  method: OptionalText,
});

const ExplorerItemsPage = z.object({ items: z.array(z.unknown()) });

const ExplorerSmartContract = z.object({
  name: OptionalText,
  compiler_version: OptionalText,
  is_verified: z.boolean().nullish(),
});

function explorerTxStatus(tx: z.infer<typeof ExplorerTransaction>): Transaction["status"] {
  if (tx.result === "pending" || (tx.block_number ?? tx.block) == null) return "pending";
  if (tx.status === "ok") return "success";
  if (tx.status === "error") return "reverted";
  return "unknown";
}

export class EvmChainAdapter implements ChainAdapter {
  readonly config: ChainConfig;
  readonly configured: boolean;
  private readonly clientFactory: EvmClientFactory;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly envVars: { rpcUrl?: string; explorerApiUrl?: string };
  private client: EvmReadClient | null = null;

  constructor(config: ChainConfig, deps: EvmAdapterDeps = {}) {
    this.config = config;
    this.configured = Boolean(config.rpcUrl);
    this.clientFactory = deps.clientFactory ?? viemClientFactory;
    this.fetchImpl = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.envVars = deps.envVars ?? {};
  }

  private getClient(): EvmReadClient {
    if (!this.config.rpcUrl) {
      throw new RovantaError(
        "RPC_NOT_CONFIGURED",
        `No RPC endpoint is configured for ${this.config.name}. ${
          this.envVars.rpcUrl ? `Set ${this.envVars.rpcUrl}` : "Set it in your environment configuration"
        }.`,
      );
    }
    this.client ??= this.clientFactory(this.config.rpcUrl, { timeoutMs: this.timeoutMs });
    return this.client;
  }

  private async rpc<T>(call: (client: EvmReadClient) => Promise<T>, notFoundMessage?: string): Promise<T> {
    const client = this.getClient();
    try {
      return await call(client);
    } catch (err) {
      throw toRpcError(err, notFoundMessage);
    }
  }

  private async tryRead<T>(call: (client: EvmReadClient) => Promise<T>): Promise<T | null> {
    try {
      return await call(this.getClient());
    } catch {
      return null;
    }
  }

  private explorerBase(): string | null {
    const base = this.config.explorerApiUrl;
    return base ? base.replace(/\/+$/, "").replace(/\/api(\/v2)?$/, "") : null;
  }

  private requireExplorer(): string {
    const base = this.explorerBase();
    if (!base) {
      const envVar = this.envVars.explorerApiUrl ?? "the chain's explorer API URL";
      throw new RovantaError("DATA_UNAVAILABLE", `Address history requires an explorer API (set ${envVar})`);
    }
    return base;
  }

  /** Returns null on 404 when `allowNotFound` is set. */
  private async explorerGet(path: string, allowNotFound = false): Promise<unknown> {
    const base = this.requireExplorer();
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RovantaError("DATA_UNAVAILABLE", `The ${this.config.name} explorer API could not be reached.`);
    }
    if (res.status === 404 && allowNotFound) return null;
    if (!res.ok) {
      throw new RovantaError(
        codeFromHttpStatus(res.status, "data"),
        `The ${this.config.name} explorer API returned HTTP ${res.status}.`,
      );
    }
    try {
      return await res.json();
    } catch {
      throw new RovantaError("DATA_UNAVAILABLE", `The ${this.config.name} explorer API returned invalid JSON.`);
    }
  }

  async getChainStatus(): Promise<ChainStatus> {
    const base: ChainStatus = {
      chain: this.config.slug,
      chainId: this.config.chainId,
      configured: this.configured,
      reachable: false,
      latestBlock: null,
      latestBlockTime: null,
      gasPriceGwei: null,
      rpcLatencyMs: null,
    };
    if (!this.configured) return base;

    const client = this.getClient();
    const started = performance.now();
    let block: RpcBlock;
    try {
      block = await client.getBlock();
    } catch {
      return base;
    }
    const rpcLatencyMs = Math.round(performance.now() - started);
    const [chainId, gasPrice] = await Promise.allSettled([client.getChainId(), client.getGasPrice()]);

    return {
      ...base,
      chainId: chainId.status === "fulfilled" ? chainId.value : this.config.chainId,
      reachable: true,
      latestBlock: block.number === null ? null : block.number.toString(),
      latestBlockTime: isoFromUnixSeconds(block.timestamp),
      gasPriceGwei: gasPrice.status === "fulfilled" ? Number(formatGwei(gasPrice.value)) : null,
      rpcLatencyMs,
    };
  }

  async getBlock(blockNumber?: bigint): Promise<Block> {
    this.getClient();
    if (blockNumber !== undefined && blockNumber < BigInt(0)) {
      throw new RovantaError("INVALID_INPUT", "Block number must be a non-negative integer.");
    }
    const block = await this.rpc((c) => c.getBlock(blockNumber), "Block not found.");
    if (block.number === null || block.hash === null) {
      throw new RovantaError("DATA_UNAVAILABLE", "Block is still pending.");
    }
    return {
      number: block.number.toString(),
      hash: block.hash,
      timestamp: isoFromUnixSeconds(block.timestamp),
      transactionCount: block.transactionCount,
      gasUsed: block.gasUsed.toString(),
      gasLimit: block.gasLimit.toString(),
    };
  }

  async getTransaction(hash: string): Promise<Transaction> {
    this.getClient();
    const trimmed = typeof hash === "string" ? hash.trim() : hash;
    if (!isTxHash(trimmed)) {
      throw new RovantaError("INVALID_INPUT", "Transaction hash must be a 0x-prefixed 32-byte hex string.");
    }
    const tx = await this.rpc((c) => c.getTransaction(trimmed), "Transaction not found.");

    let status: Transaction["status"] = "pending";
    let timestamp: string | null = null;
    if (tx.blockNumber !== null) {
      const blockNumber = tx.blockNumber;
      const [receipt, block] = await Promise.all([
        this.tryRead((c) => c.getTransactionReceipt(trimmed)),
        this.tryRead((c) => c.getBlock(blockNumber)),
      ]);
      status = receipt ? receipt.status : "unknown";
      timestamp = block ? isoFromUnixSeconds(block.timestamp) : null;
    }

    return {
      hash: tx.hash,
      chain: this.config.slug,
      blockNumber: tx.blockNumber === null ? null : tx.blockNumber.toString(),
      timestamp,
      from: tx.from,
      to: tx.to,
      value: tx.value.toString(),
      status,
      method: tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10) : null,
    };
  }

  async getBalance(address: string): Promise<NativeBalance> {
    this.getClient();
    const addr = requireAddress(address, "INVALID_WALLET", "Wallet address");
    const raw = await this.rpc((c) => c.getBalance(addr));
    return {
      address: addr,
      chain: this.config.slug,
      symbol: this.config.nativeSymbol,
      raw: raw.toString(),
      formatted: formatUnits(raw, this.config.nativeDecimals),
    };
  }

  private async readText(token: Address, field: "name" | "symbol"): Promise<string | null> {
    const value = await this.tryRead((c) => c.readContract(token, erc20Abi, field));
    if (typeof value === "string") return cleanText(value);
    const raw = await this.tryRead((c) => c.readContract(token, bytes32MetadataAbi, field));
    if (typeof raw !== "string") return null;
    try {
      return cleanText(hexToString(raw as Hex));
    } catch {
      return null;
    }
  }

  private async readErc20Metadata(token: Address): Promise<TokenMetadata> {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      this.readText(token, "name"),
      this.readText(token, "symbol"),
      this.tryRead((c) => c.readContract(token, erc20Abi, "decimals")),
      this.tryRead((c) => c.readContract(token, erc20Abi, "totalSupply")),
    ]);
    return {
      name,
      symbol,
      decimals: parseDecimals(decimals),
      chain: this.config.slug,
      address: token,
      assetId: null,
      description: null,
      website: null,
      categories: [],
      totalSupply: typeof totalSupply === "bigint" ? totalSupply.toString() : null,
    };
  }

  private async requireContract(address: Address): Promise<void> {
    const code = await this.rpc((c) => c.getCode(address));
    if (!code || code === "0x") {
      throw new RovantaError("INVALID_TOKEN", "No contract is deployed at this token address.");
    }
  }

  async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata> {
    this.getClient();
    const token = requireAddress(tokenAddress, "INVALID_TOKEN", "Token address");
    await this.requireContract(token);
    return this.readErc20Metadata(token);
  }

  async getTokenBalance(address: string, tokenAddress: string): Promise<TokenBalance> {
    this.getClient();
    const owner = requireAddress(address, "INVALID_WALLET", "Wallet address");
    const token = requireAddress(tokenAddress, "INVALID_TOKEN", "Token address");
    await this.requireContract(token);
    const [raw, metadata] = await Promise.all([
      this.tryRead((c) => c.readContract(token, erc20Abi, "balanceOf", [owner])),
      this.readErc20Metadata(token),
    ]);
    if (typeof raw !== "bigint") {
      throw new RovantaError("DATA_UNAVAILABLE", "The token contract did not return a balance (balanceOf failed).");
    }
    return {
      tokenAddress: token,
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: metadata.decimals,
      raw: raw.toString(),
      formatted: metadata.decimals === null ? null : formatUnits(raw, metadata.decimals),
    };
  }

  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    this.getClient();
    const owner = requireAddress(address, "INVALID_WALLET", "Wallet address");
    this.requireExplorer();
    const body = await this.explorerGet(`/api/v2/addresses/${owner}/token-balances`);
    const list = z.array(z.unknown()).safeParse(body);
    if (!list.success) {
      throw new RovantaError("DATA_UNAVAILABLE", "The explorer API returned an unexpected token balance format.");
    }
    const balances: TokenBalance[] = [];
    for (const item of list.data) {
      const parsed = ExplorerTokenBalance.safeParse(item);
      if (!parsed.success) continue;
      const { token, value } = parsed.data;
      if (token.type && token.type !== "ERC-20") continue;
      const tokenAddr = token.address_hash ?? token.address;
      if (!isEvmAddress(tokenAddr) || !value || !/^\d+$/.test(value)) continue;
      const decimals = parseDecimals(token.decimals);
      balances.push({
        tokenAddress: tokenAddr,
        symbol: cleanText(token.symbol),
        name: cleanText(token.name),
        decimals,
        raw: value,
        formatted: decimals === null ? null : formatUnits(BigInt(value), decimals),
      });
    }
    return balances;
  }

  async getAddressTransactions(address: string, limit: number = DEFAULT_HISTORY_LIMIT): Promise<Transaction[]> {
    this.getClient();
    const owner = requireAddress(address, "INVALID_WALLET", "Wallet address");
    this.requireExplorer();
    const max = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT;
    const body = await this.explorerGet(`/api/v2/addresses/${owner}/transactions`);
    const page = ExplorerItemsPage.safeParse(body);
    if (!page.success) {
      throw new RovantaError("DATA_UNAVAILABLE", "The explorer API returned an unexpected transaction format.");
    }
    const transactions: Transaction[] = [];
    for (const item of page.data.items) {
      if (transactions.length >= max) break;
      const parsed = ExplorerTransaction.safeParse(item);
      if (!parsed.success) continue;
      const tx = parsed.data;
      const from = tx.from?.hash;
      const to = tx.to?.hash ?? null;
      if (!isTxHash(tx.hash) || !isEvmAddress(from) || (to !== null && !isEvmAddress(to))) continue;
      const blockNumber = tx.block_number ?? tx.block ?? null;
      transactions.push({
        hash: tx.hash,
        chain: this.config.slug,
        blockNumber: blockNumber === null ? null : String(blockNumber),
        timestamp: isoOrNull(tx.timestamp),
        from,
        to,
        value: tx.value && /^\d+$/.test(tx.value) ? tx.value : "0",
        status: explorerTxStatus(tx),
        method: cleanText(tx.method),
      });
    }
    return transactions;
  }

  async getContractInfo(address: string): Promise<ContractInfo> {
    this.getClient();
    const addr = requireAddress(address, "INVALID_INPUT", "Contract address");
    const code = await this.rpc((c) => c.getCode(addr));
    const isContract = Boolean(code && code !== "0x");
    const info: ContractInfo = {
      address: addr,
      chain: this.config.slug,
      isContract,
      bytecodeSize: code ? (code.length - 2) / 2 : 0,
      verified: null,
      name: null,
      compiler: null,
      token: null,
    };
    if (!isContract) return info;

    const [explorer, token] = await Promise.all([
      this.explorerBase() ? this.fetchSmartContract(addr) : Promise.resolve(null),
      this.readErc20Metadata(addr),
    ]);
    if (explorer) {
      info.verified = explorer.verified;
      info.name = explorer.name;
      info.compiler = explorer.compiler;
    }
    if (token.symbol !== null || token.decimals !== null || token.totalSupply !== null) info.token = token;
    return info;
  }

  private async fetchSmartContract(
    address: Address,
  ): Promise<{ verified: boolean | null; name: string | null; compiler: string | null } | null> {
    try {
      const body = await this.explorerGet(`/api/v2/smart-contracts/${address}`, true);
      if (body === null) return { verified: false, name: null, compiler: null };
      const parsed = ExplorerSmartContract.safeParse(body);
      if (!parsed.success) return null;
      return {
        verified: parsed.data.is_verified ?? null,
        name: cleanText(parsed.data.name),
        compiler: cleanText(parsed.data.compiler_version),
      };
    } catch {
      return null;
    }
  }
}
