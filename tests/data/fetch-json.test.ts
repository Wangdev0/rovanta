import { describe, expect, it } from "vitest";
import { fetchJson, num, str } from "@/core/data/fetch-json";
import type { WebResearchProvider } from "@/core/data/types";
import { DisabledWebResearchProvider } from "@/core/data/web";
import { jsonResponse } from "./helpers";

describe("fetchJson", () => {
  it("maps statuses to error codes", async () => {
    const cases: Array<[number, string]> = [
      [429, "RATE_LIMITED"],
      [404, "DATA_UNAVAILABLE"],
      [500, "DATA_UNAVAILABLE"],
    ];
    for (const [status, code] of cases) {
      await expect(fetchJson(async () => jsonResponse({}, status), "https://example.invalid/x")).rejects.toMatchObject({ code });
    }
  });

  it("lets callers override the not-found code", async () => {
    await expect(
      fetchJson(async () => jsonResponse({}, 404), "https://example.invalid/x", { notFound: { code: "INVALID_TOKEN" } }),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("maps caller aborts to ABORTED and timeouts to DATA_UNAVAILABLE", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const controller = new AbortController();
    const pending = fetchJson(hang, "https://example.invalid/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    await expect(fetchJson(hang, "https://example.invalid/x", { timeoutMs: 10 })).rejects.toMatchObject({
      code: "DATA_UNAVAILABLE",
      message: expect.stringContaining("timed out"),
    });
  });

  it("redacts secrets and query strings from error messages", async () => {
    const err = await fetchJson(
      async () => {
        throw new Error("boom");
      },
      "https://example.invalid/path?x_cg_demo_api_key=SECRETSECRET",
      { secrets: ["SECRETSECRET"] },
    ).catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain("SECRETSECRET");
  });
});

describe("helpers", () => {
  it("num accepts finite numbers and numeric strings only", () => {
    expect(num(1.5)).toBe(1.5);
    expect(num("2.5")).toBe(2.5);
    expect(num(Infinity)).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num("")).toBeNull();
    expect(num(null)).toBeNull();
  });

  it("str trims and nulls empty strings", () => {
    expect(str(" a ")).toBe("a");
    expect(str("  ")).toBeNull();
    expect(str(3)).toBeNull();
  });
});

describe("DisabledWebResearchProvider", () => {
  it("is disabled and throws DATA_UNAVAILABLE", async () => {
    const web: WebResearchProvider = new DisabledWebResearchProvider();
    expect(web.enabled).toBe(false);
    await expect(web.search("x")).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
  });
});
