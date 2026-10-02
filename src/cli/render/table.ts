import { createStyle, visibleWidth, type Style } from "../style";

function padEnd(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

function cell(s: string | undefined): string {
  return (s ?? "").replace(/[\r\n\t]+/g, " ");
}

/**
 * Aligned columns. Cells may already contain styling; callers must sanitize
 * untrusted cell text before passing it in.
 */
export function renderTable(rows: string[][], options: { header?: string[]; style?: Style } = {}): string {
  const style = options.style ?? createStyle(false);
  const all = options.header ? [options.header, ...rows] : rows;
  const columns = Math.max(0, ...all.map((row) => row.length));
  if (columns === 0) return "";

  const widths = Array.from({ length: columns }, (_, i) => Math.max(0, ...all.map((row) => visibleWidth(cell(row[i])))));

  const line = (row: string[], format: (s: string) => string = (s) => s): string =>
    widths
      .map((width, i) => {
        const text = format(cell(row[i]));
        return i === columns - 1 ? text : padEnd(text, width);
      })
      .join("  ")
      .trimEnd();

  const out: string[] = [];
  if (options.header) {
    out.push(line(options.header, style.bold));
    const rule = style.enabled ? "─" : "-";
    out.push(style.dim(widths.map((w) => rule.repeat(w)).join("  ")));
  }
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

export function renderKeyValue(pairs: [string, string][], style: Style = createStyle(false)): string {
  if (pairs.length === 0) return "";
  const width = Math.max(...pairs.map(([key]) => visibleWidth(cell(key)) + 1));
  return pairs.map(([key, value]) => `${style.dim(padEnd(`${cell(key)}:`, width))}  ${cell(value)}`).join("\n");
}
