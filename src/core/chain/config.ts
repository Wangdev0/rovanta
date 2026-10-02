export type ChainEnv = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Accepts https URLs, or http only for local development hosts.
 * Anything else returns null so the chain is treated as not configured.
 */
export function parseEndpointUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return trimmed.replace(/\/+$/, "");
}

export function parseChainId(value: string | undefined | null): number | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parseSymbol(value: string | undefined | null, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9.]{1,16}$/.test(trimmed) ? trimmed : fallback;
}
