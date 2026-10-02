import {
  CLAIM_KINDS,
  ReportDraftSchema,
  SECTION_KEYS,
  type Claim,
  type ClaimKind,
  type EvidenceItem,
  type ReportDraft,
  type ReportSection,
  type SectionKey,
} from "./schema";

const MAX_CLAIMS_PER_SECTION = 12;
const MAX_OPEN_QUESTIONS = 10;
const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;
const MAX_CLAIM_TEXT = 2000;
const MAX_QUESTION = 500;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Returns each balanced `{...}` candidate in order of appearance, respecting JSON strings. */
function* jsonObjectCandidates(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}

function extractJsonObject(text: string): Json | null {
  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isObject(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function coerceKind(value: unknown): ClaimKind {
  const upper = str(value).toUpperCase();
  return (CLAIM_KINDS as readonly string[]).includes(upper) ? (upper as ClaimKind) : "INFERENCE";
}

function coerceEvidenceIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list
    .map((v) => (typeof v === "number" ? String(v) : str(v)))
    .filter((v) => v.length > 0);
}

function coerceClaim(value: unknown): Claim | null {
  if (typeof value === "string") {
    const text = truncate(value.trim(), MAX_CLAIM_TEXT);
    return text ? { text, kind: "INFERENCE", evidenceIds: [] } : null;
  }
  if (!isObject(value)) return null;
  const text = truncate(str(value.text ?? value.claim ?? value.statement), MAX_CLAIM_TEXT);
  if (!text) return null;
  return {
    text,
    kind: coerceKind(value.kind ?? value.label ?? value.type),
    evidenceIds: coerceEvidenceIds(value.evidenceIds ?? value.evidence ?? value.sources),
  };
}

function coerceSection(value: unknown): ReportSection {
  if (typeof value === "string") return { summary: truncate(value.trim(), MAX_SUMMARY), claims: [] };
  const rawClaims = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.claims) ? value.claims : [];
  const summary = isObject(value) ? truncate(str(value.summary), MAX_SUMMARY) : "";
  const claims = rawClaims
    .map(coerceClaim)
    .filter((c): c is Claim => c !== null)
    .slice(0, MAX_CLAIMS_PER_SECTION);
  return { summary, claims };
}

function coerceDraft(raw: Json): unknown {
  const sectionSource = isObject(raw.sections) ? raw.sections : raw;
  const sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, coerceSection(sectionSource[key])]));
  const title = str(raw.title);
  const subject = str(raw.subject);
  const openQuestions = (Array.isArray(raw.openQuestions) ? raw.openQuestions : [])
    .map((q) => truncate(str(q), MAX_QUESTION))
    .filter((q) => q.length > 0)
    .slice(0, MAX_OPEN_QUESTIONS);
  return {
    title: truncate(title || subject, MAX_TITLE),
    subject: truncate(subject || title, MAX_TITLE),
    sections,
    openQuestions,
  };
}

export function parseReportDraft(text: string): ReportDraft | null {
  try {
    if (typeof text !== "string" || !text) return null;
    const raw = extractJsonObject(text);
    if (!raw) return null;
    const result = ReportDraftSchema.safeParse(coerceDraft(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const PREDICTIVE_PATTERNS = [/\bwill\b/i, /\bguaranteed\b/i, /\bdefinitely\b/i, /\bcertain to\b/i, /\b100x\b/i, /\bmoon(?:ing)?\b/i];

const HYPE_PATTERNS = [
  /\bbuy now\b/i,
  /\bguaranteed returns?\b/i,
  /\bcan(?:'|’|no)?t lose\b/i,
  /\bcannot lose\b/i,
  /\bfinancial advice\b/i,
  /\bprice targets?\b/i,
];

export function isHypeClaim(text: string): boolean {
  return HYPE_PATTERNS.some((p) => p.test(text));
}

export function isPredictiveClaim(text: string): boolean {
  return PREDICTIVE_PATTERNS.some((p) => p.test(text));
}

function enforceClaim(claim: Claim, validIds: Set<string>): Claim | null {
  if (isHypeClaim(claim.text)) return null;
  const evidenceIds = claim.evidenceIds.filter((id) => validIds.has(id));
  const next: Claim = { ...claim, evidenceIds };
  if (next.kind === "FACT" && (evidenceIds.length === 0 || isPredictiveClaim(next.text))) {
    next.kind = "INFERENCE";
    next.downgraded = true;
  }
  return next;
}

/** Pure: returns a new draft with evidence references and labels enforced. */
export function enforceEvidence(draft: ReportDraft, evidence: readonly EvidenceItem[]): ReportDraft {
  const validIds = new Set(evidence.map((e) => e.id));
  const sections = Object.fromEntries(
    SECTION_KEYS.map((key) => {
      const section = draft.sections[key];
      const claims = section.claims
        .map((c) => enforceClaim(c, validIds))
        .filter((c): c is Claim => c !== null);
      return [key, { summary: section.summary, claims }];
    }),
  ) as ReportDraft["sections"];
  return { ...draft, sections, openQuestions: [...draft.openQuestions] };
}

type EvidenceSection = "market" | "liquidity" | "activity" | "protocol";

const EVIDENCE_SECTIONS: EvidenceSection[] = ["market", "liquidity", "activity", "protocol"];

const MISSING_SUBJECT: Record<EvidenceSection, string> = {
  market: "market conditions",
  liquidity: "liquidity conditions",
  activity: "on-chain activity",
  protocol: "protocol details",
};

const TOOL_SECTIONS: Record<string, EvidenceSection> = {
  search_tokens: "market",
  get_market_data: "market",
  get_volume: "market",
  compare_assets: "market",
  get_liquidity: "liquidity",
  get_transactions: "activity",
  get_wallet_activity: "activity",
  get_chain_status: "activity",
  get_contract_info: "activity",
  search_protocols: "protocol",
  get_protocol_metadata: "protocol",
};

export function sectionForTool(tool: string): SectionKey {
  if (TOOL_SECTIONS[tool]) return TOOL_SECTIONS[tool];
  if (tool.startsWith("get_token_")) return "market";
  return "overview";
}

/** Deterministic report built only from collected evidence, used when the model draft is unusable. */
export function buildFallbackReportDraft(question: string, evidence: readonly EvidenceItem[]): ReportDraft {
  const sections = Object.fromEntries(
    SECTION_KEYS.map((key) => [key, { summary: "", claims: [] as Claim[] }]),
  ) as ReportDraft["sections"];

  sections.overview.summary =
    "The model's report could not be parsed. This summary lists the evidence collected by the research tools without further analysis.";

  for (const item of evidence) {
    const text = truncate(item.summary.trim(), MAX_CLAIM_TEXT);
    if (!text) continue;
    const section = sections[sectionForTool(item.tool)];
    if (section.claims.length >= MAX_CLAIMS_PER_SECTION) continue;
    section.claims.push({ text, kind: "FACT", evidenceIds: [item.id] });
  }

  if (evidence.length === 0) {
    sections.overview.claims.push({ text: "No evidence was collected.", kind: "UNKNOWN", evidenceIds: [] });
  }

  for (const key of EVIDENCE_SECTIONS) {
    if (sections[key].claims.length === 0) {
      sections.unknowns.claims.push({
        text: `Insufficient data to determine ${MISSING_SUBJECT[key]}.`,
        kind: "UNKNOWN",
        evidenceIds: [],
      });
    }
  }

  sections.risks.claims.push({
    text: "Risk assessment requires model analysis, which was unavailable.",
    kind: "UNKNOWN",
    evidenceIds: [],
  });

  return {
    title: "Research summary",
    subject: truncate(question.trim(), 120) || "Unspecified question",
    sections,
    openQuestions: [],
  };
}

export interface ReportStats {
  facts: number;
  inferences: number;
  unknowns: number;
  downgraded: number;
}

export function reportStats(report: Pick<ReportDraft, "sections">): ReportStats {
  const stats: ReportStats = { facts: 0, inferences: 0, unknowns: 0, downgraded: 0 };
  for (const key of SECTION_KEYS) {
    for (const claim of report.sections[key]?.claims ?? []) {
      if (claim.kind === "FACT") stats.facts++;
      else if (claim.kind === "INFERENCE") stats.inferences++;
      else stats.unknowns++;
      if (claim.downgraded) stats.downgraded++;
    }
  }
  return stats;
}
