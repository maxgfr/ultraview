// Sentence-level citation rules for the prose the agent writes (summaries,
// notes, answers): every sentence carries at least one `[path:line]`.
//
// ultraindex's `citationlessClaims` judges a paragraph or list item as a whole;
// a paragraph with one cited sentence and three uncited ones passes it. This
// module splits prose into sentences first and asks `citationlessClaims` about
// each one, so its notion of "substantive" text and of what a citation is stays
// the engine's.

import { citationlessClaims } from "../engine.js";

const FENCE = /^\s*(```|~~~)/;
const HEADING_OR_RULE = /^(#{1,6}\s|([-*_])\2{2,}\s*$)/;
const TABLE_SEP = /^[\s:|-]+$/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;

/**
 * A sentence ends at `.`, `!` or `?` (optionally followed by closing quotes /
 * brackets and by the citations that belong to it) when whitespace and a
 * capital, a digit or a markup opener follow. A citation's path may hold two
 * levels of brackets (`[app/[id]/page.tsx:3]`), as the engine's citation
 * grammar allows.
 */
const SENTENCE_BREAK = /(?<=[.!?]["')]*(?:\s*\[(?:[^[\]\n]|\[(?:[^[\]\n]|\[[^\]\n]*\])*\])+\])*)\s+(?=[A-Z0-9"'(*_`])/;

/** Paragraphs and list items of markdown-ish prose; code fences, headings and table rules dropped. */
function proseUnits(text: string): string[] {
  const units: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) units.push(cur.join(" "));
    cur = [];
  };
  let inFence = false;
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, " ").split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const t = raw.trim();
    if (!t || HEADING_OR_RULE.test(t) || (t.includes("|") && TABLE_SEP.test(t) && t.includes("-"))) {
      flush();
      continue;
    }
    if (LIST_ITEM.test(raw)) {
      flush();
      cur.push(raw.replace(LIST_ITEM, "").trim());
      continue;
    }
    cur.push(t);
  }
  flush();
  return units;
}

/** The sentences of `text`, in order. */
export function splitSentences(text: string): string[] {
  return proseUnits(text).flatMap((u) =>
    u
      .split(SENTENCE_BREAK)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** The substantive sentences of `text` that carry no citation. */
export function uncitedSentences(text: string): string[] {
  return splitSentences(text).flatMap((s) => citationlessClaims(s));
}
