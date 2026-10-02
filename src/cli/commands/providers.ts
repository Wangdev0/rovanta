import { parseArgs } from "node:util";
import { listProviders } from "@/core/llm/registry";
import type { LLMConfig, ProviderInfo } from "@/core/llm/types";
import { resolveLLMConfig } from "../config";
import { writeLine, type CliIO, type CommandHandler } from "../io";
import { renderTable } from "../render/table";
import { createStyle, sanitizeTerminalText } from "../style";
import { safeErrorMessage } from "./wallet";

export const PROVIDERS_HELP = `Usage: rovanta providers [options]

List the supported LLM providers and show which one is configured.

Options:
  --json       Print machine-readable JSON
  -h, --help   Show this help`;

export interface ProvidersDeps {
  providers?: () => ProviderInfo[];
  resolveConfig?: (env: NodeJS.ProcessEnv) => Promise<LLMConfig | null>;
}

export function createProvidersCommand(deps: ProvidersDeps = {}): CommandHandler {
  const getProviders = deps.providers ?? listProviders;
  const resolveConfig = deps.resolveConfig ?? ((env: NodeJS.ProcessEnv) => resolveLLMConfig(env));

  async function currentConfig(io: CliIO): Promise<{ config: LLMConfig | null; error: string | null }> {
    try {
      return { config: await resolveConfig(io.env), error: null };
    } catch (err) {
      return { config: null, error: safeErrorMessage(err).message };
    }
  }

  return async (args, io) => {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        allowPositionals: false,
        strict: true,
        options: {
          json: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
      }));
    } catch (err) {
      writeLine(io.stderr, `${(err as Error).message}\n\n${PROVIDERS_HELP}`);
      return 2;
    }
    if (values.help) {
      writeLine(io.stdout, PROVIDERS_HELP);
      return 0;
    }

    const providers = getProviders();
    const { config, error } = await currentConfig(io);
    // Only the provider id and model are surfaced: never the key, and not a custom base URL (it may embed credentials).
    const configured = config ? { provider: config.provider, model: config.model } : null;

    if (values.json) {
      const list = providers.map((p) => ({
        id: p.id,
        label: p.label,
        defaultBaseUrl: p.defaultBaseUrl ?? null,
        requiresBaseUrl: p.requiresBaseUrl,
        docsUrl: p.docsUrl,
        configured: configured?.provider === p.id,
      }));
      writeLine(io.stdout, JSON.stringify({ providers: list, configured, ...(error ? { configError: error } : {}) }, null, 2));
      return 0;
    }

    const style = createStyle(io.color);
    const rows = providers.map((p) => [
      configured?.provider === p.id ? style.green("*") : " ",
      style.cyan(p.id),
      p.label,
      p.defaultBaseUrl ?? "-",
      p.requiresBaseUrl ? "yes" : "no",
      style.link(p.docsUrl, p.docsUrl),
    ]);
    writeLine(
      io.stdout,
      renderTable(rows, { header: ["", "ID", "Label", "Default base URL", "Base URL required", "Docs"], style }),
    );
    writeLine(io.stdout);
    if (configured) {
      writeLine(
        io.stdout,
        `Configured: ${style.bold(sanitizeTerminalText(configured.provider))} / ${sanitizeTerminalText(configured.model)}`,
      );
    } else if (error) {
      writeLine(io.stdout, style.yellow(`Could not read LLM config: ${error}`));
    } else {
      writeLine(io.stdout, style.dim("No provider configured. Run: rovanta config init"));
    }
    return 0;
  };
}

export const runProvidersCommand = createProvidersCommand();
