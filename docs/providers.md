# Providers

ROVANTA has three kinds of providers: LLM providers (called with the user's key), data providers and chain adapters. All of them run inside the local CLI process and call their upstreams directly.

## LLM providers

Defined in `src/core/llm`. Every provider implements:

```ts
interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  toolCall(request: GenerateRequest & { tools: ToolSpec[] }): Promise<GenerateResult>;
}
```

| Id | Label | Default base URL | Auth |
| --- | --- | --- | --- |
| `openai-compatible` | OpenAI-compatible | `https://api.openai.com/v1` (base URL required) | `Authorization: Bearer` |
| `anthropic` | Anthropic | `https://api.anthropic.com` | `x-api-key` header |
| `google` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` header |

`rovanta providers` prints this list. `createProvider(config)` in `registry.ts` validates the config:

- Unknown provider: `UNSUPPORTED_PROVIDER`.
- Missing key or model, or missing base URL where required: `PROVIDER_NOT_CONFIGURED`.
- Base URL not `https` (or `http` on `localhost` / `127.0.0.1`): `INVALID_INPUT`.

### How the CLI picks a provider

The CLI resolves `provider`, `model`, `baseUrl` and `apiKey` from, in increasing priority:

1. the config file (`$ROVANTA_CONFIG`, `$XDG_CONFIG_HOME/rovanta/config.json` or `~/.config/rovanta/config.json`),
2. environment variables `ROVANTA_PROVIDER`, `ROVANTA_MODEL`, `ROVANTA_BASE_URL`, `ROVANTA_API_KEY`, with key fallbacks `OPENAI_API_KEY` (openai-compatible), `ANTHROPIC_API_KEY` (anthropic) and `GEMINI_API_KEY` / `GOOGLE_API_KEY` (google),
3. flags `--provider`, `--model`, `--base-url`. The API key has no flag.

Local OpenAI-compatible servers (Ollama, LM Studio) on `http://localhost` work with `openai-compatible`; set any non-empty placeholder as the key if the server does not check keys.

### Adding an LLM provider

1. Create `src/core/llm/my-provider.ts` exporting a factory `(config, fetchImpl?) => LLMProvider`. Use the injected `fetchImpl` so tests can mock it.
2. Map the provider's tool-calling format to `ToolCallRequest` (`id`, `name`, parsed `arguments`) and its stop reasons to `FinishReason`.
3. Map HTTP errors to `RovantaError`: 401/403 to `INVALID_API_KEY`, 429 to `RATE_LIMITED`, 5xx and network failures to `PROVIDER_UNAVAILABLE`. Pass error text through `redactSecrets`.
4. Add the id to `ProviderId` in `types.ts` and call `registerProvider(id, info, factory)`.
5. If the provider has a conventional API key environment variable, add it as a fallback in the CLI config resolution and document it.
6. Test generate, streaming, tool calls and error mapping with a mocked `fetch`.

If the service already offers an OpenAI-compatible Chat Completions API with tool calling, use the `openai-compatible` provider instead of writing a new adapter.

## Data providers

Interfaces are in `src/core/data/types.ts`. Every method returns `Sourced<T>` (`{ data, sources }`), where `data` conforms to a schema in `src/core/data/schemas.ts`.

| Interface | Implementation | Endpoint | Configuration |
| --- | --- | --- | --- |
| `MarketDataProvider` | CoinGecko | `https://api.coingecko.com/api/v3` (demo / public) or `https://pro-api.coingecko.com/api/v3` (pro) | `COINGECKO_API_KEY` (optional), `COINGECKO_API_PLAN` |
| `LiquidityDataProvider` | DexScreener | `https://api.dexscreener.com` | none |
| `ProtocolDataProvider` | DefiLlama | `https://api.llama.fi` | none |
| `OnChainDataProvider` | Chain adapters (see below) | Configured RPC and explorer URLs | Chain env vars |
| `WebResearchProvider` | `DisabledWebResearchProvider` | none | Not implemented; returns `DATA_UNAVAILABLE` |

`DataServices` bundles one of each. `createServerDataServices(env, fetchImpl?)` in `src/core/data/server.ts` builds it from an environment map (the CLI passes the process environment merged with data settings from the config file). Tests pass a synthetic env and a mocked `fetchImpl`.

Each provider exposes `enabled`, which is `false` when required configuration is missing.

Users are responsible for complying with each provider's terms of use and rate limits. Adapters cache some responses briefly (for example DefiLlama's protocol list) to reduce upstream load.

### Adding a data provider

1. Implement the interface in `src/core/data/<name>.ts`. Use `fetch-json.ts` for requests with timeouts, and parse responses with zod. Map missing fields to `null`.
2. Include a `SourceRef` (provider, name, optional public URL, `fetchedAt`) for every result. Never put API keys or credentialed URLs in sources.
3. Wire it into `createServerDataServices(env)`, reading keys from `env` only.
4. Add env vars to `.env.example` and the README table.
5. Test with recorded responses under `tests/fixtures/`, labelled `DEV FIXTURE`.

## Chain adapters

`src/core/chain` defines `ChainAdapter`:

```ts
interface ChainAdapter {
  readonly config: ChainConfig;
  readonly configured: boolean;
  getChainStatus(): Promise<ChainStatus>;
  getBlock(blockNumber?: bigint): Promise<Block>;
  getTransaction(hash: string): Promise<Transaction>;
  getBalance(address: string): Promise<NativeBalance>;
  getTokenBalance(address: string, tokenAddress: string): Promise<TokenBalance>;
  getTokenMetadata(tokenAddress: string): Promise<TokenMetadata>;
  getTokenBalances(address: string): Promise<TokenBalance[]>;        // needs explorer API
  getAddressTransactions(address: string, limit?: number): Promise<Transaction[]>; // needs explorer API
  getContractInfo(address: string): Promise<ContractInfo>;
}
```

`EvmChainAdapter` implements it with viem for JSON-RPC and a Blockscout-compatible explorer API for address history and token lists. `onchain-provider.ts` maps chain slugs to adapters and exposes them as an `OnChainDataProvider`. `rovanta chain status` and `rovanta wallet` use the same adapters.

| Slug | Adapter | Env vars |
| --- | --- | --- |
| `robinhood` | `RobinhoodChainAdapter` (EVM) | `ROBINHOOD_CHAIN_RPC_URL`, `ROBINHOOD_CHAIN_ID`, `ROBINHOOD_CHAIN_EXPLORER_URL`, `ROBINHOOD_CHAIN_EXPLORER_API_URL`, `ROBINHOOD_CHAIN_NATIVE_SYMBOL` |
| `ethereum` | Generic EVM (`src/core/chain/generic.ts`) | `ETHEREUM_RPC_URL`, `ETHEREUM_EXPLORER_URL`, `ETHEREUM_EXPLORER_API_URL` |

Initial ecosystem support: Robinhood Chain. No RPC endpoints are bundled; take them from the official Robinhood Chain documentation. Endpoint URLs must be `https` (`http` only on localhost). An unconfigured chain returns `RPC_NOT_CONFIGURED`; RPC failures return `RPC_UNAVAILABLE`. RPC URLs are never included in sources or output.

### Adding a chain

1. For EVM chains, add an entry to `GENERIC_EVM_CHAINS` in `src/core/chain/generic.ts` (slug, name, chain id, native symbol and env var names). For chains that need custom config parsing, read it from env using `parseEndpointUrl`, `parseChainId` and `parseSymbol` from `config.ts`. Do not hard-code endpoints.
2. For non-EVM chains, implement `ChainAdapter`.
3. Make sure the slug passes the chain slug validator (`src/core/security/validators.ts`).
4. Document the env vars in `.env.example`, the README and this file.
5. Test with a mocked transport or recorded fixtures.
