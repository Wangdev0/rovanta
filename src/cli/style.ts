export interface Style {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  italic(s: string): string;
  underline(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
  magenta(s: string): string;
  /** Brand green, bold. */
  accent(s: string): string;
  /** OSC 8 hyperlink when enabled, else "text (url)" (url only if different from text). */
  link(text: string, url: string): string;
}

const ESC = "\x1b";

function sgr(open: string, close: string): (s: string) => string {
  return (s) => `${ESC}[${open}m${s}${ESC}[${close}m`;
}

const identity = (s: string): string => s;

export function createStyle(enabled: boolean): Style {
  if (!enabled) {
    return {
      enabled: false,
      bold: identity,
      dim: identity,
      italic: identity,
      underline: identity,
      green: identity,
      red: identity,
      yellow: identity,
      cyan: identity,
      gray: identity,
      magenta: identity,
      accent: identity,
      link: (text, url) => {
        const cleanUrl = sanitizeTerminalText(url).replace(/\s+/g, "");
        return cleanUrl && cleanUrl !== text ? `${text} (${cleanUrl})` : text;
      },
    };
  }
  return {
    enabled: true,
    bold: sgr("1", "22"),
    dim: sgr("2", "22"),
    italic: sgr("3", "23"),
    underline: sgr("4", "24"),
    green: sgr("32", "39"),
    red: sgr("31", "39"),
    yellow: sgr("33", "39"),
    cyan: sgr("36", "39"),
    gray: sgr("90", "39"),
    magenta: sgr("35", "39"),
    accent: (s) => `${ESC}[1;38;2;0;200;5m${s}${ESC}[22;39m`,
    link: (text, url) => {
      const cleanUrl = sanitizeTerminalText(url).replace(/\s+/g, "");
      if (!cleanUrl) return text;
      return `${ESC}]8;;${cleanUrl}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
    },
  };
}

/* eslint-disable no-control-regex -- these patterns exist to match terminal control sequences */
// OSC / DCS / SOS / PM / APC strings (7-bit and 8-bit introducers), terminated by BEL or ST, or unterminated.
const STRING_SEQ = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
// CSI sequences (7-bit and 8-bit).
const CSI_SEQ = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
// Remaining two-character and nF escape sequences.
const OTHER_ESC = /\x1b[ -/]*[0-~]/g;

export function stripAnsi(s: string): string {
  return String(s).replace(STRING_SEQ, "").replace(CSI_SEQ, "").replace(OTHER_ESC, "");
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const BIDI_AND_HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/* eslint-enable no-control-regex */

/** Remove ANSI/OSC sequences and control characters (except \n and \t) from untrusted text. */
export function sanitizeTerminalText(s: string): string {
  return stripAnsi(String(s).replace(/\r\n?/g, "\n"))
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_AND_HIDDEN, "");
}

/** Visible width of a string that may contain ANSI sequences (counts code points). */
export function visibleWidth(s: string): number {
  return Array.from(stripAnsi(s)).length;
}
