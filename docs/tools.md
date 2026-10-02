# Tools

ROVANTA ships 14 read-only research tools, registered by `createDefaultRegistry()` in `src/core/tools/index.ts`. Each has a zod input schema (exposed to the model as JSON Schema), a zod output schema, a timeout (15 s default) and a one-line summary used in progress output and the evidence list.

`rovanta tools` lists them; `rovanta tools --json` prints the same list in machine-readable form.

In all outputs, `null` means unknown. It never means zero.

## Token identifier

Several market tools accept a token identifier with these optional fields. At least one of `assetId`, `symbol` or `address` is required.

| Field | Description |
| --- | --- |
| `assetId` | CoinGecko-style asset id, e.g. `ethereum`. Most precise. |
| `symbol` | Ticker, e.g. `ETH`. Can be ambiguous. |
| `chain` | Chain slug, used with `address`. |
| `address` | Token contract address on `chain`. |

## Tool list

| Tool | Category | Input | Output | Data source |
| --- | --- | --- | --- | --- |
| `search_tokens` | market | `query` (name, symbol or address), `limit` 1-10 | Candidate tokens: assetId, name, symbol, chain, address, market cap rank, provider | CoinGecko |
| `get_token_metadata` | market | Token identifier | Name, symbol, decimals, chain, address, description, website, categories, total supply | CoinGecko; contract reads via chain adapter when chain+address is on a supported chain |
| `get_token_price` | market | Token identifier | USD price, 24h change %, `asOf` | CoinGecko |
| `get_market_data` | market | Token identifier | Price, market cap, FDV, 24h volume, 24h/7d change, circulating/total supply, ATH, `asOf` | CoinGecko |
| `get_volume` | market | Token identifier, `days` 1-90 | 24h USD volume and daily volume history | CoinGecko |
| `get_liquidity` | liquidity | Token identifier | Total DEX liquidity and pools (dex, pair, liquidity, 24h volume, buys/sells, created at) | DexScreener |
| `compare_assets` | analysis | 2-5 token identifiers, optional `metrics` | One row per asset: price, market cap, 24h volume, 24h/7d change, optional liquidity, per-row error | CoinGecko, DexScreener |
| `search_protocols` | protocol | `query`, `limit` 1-10 | Protocol summaries: id/slug, name, category, chains, TVL, 1d/7d TVL change, URL | DefiLlama |
| `get_protocol_metadata` | protocol | `protocol` id or slug | Description, category, chains, TVL total and by chain, TVL changes, audits, links, recent daily TVL | DefiLlama |
| `get_chain_status` | onchain | `chain` (default `robinhood`) | Configured/reachable, chain id, latest block and time, gas price, RPC latency | Configured RPC |
| `get_transactions` | onchain | `chain`, exactly one of `hash` or `address`, `limit` 1-25 | Transactions: hash, block, time, from, to, value (wei string), status, method | Configured RPC; explorer API for address history |
| `get_wallet_activity` | onchain | `chain`, `address` | Native balance, ERC-20 balances, up to 10 recent transactions, `gaps` listing missing parts | Configured RPC and explorer API |
| `get_contract_info` | onchain | `chain`, `address` | Has bytecode, bytecode size, verification status, contract name, compiler, ERC-20 metadata | Configured RPC and explorer API |
| `generate_research_report` | analysis | `subject`, optional `focus` list | Acknowledgement that signals the end of the tool phase | None (control tool) |

Notes:

- `compare_assets` does not rank assets or make recommendations.
- `get_contract_info`: verification or a contract name does not imply a contract is safe.
- Address-history and token-list features need a Blockscout-compatible explorer API (for example `ROBINHOOD_CHAIN_EXPLORER_API_URL`). Without it they are reported as gaps.
- `generate_research_report` does not write the report. It tells the runtime to move to the report phase.
- `rovanta wallet` and `rovanta chain` call the same data layer directly, without a model.

## Execution guarantees

`executeTool` (`src/core/tools/executor.ts`):

1. Looks up the tool. Unknown names return `UNKNOWN_TOOL`.
2. Validates input with the tool's zod schema. Failure returns `INVALID_INPUT`.
3. Runs the tool with a timeout and the run's abort signal. Timeout returns `TOOL_TIMEOUT`.
4. Validates output with the tool's zod schema. Failure returns `MALFORMED_TOOL_RESULT`.
5. Returns a `ToolExecutionResult`: either `{ ok: true, data, sources, summary, durationMs, fetchedAt }` or `{ ok: false, error }`. It never throws.

## Writing a tool

See [Tool development](../README.md#tool-development) in the README for an example. Checklist:

- Lowercase snake_case name (enforced by `defineTool`).
- A description that states units, null semantics and limits. The model only sees the description and schema.
- `.describe()` on every input field.
- Return `sources` for every result.
- Validate addresses and chain slugs in `run`, throwing `RovantaError` with a specific code.
- Keep output small: cap list lengths and trim long strings.
- Read-only. No signing, no arbitrary URLs, no file or shell access, no code execution.
- Add it to `docs/tools.md` and add tests.
