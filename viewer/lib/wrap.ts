// Card labels on two lines (issue #14). A label too wide for its card wraps
// to a second line, the card grows taller (and, when two lines are still not
// enough, wider up to a cap), and only then is the last line cut with an
// ellipsis. Pure: the width of a string is estimated from a fixed table, never
// measured in the page, so a scene's card sizes (what ELK lays out) are the
// same on every run, whatever fonts the browser has or when they load.
//
// The table holds, per printable ASCII character, the widest advance (in
// hundredths of an em, rounded up) of the UI font stack's first faces at
// weight 600: San Francisco (system-ui on macOS), Helvetica Neue and Arial.
// It overestimates most faces a little, so a label the estimate fits fits
// the drawn card too; a wider face (DejaVu Sans on some Linux desktops) is
// caught when drawing (ui/Graph.tsx), never by moving the layout.

/** Advance widths of " " (U+0020) to "~" (U+007E), in 1/100 em, at weight 600. */
const ASCII = [
  28, 34, 48, 63, 64, 100, 73, 28, 37, 37, 44, 64, 28, 44, 28, 38, 64, 56, 60, 62, 64, 62, 65, 57, 64, 65, 34, 34, 64, 64, 64, 62, 98, 73, 73, 75, 75, 67, 62,
  78, 75, 30, 56, 73, 62, 91, 75, 78, 67, 78, 73, 67, 62, 75, 67, 96, 67, 67, 65, 37, 38, 37, 64, 56, 50, 58, 62, 58, 62, 58, 34, 62, 62, 28, 28, 58, 28, 91,
  62, 62, 62, 62, 39, 56, 36, 62, 56, 82, 56, 56, 52, 39, 28, 39, 64,
];

/** A few common non-ASCII marks, 1/100 em. */
const MARKS: Record<string, number> = { "…": 100, "·": 34, "—": 100, "–": 56, "‘": 28, "’": 28, "“": 50, "”": 50, "«": 56, "»": 56, " ": 28 };
/** Han, kana, Hangul, full-width forms: one em, a hair more. */
const WIDE = 101;
/** Pictographs (emoji): wider than an em on most platforms. */
const EMOJI = 125;
/** Any other letter (Greek, Cyrillic, …): a generous average. */
const OTHER = 70;

export const ELLIPSIS = "…";

/** East Asian wide characters: each one is a place a line may break. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

const widthCache = new Map<string, number>();

/** One character's advance, in 1/100 em. */
function charUnits(ch: string): number {
  const hit = widthCache.get(ch);
  if (hit !== undefined) return hit;
  const cp = ch.codePointAt(0)!;
  let u: number;
  if (cp >= 0x20 && cp < 0x7f) u = ASCII[cp - 0x20]!;
  else if (MARKS[ch] !== undefined) u = MARKS[ch]!;
  else if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) u = 0;
  else if (isWide(cp)) u = WIDE;
  else if (cp >= 0x1f000 && cp <= 0x1faff) u = EMOJI;
  else {
    // An accented Latin letter is as wide as its base letter (é → e).
    const base = ch.normalize("NFD").charCodeAt(0);
    u = base >= 0x20 && base < 0x7f ? ASCII[base - 0x20]! : OTHER;
  }
  widthCache.set(ch, u);
  return u;
}

/** Estimated width in pixels of `text` at `size` px, weight 600. Deterministic. */
export function estimateWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) units += charUnits(ch);
  return (units * size) / 100;
}

export interface Wrapped {
  /** The lines drawn, at most the limit asked for. */
  lines: string[];
  /** The text did not fit in them: the last line ends with an ellipsis. */
  cut: boolean;
}

/** Where a line may end after the character at `i`: after a space, a hyphen, a slash, a dash; on either side of a wide character. */
function breakAfter(chars: readonly string[], i: number): boolean {
  const c = chars[i]!;
  const next = chars[i + 1];
  if (next === undefined) return true;
  if (c === " " || c === "-" || c === "/" || c === "–" || c === "—") return true;
  return isWide(c.codePointAt(0)!) || isWide(next.codePointAt(0)!);
}

/** The longest start of `chars` (from `from`) that fits `max` with `suffix` after it, at least one character. */
function fitChars(chars: readonly string[], from: number, max: number, size: number, suffix = ""): number {
  const room = max - estimateWidth(suffix, size);
  let w = 0;
  let end = from;
  while (end < chars.length) {
    const next = w + (charUnits(chars[end]!) * size) / 100;
    if (next > room) break;
    w = next;
    end++;
  }
  return Math.max(end, from + 1);
}

/**
 * `text` broken into at most `maxLines` lines of at most `max` pixels at
 * `size` px: at spaces, hyphens, slashes and between CJK characters; a word
 * longer than a line is broken where it reaches the edge. What does not fit
 * the last line is cut with an ellipsis. Deterministic: same text, same lines.
 */
export function wrapLabel(text: string, max: number, size: number, maxLines = 2): Wrapped {
  const clean = text.replace(/\s+/g, " ").trim();
  if (estimateWidth(clean, size) <= max || maxLines < 1) return { lines: [clean], cut: false };
  const chars = Array.from(clean);
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    if (lines.length === maxLines - 1) {
      const rest = chars.slice(start).join("");
      if (estimateWidth(rest, size) <= max) {
        lines.push(rest);
        return { lines, cut: false };
      }
      const end = fitChars(chars, start, max, size, ELLIPSIS);
      lines.push(`${chars.slice(start, end).join("").trimEnd()}${ELLIPSIS}`);
      return { lines, cut: true };
    }
    // The furthest break whose line (trailing space dropped) fits; else break the word at the edge.
    let w = 0;
    let lastBreak = -1;
    let i = start;
    for (; i < chars.length; i++) {
      w += (charUnits(chars[i]!) * size) / 100;
      const trimmed = chars[i] === " " ? w - (charUnits(" ") * size) / 100 : w;
      if (trimmed > max) break;
      if (breakAfter(chars, i)) lastBreak = i;
    }
    if (i === chars.length) {
      lines.push(chars.slice(start).join("").trim());
      break;
    }
    const end = lastBreak >= start ? lastBreak + 1 : fitChars(chars, start, max, size);
    lines.push(chars.slice(start, end).join("").trim());
    start = end;
    while (chars[start] === " ") start++;
  }
  return { lines, cut: false };
}

/** The roles whose cards wrap their label, and how they draw it. */
export type WrapRole = "card" | "cluster" | "chip" | "ghost";

export interface CardText {
  /** The card's size with a one-line label. */
  w: number;
  h: number;
  /** Widest the card may grow to fit its label on two lines. */
  maxW: number;
  /** Label left edge, right padding, font size and line height (px). */
  x: number;
  pad: number;
  size: number;
  line: number;
}

export const CARD_TEXT: Record<WrapRole, CardText> = {
  card: { w: 216, h: 64, maxW: 288, x: 52, pad: 12, size: 13, line: 16 },
  cluster: { w: 216, h: 64, maxW: 288, x: 52, pad: 12, size: 13, line: 16 },
  chip: { w: 164, h: 34, maxW: 220, x: 32, pad: 12, size: 12, line: 15 },
  ghost: { w: 184, h: 40, maxW: 240, x: 32, pad: 12, size: 12, line: 15 },
};

/** Lines a card label wraps to, at most. */
export const LABEL_LINES = 2;
/** The steps a card widens by, so sizes stay few and tidy. */
const WIDEN_STEP = 8;

const isWrapRole = (role: string): role is WrapRole => role in CARD_TEXT;

/** Room for the label on a card `w` wide; `reserve` is taken on the right (a flow step badge). */
export function labelRoom(role: WrapRole, w: number, reserve = 0): number {
  const c = CARD_TEXT[role];
  return w - c.x - c.pad - reserve;
}

/**
 * The size of a card for its label: unchanged when the label fits one line;
 * one line taller when it needs two, widened (in steps, up to `maxW`) only
 * when two lines at the base width are not enough. Past `maxW` the label is
 * cut on its second line. Deterministic: same role and label, same size.
 */
export function cardSize(role: string, label: string, reserve = 0): { w: number; h: number } | undefined {
  if (!isWrapRole(role)) return undefined;
  const c = CARD_TEXT[role];
  if (estimateWidth(label.replace(/\s+/g, " ").trim(), c.size) <= labelRoom(role, c.w, reserve)) return { w: c.w, h: c.h };
  const h = c.h + c.line * (LABEL_LINES - 1);
  for (let w = c.w; w < c.maxW; w += WIDEN_STEP) if (!wrapLabel(label, labelRoom(role, w, reserve), c.size, LABEL_LINES).cut) return { w, h };
  return { w: c.maxW, h };
}

/** The lines a card `w` wide draws its label on (the same estimate the size came from). */
export function cardLines(role: string, label: string, w: number, reserve = 0): Wrapped {
  if (!isWrapRole(role)) return { lines: [label], cut: false };
  const c = CARD_TEXT[role];
  return wrapLabel(label, labelRoom(role, w, reserve), c.size, LABEL_LINES);
}
