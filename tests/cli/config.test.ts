import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConfigCommand } from "@/cli/commands/config";
import {
  DATA_ENV_KEYS,
  configPath,
  loadConfig,
  maskDataValue,
  maskSecret,
  resolveDataEnv,
  resolveLLMConfig,
  saveConfig,
} from "@/cli/config";
import type { CliIO } from "@/cli/io";
import { ask, askSecret, choose } from "@/cli/prompt";

const RAW_KEY = "sk-test-0123456789abcdef9f2c";

let dir: string;
let env: NodeJS.ProcessEnv;

function makeIO(input?: string): CliIO & { out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => (out += chunk.toString()));
  stderr.on("data", (chunk) => (err += chunk.toString()));
  if (input !== undefined) stdin.end(input);
  return {
    stdout,
    stderr,
    stdin,
    env,
    cwd: dir,
    isTTY: false,
    color: false,
    out: () => out,
    err: () => err,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rovanta-config-"));
  env = { ROVANTA_CONFIG: join(dir, "nested", "config.json") };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("configPath", () => {
  it("prefers ROVANTA_CONFIG, then XDG_CONFIG_HOME, then HOME", () => {
    expect(configPath({ ROVANTA_CONFIG: "/tmp/x.json", XDG_CONFIG_HOME: "/xdg" })).toBe("/tmp/x.json");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" })).toBe("/xdg/rovanta/config.json");
    expect(configPath({ HOME: "/home/u" })).toBe("/home/u/.config/rovanta/config.json");
  });
});

describe("loadConfig / saveConfig", () => {
  it("returns an empty config when the file is missing", async () => {
    expect(await loadConfig(env)).toEqual({ version: 1 });
  });

  it("round-trips and writes the file with mode 0600 in a 0700 directory", async () => {
    const config = {
      version: 1 as const,
      llm: { provider: "anthropic" as const, model: "m-1", apiKey: RAW_KEY },
      env: { COINGECKO_API_KEY: "cg-key", NOT_ALLOWED: "x" },
    };
    const path = await saveConfig(config, env);
    expect(path).toBe(env.ROVANTA_CONFIG);
    expect(await loadConfig(env)).toEqual({
      version: 1,
      llm: { provider: "anthropic", model: "m-1", apiKey: RAW_KEY },
      env: { COINGECKO_API_KEY: "cg-key" },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
  });

  it("throws a clear error mentioning the path for invalid JSON", async () => {
    await saveConfig({ version: 1 }, env);
    await writeFile(env.ROVANTA_CONFIG as string, "{not json");
    await expect(loadConfig(env)).rejects.toThrow(env.ROVANTA_CONFIG as string);
  });

  it("rejects a config with the wrong shape", async () => {
    await saveConfig({ version: 1 }, env);
    await writeFile(env.ROVANTA_CONFIG as string, JSON.stringify({ version: 1, llm: { provider: "nope" } }));
    await expect(loadConfig(env)).rejects.toThrow(/invalid/);
  });
});

describe("DATA_ENV_KEYS", () => {
  it("includes the data and chain env vars read by the engine", () => {
    for (const key of [
      "COINGECKO_API_KEY",
      "COINGECKO_API_PLAN",
      "ROBINHOOD_CHAIN_RPC_URL",
      "ROBINHOOD_CHAIN_ID",
      "ROBINHOOD_CHAIN_EXPLORER_URL",
      "ROBINHOOD_CHAIN_EXPLORER_API_URL",
      "ROBINHOOD_CHAIN_NATIVE_SYMBOL",
      "ETHEREUM_RPC_URL",
      "ETHEREUM_EXPLORER_URL",
      "ETHEREUM_EXPLORER_API_URL",
    ]) {
      expect(DATA_ENV_KEYS).toContain(key);
    }
  });
});

describe("resolveLLMConfig", () => {
  beforeEach(async () => {
    await saveConfig(
      {
        version: 1,
        llm: { provider: "openai-compatible", model: "file-model", baseUrl: "https://file.example/v1", apiKey: "file-key" },
      },
      env,
    );
  });

  it("uses the config file when nothing else is set", async () => {
    expect(await resolveLLMConfig(env)).toEqual({
      provider: "openai-compatible",
      model: "file-model",
      baseUrl: "https://file.example/v1",
      apiKey: "file-key",
    });
  });

  it("applies precedence flag > env > file", async () => {
    env.ROVANTA_MODEL = "env-model";
    env.ROVANTA_BASE_URL = "https://env.example/v1";
    env.ROVANTA_API_KEY = "env-key";
    expect(await resolveLLMConfig(env)).toMatchObject({
      model: "env-model",
      baseUrl: "https://env.example/v1",
      apiKey: "env-key",
    });
    expect(await resolveLLMConfig(env, { model: "flag-model", baseUrl: "https://flag.example/v1" })).toMatchObject({
      model: "flag-model",
      baseUrl: "https://flag.example/v1",
      apiKey: "env-key",
    });
  });

  it("ignores empty env values", async () => {
    env.ROVANTA_MODEL = "  ";
    expect((await resolveLLMConfig(env))?.model).toBe("file-model");
  });

  it("does not reuse file model/key when another provider is selected", async () => {
    expect(await resolveLLMConfig(env, { provider: "anthropic", model: "model-x" })).toBeNull();
    env.ANTHROPIC_API_KEY = "ant-key";
    expect(await resolveLLMConfig(env, { provider: "anthropic", model: "model-x" })).toEqual({
      provider: "anthropic",
      model: "model-x",
      apiKey: "ant-key",
    });
  });

  it("throws for an unknown provider", async () => {
    await expect(resolveLLMConfig(env, { provider: "bogus" })).rejects.toThrow(/Unknown provider "bogus"/);
    env.ROVANTA_PROVIDER = "bogus";
    await expect(resolveLLMConfig(env)).rejects.toThrow(/Unknown provider/);
  });
});

describe("resolveLLMConfig provider env fallbacks", () => {
  it.each([
    ["openai-compatible", { OPENAI_API_KEY: "o" }, "o"],
    ["anthropic", { ANTHROPIC_API_KEY: "a" }, "a"],
    ["google", { GEMINI_API_KEY: "g1", GOOGLE_API_KEY: "g2" }, "g1"],
    ["google", { GOOGLE_API_KEY: "g2" }, "g2"],
  ])("%s reads its conventional key env var", async (provider, extra, expected) => {
    Object.assign(env, extra, { ROVANTA_PROVIDER: provider, ROVANTA_MODEL: "m" });
    expect((await resolveLLMConfig(env))?.apiKey).toBe(expected);
  });

  it("prefers ROVANTA_API_KEY over the conventional var", async () => {
    Object.assign(env, { ROVANTA_PROVIDER: "anthropic", ROVANTA_MODEL: "m", ROVANTA_API_KEY: "r", ANTHROPIC_API_KEY: "a" });
    expect((await resolveLLMConfig(env))?.apiKey).toBe("r");
  });

  it("does not use another provider's conventional var", async () => {
    Object.assign(env, { ROVANTA_PROVIDER: "anthropic", ROVANTA_MODEL: "m", OPENAI_API_KEY: "o" });
    expect(await resolveLLMConfig(env)).toBeNull();
  });

  it("returns null when provider, model or key is missing", async () => {
    expect(await resolveLLMConfig(env)).toBeNull();
    expect(await resolveLLMConfig({ ...env, ROVANTA_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "a" })).toBeNull();
    expect(await resolveLLMConfig({ ...env, ROVANTA_MODEL: "m", ANTHROPIC_API_KEY: "a" })).toBeNull();
    expect(await resolveLLMConfig({ ...env, ROVANTA_PROVIDER: "anthropic", ROVANTA_MODEL: "m" })).toBeNull();
  });
});

describe("resolveDataEnv", () => {
  it("merges file values under non-empty process env values", async () => {
    await saveConfig(
      { version: 1, env: { COINGECKO_API_KEY: "file-cg", ETHEREUM_RPC_URL: "https://file.rpc", COINGECKO_API_PLAN: "pro" } },
      env,
    );
    env.ETHEREUM_RPC_URL = "https://env.rpc";
    env.COINGECKO_API_PLAN = "";
    env.UNRELATED = "kept";
    const merged = await resolveDataEnv(env);
    expect(merged).toMatchObject({
      COINGECKO_API_KEY: "file-cg",
      ETHEREUM_RPC_URL: "https://env.rpc",
      COINGECKO_API_PLAN: "pro",
      UNRELATED: "kept",
    });
    expect(merged).not.toBe(env);
    expect(env.COINGECKO_API_KEY).toBeUndefined();
  });
});

describe("maskSecret / maskDataValue", () => {
  it("masks secrets", () => {
    expect(maskSecret(undefined)).toBe("(not set)");
    expect(maskSecret("short")).toBe("****");
    expect(maskSecret(RAW_KEY)).toBe("sk-t…9f2c");
  });

  it("masks key values and URLs carrying credentials or tokens", () => {
    expect(maskDataValue("COINGECKO_API_KEY", "CG-abcdefghijkl1234")).toBe("CG-a…1234");
    expect(maskDataValue("ETHEREUM_RPC_URL", "https://eth.example/v2/abcDEF1234567890xyz")).toBe("https://eth.example/****");
    expect(maskDataValue("ETHEREUM_RPC_URL", "https://eth.example/?apikey=abc")).toBe("https://eth.example/****");
    expect(maskDataValue("ETHEREUM_RPC_URL", "https://u:p@eth.example/")).toBe("https://eth.example/****");
    expect(maskDataValue("ETHEREUM_RPC_URL", "https://rpc.example.org")).toBe("https://rpc.example.org");
    expect(maskDataValue("COINGECKO_API_PLAN", "pro")).toBe("pro");
  });
});

describe("rovanta config command", () => {
  it("set / show --json / unset", async () => {
    let io = makeIO();
    expect(await runConfigCommand(["set", "provider", "openai-compatible"], io)).toBe(0);
    expect(await runConfigCommand(["set", "model", "gpt-x"], io)).toBe(0);
    expect(await runConfigCommand(["set", "base-url", "https://api.example.com/v1/"], io)).toBe(0);
    expect(await runConfigCommand(["set", "api-key", RAW_KEY], io)).toBe(0);
    expect(io.err()).toContain("shell history");
    expect(await runConfigCommand(["set", "COINGECKO_API_KEY", "CG-abcdefghijkl1234"], io)).toBe(0);
    expect(await runConfigCommand(["set", "ethereum_rpc_url", "https://eth.example/v2/abcDEF1234567890xyz"], io)).toBe(0);
    expect(io.out()).not.toContain(RAW_KEY);

    const stored = JSON.parse(await readFile(env.ROVANTA_CONFIG as string, "utf8"));
    expect(stored.llm).toEqual({
      provider: "openai-compatible",
      model: "gpt-x",
      baseUrl: "https://api.example.com/v1",
      apiKey: RAW_KEY,
    });

    io = makeIO();
    env.ROVANTA_MODEL = "env-model";
    expect(await runConfigCommand(["show", "--json", "--base-url", "https://flag.example/v1"], io)).toBe(0);
    const shown = JSON.parse(io.out());
    expect(shown.path).toBe(env.ROVANTA_CONFIG);
    expect(shown.ready).toBe(true);
    expect(shown.llm.provider).toEqual({ value: "openai-compatible", source: "file" });
    expect(shown.llm.model).toEqual({ value: "env-model", source: "env", envVar: "ROVANTA_MODEL" });
    expect(shown.llm.baseUrl).toEqual({ value: "https://flag.example/v1", source: "flag" });
    expect(shown.llm.apiKey.value).toBe(maskSecret(RAW_KEY));
    expect(shown.env.COINGECKO_API_KEY).toEqual({ value: "CG-a…1234", source: "file" });
    expect(shown.env.ETHEREUM_RPC_URL.value).toBe("https://eth.example/****");
    expect(io.out()).not.toContain(RAW_KEY);
    expect(io.out()).not.toContain("abcDEF1234567890xyz");

    io = makeIO();
    expect(await runConfigCommand(["unset", "api-key"], io)).toBe(0);
    expect(await runConfigCommand(["unset", "COINGECKO_API_KEY"], io)).toBe(0);
    expect(await loadConfig(env)).toEqual({
      version: 1,
      llm: { provider: "openai-compatible", model: "gpt-x", baseUrl: "https://api.example.com/v1" },
      env: { ETHEREUM_RPC_URL: "https://eth.example/v2/abcDEF1234567890xyz" },
    });
  });

  it("show (text) never prints the raw key and labels sources", async () => {
    await saveConfig({ version: 1, llm: { provider: "anthropic", model: "m-1", apiKey: RAW_KEY } }, env);
    const io = makeIO();
    expect(await runConfigCommand([], io)).toBe(0);
    const out = io.out();
    expect(out).not.toContain(RAW_KEY);
    expect(out).toContain(maskSecret(RAW_KEY));
    expect(out).toContain("config file");
    expect(out).toContain("Status: ready");
  });

  it("reads api-key from stdin when the value is omitted", async () => {
    const io = makeIO(`${RAW_KEY}\n`);
    expect(await runConfigCommand(["set", "api-key"], io)).toBe(0);
    expect((await loadConfig(env)).llm?.apiKey).toBe(RAW_KEY);
    expect(io.out() + io.err()).not.toContain(RAW_KEY);
  });

  it("validates provider ids, base URLs and data values", async () => {
    const io = makeIO();
    expect(await runConfigCommand(["set", "provider", "bogus"], io)).toBe(2);
    expect(await runConfigCommand(["set", "base-url", "http://remote.example.com"], io)).toBe(2);
    expect(await runConfigCommand(["set", "ETHEREUM_RPC_URL", "ftp://x"], io)).toBe(2);
    expect(await runConfigCommand(["set", "ROBINHOOD_CHAIN_ID", "abc"], io)).toBe(2);
    expect(await runConfigCommand(["set", "NOT_A_KEY", "1"], io)).toBe(2);
    expect(io.err()).toContain('Unknown provider "bogus"');
  });

  it("clears provider-specific values when the provider changes", async () => {
    await saveConfig({ version: 1, llm: { provider: "anthropic", model: "m-1", apiKey: RAW_KEY } }, env);
    const io = makeIO();
    expect(await runConfigCommand(["set", "provider", "google"], io)).toBe(0);
    expect((await loadConfig(env)).llm).toEqual({ provider: "google" });
  });

  it("handles path, help and usage errors", async () => {
    let io = makeIO();
    expect(await runConfigCommand(["path"], io)).toBe(0);
    expect(io.out().trim()).toBe(env.ROVANTA_CONFIG);
    io = makeIO();
    expect(await runConfigCommand(["--help"], io)).toBe(0);
    expect(io.out()).toContain("Usage:");
    io = makeIO();
    expect(await runConfigCommand(["frobnicate"], io)).toBe(2);
    expect(io.err()).toContain("Usage:");
    expect(await runConfigCommand(["show", "--bogus"], io)).toBe(2);
  });

  it("returns 1 for a corrupt config file", async () => {
    await saveConfig({ version: 1 }, env);
    await writeFile(env.ROVANTA_CONFIG as string, "{oops");
    const io = makeIO();
    expect(await runConfigCommand(["show"], io)).toBe(1);
    expect(io.err()).toContain(env.ROVANTA_CONFIG as string);
  });

  it("init with piped answers saves the config", async () => {
    const io = makeIO(`2\nanthropic-model\n\n${RAW_KEY}\n`);
    expect(await runConfigCommand(["init"], io)).toBe(0);
    expect((await loadConfig(env)).llm).toEqual({ provider: "anthropic", model: "anthropic-model", apiKey: RAW_KEY });
    expect(io.out()).toContain("Saved");
    expect(io.out() + io.err()).not.toContain(RAW_KEY);
  });

  it("init keeps the existing key on Enter and requires a base URL for openai-compatible", async () => {
    await saveConfig({ version: 1, llm: { provider: "openai-compatible", model: "old", apiKey: RAW_KEY } }, env);
    const io = makeIO(`\nnew-model\nhttp://remote.example.com\nhttps://llm.example.com/v1\n\n`);
    expect(await runConfigCommand(["init"], io)).toBe(0);
    expect((await loadConfig(env)).llm).toEqual({
      provider: "openai-compatible",
      model: "new-model",
      baseUrl: "https://llm.example.com/v1",
      apiKey: RAW_KEY,
    });
    expect(io.err()).toContain("https");
  });

  it("init with no input exits 2 and explains env vars", async () => {
    const io = makeIO("");
    expect(await runConfigCommand(["init"], io)).toBe(2);
    expect(io.err()).toContain("ROVANTA_API_KEY");
    expect(await loadConfig(env)).toEqual({ version: 1 });
  });
});

describe("prompt helpers", () => {
  it("ask / askSecret / choose read sequential piped lines", async () => {
    const io = makeIO("\nhello\nsecret\nbad\nb\n");
    expect(await ask(io, "Name", "dflt")).toBe("dflt");
    expect(await ask(io, "Name")).toBe("hello");
    expect(await askSecret(io, "Key")).toBe("secret");
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    expect(await choose(io, "Pick", options, "a")).toBe("b");
    await expect(ask(io, "More")).rejects.toThrow(/Input ended/);
  });
});
