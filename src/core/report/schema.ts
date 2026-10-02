import { z } from "zod";

export const CLAIM_KINDS = ["FACT", "INFERENCE", "UNKNOWN"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const ClaimSchema = z.object({
  text: z.string().min(1).max(2000),
  kind: z.enum(CLAIM_KINDS),
  /** Evidence ids (e.g. "E1") from tool results that support the claim. */
  evidenceIds: z.array(z.string()).default([]),
  /** Set by validation when a claim's label was changed. */
  downgraded: z.boolean().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ReportSectionSchema = z.object({
  summary: z.string().max(4000).default(""),
  claims: z.array(ClaimSchema).default([]),
});
export type ReportSection = z.infer<typeof ReportSectionSchema>;

export const SECTION_KEYS = [
  "overview",
  "market",
  "liquidity",
  "activity",
  "protocol",
  "narrative",
  "ecosystem",
  "catalysts",
  "risks",
  "unknowns",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  overview: "Overview",
  market: "Market",
  liquidity: "Liquidity",
  activity: "Activity",
  protocol: "Protocol",
  narrative: "Narrative",
  ecosystem: "Developer / ecosystem signals",
  catalysts: "Potential catalysts",
  risks: "Risks",
  unknowns: "Unknowns",
};

export const EvidenceItemSchema = z.object({
  id: z.string(),
  tool: z.string(),
  input: z.unknown(),
  summary: z.string(),
  sources: z.array(
    z.object({
      provider: z.string(),
      name: z.string(),
      url: z.string().optional(),
      fetchedAt: z.string(),
    }),
  ),
  fetchedAt: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** What the model is asked to produce. */
export const ReportDraftSchema = z.object({
  title: z.string().min(1).max(200),
  subject: z.string().min(1).max(200),
  sections: z.object(
    Object.fromEntries(SECTION_KEYS.map((k) => [k, ReportSectionSchema.default({ summary: "", claims: [] })])) as {
      [K in SectionKey]: z.ZodDefault<typeof ReportSectionSchema>;
    },
  ),
  openQuestions: z.array(z.string().max(500)).default([]),
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

/** The finished report shown to the user. */
export const ResearchReportSchema = ReportDraftSchema.extend({
  id: z.string(),
  question: z.string(),
  generatedAt: z.string(),
  model: z.object({ provider: z.string(), model: z.string() }),
  dataSources: z.array(z.string()),
  evidence: z.array(EvidenceItemSchema),
  /** True when the model draft failed and the report was assembled from evidence only. */
  fallback: z.boolean().default(false),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
