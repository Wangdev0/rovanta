// DEV FIXTURE: synthetic data for tests only; not real market data.
import { ReportDraftSchema, type EvidenceItem, type ReportDraft, type ResearchReport } from "@/core/report/schema";

export const FIXTURE_EVIDENCE: EvidenceItem[] = [
  {
    id: "E1",
    tool: "get_market_data",
    input: { symbol: "DEVTOKEN" },
    summary: "DEV FIXTURE: DEVTOKEN price 1.23 USD, 24h volume 4.5M USD.",
    sources: [
      { provider: "devfeed", name: "Dev Market Feed", url: "https://example.com/market", fetchedAt: "2026-01-01T00:00:00.000Z" },
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "E2",
    tool: "get_liquidity",
    input: { symbol: "DEVTOKEN" },
    summary: "DEV FIXTURE: Pool liquidity 2.0M USD across 3 pools.",
    sources: [
      { provider: "devdex", name: "Dev DEX", url: "javascript:alert(1)", fetchedAt: "2026-01-01T00:00:00.000Z" },
    ],
    fetchedAt: "2026-01-01T00:00:00.000Z",
  },
];

export function fixtureDraft(overrides: Partial<Record<string, unknown>> = {}): ReportDraft {
  return ReportDraftSchema.parse({
    title: "DEV FIXTURE report",
    subject: "DEVTOKEN",
    sections: {
      overview: { summary: "DEV FIXTURE overview.", claims: [] },
      market: {
        summary: "",
        claims: [
          { text: "DEVTOKEN trades at 1.23 USD.", kind: "FACT", evidenceIds: ["E1"] },
          { text: "Demand appears steady.", kind: "INFERENCE", evidenceIds: ["E1"] },
        ],
      },
      liquidity: {
        claims: [{ text: "Liquidity is 2.0M USD.", kind: "FACT", evidenceIds: ["E2"] }],
      },
      unknowns: { claims: [{ text: "Holder distribution is unknown.", kind: "UNKNOWN", evidenceIds: [] }] },
    },
    openQuestions: ["Who are the largest holders?"],
    ...overrides,
  });
}

export function fixtureReport(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    ...fixtureDraft(),
    id: "dev-fixture-1",
    question: "What is happening with DEVTOKEN?",
    generatedAt: "2026-01-01T12:00:00.000Z",
    model: { provider: "devprovider", model: "dev-model-1" },
    dataSources: ["Dev Market Feed", "Dev DEX"],
    evidence: FIXTURE_EVIDENCE,
    fallback: false,
    ...overrides,
  };
}
