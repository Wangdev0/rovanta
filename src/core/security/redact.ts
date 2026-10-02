const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{12,}/gi,
  /([?&](?:key|api_key|apikey|x_cg_demo_api_key|x_cg_pro_api_key)=)[^&\s"']+/gi,
];

export const REDACTED = "[REDACTED]";

/**
 * Remove API keys and other secrets from text before it is logged,
 * displayed or included in an error. Known secrets are removed verbatim.
 */
export function redactSecrets(text: string, knownSecrets: Array<string | undefined | null> = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED,
    );
  }
  return out;
}
