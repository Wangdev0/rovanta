import type { ToolExecutionResult } from "../tools/types";
import { redactSecrets } from "./redact";

export const TRUNCATION_MARKER = " …[truncated]";
export const DEFAULT_STRING_CAP = 2000;
export const TOOL_DATA_CAP = 12_000;

export interface SanitizeResult<T> {
  text: T;
  flagged: string[];
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const HIDDEN_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const WRAPPER_TAG =
  /(?:<|&lt;|\uFF1C)(\s*\/?\s*(?:tool_data|tool_error|tool_result|system|user_request|user|assistant|developer|instructions?|im_start|im_end)\b)/gi;

const INJECTION_PATTERNS: Array<[name: string, pattern: RegExp]> = [
  ["ignore_instructions", /\bignore\s+(?:(?:all|any|previous|prior|above|earlier|the|your|of|these)\s+){1,4}instructions?\b/i],
  ["disregard_instructions", /\bdisregard\b[^\n]{0,60}?\binstructions?\b/i],
  ["role_override", /\byou\s+are\s+now\b/i],
  ["system_prompt", /\bsystem\s+prompt\b/i],
  ["new_instructions", /\bnew\s+instructions?\b/i],
  ["act_as", /\bact\s+as\b/i],
  ["developer_mode", /\bdeveloper\s+mode\b/i],
  ["reveal_secret", /\breveal\s+(?:your|the)\s+(?:system\s+)?(?:prompt|key|api[\s_-]*key|secret)/i],
  ["send_funds", /\bsend\s+(?:funds|eth|tokens)\b/i],
  ["private_key", /\bprivate[\s_-]*key\b/i],
  ["seed_phrase", /\bseed\s+phrase\b/i],
  ["tool_call_request", /\bcall\s+the\s+tool\b/i],
  ["promotion", /\b(?:buy\s+now|guaranteed\s+returns?)\b/i],
];

/**
 * Clean untrusted text before it reaches the model. The text is kept (it is
 * data), but instruction-like content is reported in `flagged`.
 */
export function sanitizeToolText(text: string, maxLen = DEFAULT_STRING_CAP): SanitizeResult<string> {
  const flagged = new Set<string>();
  let out = String(text).replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");

  const visible = out.replace(HIDDEN_CHARS, "");
  if (visible.length !== out.length) flagged.add("hidden_characters");
  out = visible;

  out = out.replace(WRAPPER_TAG, (_match, rest: string) => {
    flagged.add("wrapper_tag");
    return `‹${rest}`;
  });

  for (const [name, pattern] of INJECTION_PATTERNS) {
    if (pattern.test(out)) flagged.add(name);
  }

  if (out.length > maxLen) out = out.slice(0, Math.max(0, maxLen)) + TRUNCATION_MARKER;

  return { text: out, flagged: [...flagged] };
}

export interface SanitizeDeepOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxStringLength?: number;
  maxKeys?: number;
  maxKeyLength?: number;
}

export function sanitizeDeep(value: unknown, opts: SanitizeDeepOptions = {}): { value: unknown; flagged: string[] } {
  const maxDepth = opts.maxDepth ?? 8;
  const maxArrayItems = opts.maxArrayItems ?? 50;
  const maxStringLength = opts.maxStringLength ?? DEFAULT_STRING_CAP;
  const maxKeys = opts.maxKeys ?? 100;
  const maxKeyLength = opts.maxKeyLength ?? 128;
  const flagged = new Set<string>();
  const seen = new WeakSet<object>();
  const DROP = Symbol("drop");

  const text = (s: string, cap: number): string => {
    const result = sanitizeToolText(s, cap);
    for (const flag of result.flagged) flagged.add(flag);
    return result.text;
  };

  const walk = (input: unknown, depth: number): unknown => {
    switch (typeof input) {
      case "string":
        return text(input, maxStringLength);
      case "number":
        return Number.isFinite(input) ? input : null;
      case "boolean":
        return input;
      case "bigint":
        return input.toString();
      case "undefined":
      case "function":
      case "symbol":
        return DROP;
    }
    if (input === null) return null;
    if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.toISOString();

    const obj = input as object;
    if (depth >= maxDepth) return "[max depth]";
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const items: unknown[] = [];
        for (const item of obj.slice(0, maxArrayItems)) {
          const next = walk(item, depth + 1);
          if (next !== DROP) items.push(next);
        }
        if (obj.length > maxArrayItems) items.push(`…[${obj.length - maxArrayItems} more items]`);
        return items;
      }
      const out: Record<string, unknown> = {};
      const entries = Object.entries(obj);
      for (const [key, raw] of entries.slice(0, maxKeys)) {
        const next = walk(raw, depth + 1);
        if (next === DROP) continue;
        out[text(key, maxKeyLength)] = next;
      }
      if (entries.length > maxKeys) out["…truncated_keys"] = entries.length - maxKeys;
      return out;
    } finally {
      seen.delete(obj);
    }
  };

  const result = walk(value, 0);
  return { value: result === DROP ? null : result, flagged: [...flagged] };
}

function attr(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64);
  return cleaned || "unknown";
}

function serialize(value: unknown): string {
  return redactSecrets(JSON.stringify(value) ?? "null").replace(WRAPPER_TAG, (_m, rest: string) => `‹${rest}`);
}

const SHRINK_STEPS: SanitizeDeepOptions[] = [
  {},
  { maxStringLength: 500, maxArrayItems: 20, maxDepth: 6, maxKeys: 50 },
  { maxStringLength: 200, maxArrayItems: 8, maxDepth: 4, maxKeys: 25 },
];

/**
 * Serialize a tool result for the model inside an explicit untrusted-data
 * wrapper. Content can never close the wrapper because every tag-like
 * sequence in it is neutralized.
 */
export function wrapToolData(result: ToolExecutionResult, evidenceId?: string): string {
  const tool = attr(result.tool);

  if (!result.ok) {
    const message = sanitizeToolText(redactSecrets(result.error.message), 500).text;
    return `<tool_error tool="${tool}">\n${serialize({ code: result.error.code, message })}\n</tool_error>`;
  }

  const idAttr = evidenceId ? ` evidence_id="${attr(evidenceId)}"` : "";
  const open = `<tool_data tool="${tool}"${idAttr} untrusted="true">\n`;
  const close = "\n</tool_data>";

  let body = "";
  for (const step of SHRINK_STEPS) {
    const { value, flagged } = sanitizeDeep({ summary: result.summary, data: result.data, sources: result.sources }, step);
    const payload = value as Record<string, unknown>;
    if (flagged.length > 0) payload.security_flags = flagged;
    body = serialize(payload);
    if (body.length <= TOOL_DATA_CAP) return open + body + close;
  }

  const summary = sanitizeToolText(result.summary, 500);
  const preview = sanitizeToolText(JSON.stringify(result.data) ?? "null", TOOL_DATA_CAP / 2);
  const flags = [...new Set([...summary.flagged, ...preview.flagged])];
  const payload: Record<string, unknown> = {
    summary: summary.text,
    data_truncated: true,
    data_preview: preview.text,
    sources: sanitizeDeep(result.sources, SHRINK_STEPS[2]).value,
  };
  if (flags.length > 0) payload.security_flags = flags;
  body = serialize(payload);
  if (body.length > TOOL_DATA_CAP) body = body.slice(0, TOOL_DATA_CAP) + TRUNCATION_MARKER;
  return open + body + close;
}
