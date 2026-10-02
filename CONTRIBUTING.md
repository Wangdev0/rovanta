# Contributing to ROVANTA

Thanks for helping. This guide covers setup, conventions and the rules that keep ROVANTA's output trustworthy.

## Setup

Requirements: Node.js 20 or later (22+ recommended) and npm.

```bash
git clone https://github.com/Wangdev0/rovanta && cd rovanta
npm install
npm run dev -- --help
```

To test against a real model, configure one with `npm run dev -- config init` or export `ROVANTA_PROVIDER`, `ROVANTA_MODEL`, `ROVANTA_BASE_URL` and `ROVANTA_API_KEY`. To try the built binary, run `npm run build && npm link` and use `rovanta`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev -- <args>` | Run the CLI from source with tsx |
| `npm run build` | Bundle the CLI to `dist/cli.js` |
| `npm start -- <args>` | Run the built CLI |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |

Before opening a pull request, run `npm run lint && npm run typecheck && npm test && npm run build`, then `node dist/cli.js --help` as a smoke test. CI runs the same steps.

## Layout

- `src/core` is the research engine: agent loop, LLM adapters, tools, data and chain adapters, reports, security. It has no knowledge of the terminal.
- `src/cli` is the command-line interface on top of it: argument parsing, config resolution, prompts and rendering.

Keep that separation. Terminal concerns (colors, prompts, process exit codes) belong in `src/cli`; anything another frontend could reuse belongs in `src/core`.

## Adding a CLI command

1. Add a handler under `src/cli/commands/` with the `CommandHandler` signature from `src/cli/io.ts`. It receives arguments and a `CliIO` and returns an exit code.
2. Register it in the command table in `src/cli/index.ts`.
3. Write reports and data to `io.stdout` and progress, warnings and errors to `io.stderr`. Support `--json` where output is structured, and respect `io.color`.
4. Add tests that drive the handler with an in-memory `CliIO`. Document the command in the README.

## Adding a tool

1. Create the tool with `defineTool` under `src/core/tools/<area>/` (see the README's [Tool development](README.md#tool-development) section).
2. Export it from the area's `index.ts` so it is included in `createDefaultRegistry()`.
3. Add it to the table in `docs/tools.md`.
4. Add tests covering success, `null` handling for missing upstream fields, invalid input, and upstream errors.

## Adding a data provider

1. Implement the interface from `src/core/data/types.ts`. Return `{ data, sources }`, validated with the schemas in `src/core/data/schemas.ts`.
2. Wire it into `createServerDataServices` in `src/core/data/server.ts`.
3. Document it in `docs/providers.md` and any new env vars in `.env.example` and the README.

Only use endpoints you have verified in the provider's official documentation.

## Adding a chain

1. Add a `ChainConfig` read from env (see `src/core/chain/config.ts` for URL and id parsing). Do not hard-code RPC endpoints.
2. Reuse `EvmChainAdapter` for EVM chains (see `src/core/chain/generic.ts`), or implement `ChainAdapter` for others.
3. Register the chain in the on-chain provider and make sure its slug passes the validators.
4. Document the env vars. Do not describe any chain as a partner or endorser.

## Adding an LLM provider

Implement `LLMProvider`, map errors to `RovantaError` codes, register it with `registerProvider`, and test with a mocked `fetch`. API keys must never appear in errors, logs or progress output.

## Tests

- Every change to `src/core` or `src/cli` needs tests.
- Tests must not call live APIs. Mock `fetch` or use recorded fixtures.
- Tests must not read or write the real user config file. Point `ROVANTA_CONFIG` at a temporary path.
- Fixtures go under `tests/fixtures/` and must be clearly labelled `DEV FIXTURE` (a top-level comment or a `"_comment"` field). Fixtures are for tests only and must never be presented as real data.
- Security-relevant behaviour (sanitization, redaction, evidence enforcement, config file permissions, disabled execution) needs explicit tests.

## Code style

- TypeScript strict mode. Avoid `any`; validate unknown data with zod.
- Use `RovantaError` with a specific code rather than throwing bare strings.
- Keep modules small and dependency-free where possible. Do not add dependencies without a clear need.
- Comments explain constraints the code cannot show, not what the next line does.
- Match the existing formatting; ESLint is the source of truth.

## Rules

- **No fabricated data.** Never invent prices, volumes, addresses, endpoints or metrics. Missing data is `null` / UNKNOWN.
- **No placeholder data in output.** Fixtures stay in `tests/fixtures/` and are labelled `DEV FIXTURE`.
- **No hype copy.** No "moon", "100x", "guaranteed", buy/sell calls, price targets or adoption claims in code, prompts, docs or CLI output.
- **No unverified claims.** Do not claim partnerships, endorsements, user numbers or performance figures.
- **No secrets.** Never commit keys, config files or `.env` files, and never log credentials.
- **Read-only.** Do not add signing, transaction submission or private-key handling. The execution layer stays disabled until an audited design is accepted.

## Security issues

Report vulnerabilities through a private security advisory on the repository, not a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
