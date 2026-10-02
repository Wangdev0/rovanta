import { vi } from "vitest";
import type { FetchLike } from "@/core/data/fetch-json";

export type Route = { match: (url: string) => boolean; status?: number; body: unknown };

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fetch mock that answers the first matching route and records calls. */
export function mockFetch(routes: Route[]) {
  const fn = vi.fn<FetchLike>(async (url: string) => {
    const route = routes.find((r) => r.match(url));
    if (!route) return jsonResponse({ error: "no route" }, 404);
    return jsonResponse(route.body, route.status ?? 200);
  });
  return fn;
}

export const includes = (fragment: string) => (url: string) => url.includes(fragment);
