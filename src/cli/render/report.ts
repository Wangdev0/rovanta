import { safeHttpUrl } from "../../core/report/markdown";
import { SECTION_KEYS, SECTION_TITLES, type Claim, type ClaimKind, type ResearchReport } from "../../core/report/schema";
import { sanitizeTerminalText, visibleWidth, type Style } from "../style";
import { renderTable } from "./table";

const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 40;
const BADGE_WIDTH = "[INFERENCE]".length;

function clean(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

/** Word-wrap plain text. First line is prefixed with `first`, continuation lines with `rest`. */
export function wrapText(text: string, width: number, first = "", rest = first): string[] {
  const lines: string[] = [];
  const paragraphs = sanitizeTerminalText(text).split(/\n\s*\n/);
  let prefix = first;
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = "";
    const room = (): number => Math.max(10, width - Array.from(prefix).length);
    const flush = (): void => {
      lines.push(prefix + current);
      prefix = rest;
      current = "";
    };
    for (const word of words) {
      let chars = Array.from(word);
      while (chars.length > room()) {
        if (current) flush();
        current = chars.slice(0, room()).join("");
        chars = chars.slice(room());
        flush();
      }
      const piece = chars.join("");
      if (!piece) continue;
      if (!current) current = piece;
      else if (Array.from(current).length + 1 + chars.length <= room()) current += ` ${piece}`;
      else {
        flush();
        current = piece;
      }
    }
    if (current) flush();
  }
  return lines;
}

function badge(kind: ClaimKind, style: Style): string {
  const label = `[${kind}]`;
  const padded = label + " ".repeat(Math.max(0, BADGE_WIDTH - label.length));
  switch (kind) {
    case "FACT":
      return style.bold(style.green(padded));
    case "INFERENCE":
      return style.bold(style.yellow(padded));
    default:
      return style.gray(padded);
  }
}

function claimLines(claim: Claim, style: Style, width: number): string[] {
  const indent = "  ";
  const hanging = indent + " ".repeat(BADGE_WIDTH + 1);
  const refs = claim.evidenceIds.map((id) => `[${clean(id)}]`).join(" ");
  const text = clean(claim.text);
  const wrapped = wrapText(refs ? `${text} ${refs}` : text, width, hanging, hanging);
  const lines = wrapped.map((line, i) => {
    const body = line.slice(hanging.length);
    return i === 0 ? `${indent}${badge(claim.kind, style)} ${body}` : line;
  });
  if (claim.downgraded) {
    lines.push(...wrapText("(labelled inference: no supporting evidence cited)", width, hanging).map(style.dim));
  }
  return lines;
}

const LABEL_MEANINGS: [ClaimKind, string][] = [
  ["FACT", "supported by cited evidence"],
  ["INFERENCE", "analysis, may be wrong"],
  ["UNKNOWN", "insufficient data"],
];

/** Key/value block whose values wrap with a hanging indent. */
function metadata(pairs: [string, string][], style: Style, width: number): string {
  const keyWidth = Math.max(...pairs.map(([key]) => key.length + 1)) + 2;
  const hang = " ".repeat(keyWidth);
  return pairs
    .map(([key, value]) => {
      const lines = wrapText(value, width, hang, hang);
      const label = style.dim(`${key}:`.padEnd(keyWidth));
      return [label + (lines[0] ?? hang).slice(keyWidth), ...lines.slice(1)].join("\n");
    })
    .join("\n");
}

function heading(text: string, style: Style): string {
  return style.bold(style.green(text));
}

/** Human-readable terminal rendering of a full ResearchReport. */
export function renderReportText(report: ResearchReport, style: Style, width = DEFAULT_WIDTH): string {
  const w = Math.max(MIN_WIDTH, Math.floor(Number.isFinite(width) ? width : DEFAULT_WIDTH));
  const rule = style.dim((style.enabled ? "─" : "-").repeat(w));
  const out: string[] = [];

  out.push(`${style.accent("ROVANTA")} ${style.dim("research report")}`);
  out.push(rule);
  out.push(...wrapText(clean(report.title), w).map(style.bold));
  out.push("");
  out.push(
    metadata(
      [
        ["Question", clean(report.question)],
        ["Subject", clean(report.subject)],
        ["Generated", clean(report.generatedAt)],
        ["Model", `${clean(report.model.provider)} / ${clean(report.model.model)}`],
        ["Data sources", report.dataSources.length ? report.dataSources.map(clean).join(", ") : "none"],
        ["Evidence", String(report.evidence.length)],
      ],
      style,
      w,
    ),
  );
  out.push("");

  if (report.fallback) {
    out.push(
      ...wrapText(
        "Fallback report: model output could not be parsed. Content is assembled from evidence only.",
        w,
        "! ",
        "  ",
      ).map(style.yellow),
      "",
    );
  }

  out.push(style.dim("Labels:"));
  for (const [kind, meaning] of LABEL_MEANINGS) out.push(`  ${badge(kind, style)} ${style.dim(meaning)}`);
  out.push("");

  for (const key of SECTION_KEYS) {
    const section = report.sections[key];
    const summary = sanitizeTerminalText(section.summary).trim();
    if (!summary && section.claims.length === 0) continue;
    const title = key === "overview" ? "Summary" : SECTION_TITLES[key];
    out.push(heading(key === "risks" ? `⚠ ${title}` : title, style));
    if (summary) out.push(...wrapText(summary, w, "  "));
    for (const claim of section.claims) out.push(...claimLines(claim, style, w));
    out.push("");
  }

  if (report.openQuestions.length) {
    out.push(heading("Open questions", style));
    for (const question of report.openQuestions) out.push(...wrapText(clean(question), w, "  • ", "    "));
    out.push("");
  }

  if (report.evidence.length) {
    out.push(heading("Evidence", style));
    const evidenceTable = (withFetched: boolean): string[] =>
      renderTable(
        report.evidence.map((item) => [
          clean(item.id),
          clean(item.tool),
          ...(withFetched ? [clean(item.fetchedAt)] : []),
          String(item.sources.length),
        ]),
        { header: ["ID", "Tool", ...(withFetched ? ["Fetched"] : []), "Sources"], style },
      )
        .split("\n")
        .map((line) => `  ${line}`);
    let table = evidenceTable(true);
    if (table.some((line) => visibleWidth(line) > w)) table = evidenceTable(false);
    out.push(...table);
    out.push("");

    out.push(heading("Sources", style));
    report.evidence.forEach((item, index) => {
      const number = `${index + 1}.`;
      const prefix = `  ${number} `;
      const rest = " ".repeat(prefix.length);
      const head = `[${clean(item.id)}] ${clean(item.tool)} — ${clean(item.summary)}`;
      out.push(...wrapText(head, w, prefix, rest));
      for (const source of item.sources) {
        const label = `${clean(source.name)} (${clean(source.provider)})`;
        const url = safeHttpUrl(source.url);
        out.push(`${rest}↳ ${url ? style.cyan(style.link(label, url)) : label}`);
      }
    });
    out.push("");
  }

  out.push(rule);
  out.push(style.dim("Generated by ROVANTA. Not investment advice."));
  return out.join("\n") + "\n";
}
