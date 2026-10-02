import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXECUTION_DISABLED_MESSAGE,
  EXECUTION_ENABLED,
  assertExecutionDisabled,
  getExecutionLayer,
} from "@/core/execution";

describe("execution layer", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is disabled", () => {
    expect(EXECUTION_ENABLED).toBe(false);
  });

  it("throws on every entry point", () => {
    expect(() => assertExecutionDisabled()).toThrow(EXECUTION_DISABLED_MESSAGE);
    expect(() => getExecutionLayer()).toThrow(EXECUTION_DISABLED_MESSAGE);
  });

  it("stays disabled when EXECUTION_ENABLED=true is set in the environment", async () => {
    vi.stubEnv("EXECUTION_ENABLED", "true");
    vi.resetModules();
    const fresh = await import("@/core/execution");
    expect(fresh.EXECUTION_ENABLED).toBe(false);
    expect(() => fresh.getExecutionLayer()).toThrow(
      "Execution is disabled in this build. It requires an audited implementation.",
    );
    expect(() => fresh.assertExecutionDisabled()).toThrow(EXECUTION_DISABLED_MESSAGE);
  });
});
