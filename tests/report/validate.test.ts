import { describe, expect, it } from "vitest";
import {
  buildFallbackReportDraft,
  enforceEvidence,
  parseReportDraft,
  reportStats,
} from "@/core/report/validate";
import { SECTION_KEYS } from "@/core/report/schema";
import { FIXTURE_EVIDENCE, fixtureDraft } from "./fixtures";

const minimal = {
  title: "DEV FIXTURE",
  subject: "DEVTOKEN",
  sections: { market: { summary: "ok", claims: [{ text: "Price is 1.", kind: "FACT", evidenceIds: ["E1"] }] } },
};

describe("parseReportDraft", () => {
  it("parses fenced JSON", () => {
    const text = "```json\n" + JSON.stringify(minimal) + "\n```";
    const draft = parseReportDraft(text);
    expect(draft?.title).toBe("DEV FIXTURE");
    expect(draft?.sections.market.claims[0].kind).toBe("FACT");
  });

  it("parses JSON wrapped in prose, including braces inside strings", () => {
    const body = { ...minimal, title: "Has } brace { in title" };
    const text = `Here is the report:\n${JSON.stringify(body)}\nLet me know {if} anything else.`;
    expect(parseReportDraft(text)?.title).toBe("Has } brace { in title");
  });

  it("skips an unparseable leading brace group", () => {
    const text = `{not json} then ${JSON.stringify(minimal)}`;
    expect(parseReportDraft(text)?.subject).toBe("DEVTOKEN");
  });

  it("returns null for invalid input without throwing", () => {
    expect(parseReportDraft("")).toBeNull();
    expect(parseReportDraft("no json here")).toBeNull();
    expect(parseReportDraft("{\"title\": ")).toBeNull();
    expect(parseReportDraft("{}")).toBeNull();
    expect(parseReportDraft(undefined as unknown as string)).toBeNull();
  });

  it("coerces lenient inputs", () => {
    const raw = {
      title: "DEV FIXTURE",
      subject: "DEVTOKEN",
      sections: {
        market: {
          claims: [
            { text: "a", kind: "fact", evidenceIds: ["E1"] },
            { text: "b", kind: "Unknown" },
            { text: "c", kind: "speculation" },
            "plain string claim",
            { text: "d", kind: "FACT", evidenceIds: ["E1"], downgraded: false },
            ...Array.from({ length: 20 }, (_, i) => `extra ${i}`),
          ],
        },
      },
      openQuestions: Array.from({ length: 15 }, (_, i) => `q${i}`),
    };
    const draft = parseReportDraft(JSON.stringify(raw));
    expect(draft).not.toBeNull();
    const claims = draft!.sections.market.claims;
    expect(claims).toHaveLength(12);
    expect(claims[0].kind).toBe("FACT");
    expect(claims[1].kind).toBe("UNKNOWN");
    expect(claims[2].kind).toBe("INFERENCE");
    expect(claims[3]).toEqual({ text: "plain string claim", kind: "INFERENCE", evidenceIds: [] });
    expect(claims[4].downgraded).toBeUndefined();
    expect(draft!.openQuestions).toHaveLength(10);
    for (const key of SECTION_KEYS) expect(draft!.sections[key]).toBeDefined();
    expect(draft!.sections.risks).toEqual({ summary: "", claims: [] });
  });
});

describe("enforceEvidence", () => {
  it("downgrades FACT claims without evidence", () => {
    const draft = fixtureDraft({
      sections: { market: { claims: [{ text: "Volume is high.", kind: "FACT", evidenceIds: [] }] } },
    });
    const out = enforceEvidence(draft, FIXTURE_EVIDENCE);
    expect(out.sections.market.claims[0]).toMatchObject({ kind: "INFERENCE", downgraded: true });
  });

  it("drops unknown evidence ids and downgrades if none remain", () => {
    const draft = fixtureDraft({
      sections: {
        market: {
          claims: [
            { text: "x", kind: "FACT", evidenceIds: ["E1", "E99"] },
            { text: "y", kind: "FACT", evidenceIds: ["E42"] },
            { text: "z", kind: "UNKNOWN", evidenceIds: [] },
          ],
        },
      },
    });
    const [x, y, z] = enforceEvidence(draft, FIXTURE_EVIDENCE).sections.market.claims;
    expect(x).toMatchObject({ kind: "FACT", evidenceIds: ["E1"] });
    expect(x.downgraded).toBeUndefined();
    expect(y).toMatchObject({ kind: "INFERENCE", evidenceIds: [], downgraded: true });
    expect(z).toMatchObject({ kind: "UNKNOWN", evidenceIds: [] });
    expect(z.downgraded).toBeUndefined();
  });

  it("downgrades predictive FACT claims even with evidence", () => {
    const draft = fixtureDraft({
      sections: {
        market: {
          claims: [
            { text: "The price will double.", kind: "FACT", evidenceIds: ["E1"] },
            { text: "This token is going to the moon.", kind: "FACT", evidenceIds: ["E1"] },
            { text: "Willow pool volume is 1M.", kind: "FACT", evidenceIds: ["E1"] },
          ],
        },
      },
    });
    const [a, b, c] = enforceEvidence(draft, FIXTURE_EVIDENCE).sections.market.claims;
    expect(a).toMatchObject({ kind: "INFERENCE", downgraded: true });
    expect(b).toMatchObject({ kind: "INFERENCE", downgraded: true });
    expect(c.kind).toBe("FACT");
  });

  it("removes hype and advice claims entirely", () => {
    const draft = fixtureDraft({
      sections: {
        market: {
          claims: [
            { text: "Buy now before it is too late.", kind: "INFERENCE", evidenceIds: [] },
            { text: "Guaranteed returns for holders.", kind: "FACT", evidenceIds: ["E1"] },
            { text: "You can't lose with this.", kind: "INFERENCE", evidenceIds: [] },
            { text: "Our price target is 10 USD.", kind: "INFERENCE", evidenceIds: [] },
            { text: "This is not financial advice.", kind: "UNKNOWN", evidenceIds: [] },
            { text: "Price is 1.23 USD.", kind: "FACT", evidenceIds: ["E1"] },
          ],
        },
      },
    });
    const claims = enforceEvidence(draft, FIXTURE_EVIDENCE).sections.market.claims;
    expect(claims.map((c) => c.text)).toEqual(["Price is 1.23 USD."]);
  });

  it("does not mutate the input draft", () => {
    const draft = fixtureDraft({
      sections: { market: { claims: [{ text: "x", kind: "FACT", evidenceIds: ["E9"] }] } },
    });
    const snapshot = structuredClone(draft);
    enforceEvidence(draft, FIXTURE_EVIDENCE);
    expect(draft).toEqual(snapshot);
  });
});

describe("buildFallbackReportDraft", () => {
  it("maps evidence into sections by tool", () => {
    const evidence = [
      ...FIXTURE_EVIDENCE,
      { ...FIXTURE_EVIDENCE[0], id: "E3", tool: "get_token_holders", summary: "DEV FIXTURE holders" },
      { ...FIXTURE_EVIDENCE[0], id: "E4", tool: "get_wallet_activity", summary: "DEV FIXTURE wallets" },
    ];
    const draft = buildFallbackReportDraft("What about DEVTOKEN?", evidence);
    expect(draft.title).toBe("Research summary");
    expect(draft.subject).toBe("What about DEVTOKEN?");
    expect(draft.sections.overview.summary).toMatch(/could not be parsed/);
    expect(draft.sections.market.claims.map((c) => c.evidenceIds[0])).toEqual(["E1", "E3"]);
    expect(draft.sections.liquidity.claims[0]).toMatchObject({ kind: "FACT", evidenceIds: ["E2"] });
    expect(draft.sections.activity.claims[0].evidenceIds).toEqual(["E4"]);
    expect(draft.sections.protocol.claims).toHaveLength(0);
    expect(draft.sections.unknowns.claims).toHaveLength(1);
    expect(draft.sections.unknowns.claims[0]).toMatchObject({ kind: "UNKNOWN" });
    expect(draft.sections.unknowns.claims[0].text).toMatch(/^Insufficient data to determine/);
    expect(draft.sections.risks.claims[0]).toMatchObject({
      kind: "UNKNOWN",
      text: "Risk assessment requires model analysis, which was unavailable.",
    });
    expect(enforceEvidence(draft, evidence)).toEqual(draft);
  });

  it("handles the no-evidence case and truncates the subject", () => {
    const draft = buildFallbackReportDraft("q".repeat(300), []);
    expect(draft.subject).toHaveLength(120);
    expect(draft.sections.overview.claims).toEqual([
      { text: "No evidence was collected.", kind: "UNKNOWN", evidenceIds: [] },
    ]);
    expect(draft.sections.unknowns.claims).toHaveLength(4);
    expect(reportStats(draft)).toEqual({ facts: 0, inferences: 0, unknowns: 6, downgraded: 0 });
  });
});

describe("reportStats", () => {
  it("counts claim kinds and downgrades", () => {
    const draft = enforceEvidence(
      fixtureDraft({
        sections: {
          market: {
            claims: [
              { text: "a", kind: "FACT", evidenceIds: ["E1"] },
              { text: "b", kind: "FACT", evidenceIds: [] },
              { text: "c", kind: "UNKNOWN", evidenceIds: [] },
            ],
          },
        },
      }),
      FIXTURE_EVIDENCE,
    );
    expect(reportStats(draft)).toEqual({ facts: 1, inferences: 1, unknowns: 1, downgraded: 1 });
  });
});
