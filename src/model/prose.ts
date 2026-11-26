// Sentence-level citation rules for the prose the agent writes (summaries,
// notes, answers): every sentence carries at least one `[path:line]`.
//
// ultraindex's `citationlessClaims` judges a paragraph or list item as a whole;
// a paragraph with one cited sentence and three uncited ones passes it. This
// module splits prose into sentences first and asks `citationlessClaims` about
// each one, so its notion of "substantive" text and of what a citation is stays
// the engine's.
//
// The rule, exactly (the prompts state it from CITATION_RULE below):
//   - Units: each paragraph (consecutive non-blank lines, joined) and each
//     list item; code fences, `#` headings, rules and table separators are
//     dropped.
//   - A unit splits into sentences after `.`, `!` or `?` (and the closing
//     quotes, brackets, `*` / `_` and citations right after it, a citation
//     path holding up to two levels of brackets) when
//     whitespace and an uppercase letter (any script: `À`, `É`), a digit,
//     `¿`, `¡`, a quote, `(` or a markup opener (`*`, `_`, a backtick)
//     follow. A unit without such a break is one sentence, full stop or not.
//   - A bold label, a sentence or a line that is only `**…**` / `__…__`
//     (`**How it works.**`, `**In short:**`, `**Title**.`), is a lead-in: it
//     joins the sentence after it, whose citation covers it. A bold label
//     with nothing after it is a sentence of its own.
//   - A sentence fails when it is substantive (more than 15 characters once
//     inline code is masked, the engine's test) and carries no citation; a
//     citation anywhere in it counts (the prompts ask for it at the end).

import { citationlessClaims } from "../engine.js";

const FENCE = /^\s*(```|~~~)/;
const HEADING_OR_RULE = /^(#{1,6}\s|([-*_])\2{2,}\s*$)/;
const TABLE_SEP = /^[\s:|-]+$/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;

/**
 * A sentence ends at `.`, `!` or `?` (optionally followed by closing quotes /
 * brackets / emphasis and by the citations that belong to it) when whitespace
 * and an uppercase letter of any script, a digit, `¿` / `¡`, a quote or a
 * markup opener follow. A citation's path may hold two levels of brackets
 * (`[app/[id]/page.tsx:3]`), as the engine's citation grammar allows.
 */
const SENTENCE_BREAK = /(?<=[.!?]["'”»)*_]*(?:\s*\[(?:[^[\]\n]|\[(?:[^[\]\n]|\[[^\]\n]*\])*\])+\])*)\s+(?=[\p{Lu}\p{Lt}0-9"'“«(*_`¿¡])/u;

/** A bold label: a sentence or a line that is only `**…**` or `__…__`, with trailing punctuation (`**In short:**`, `**Title**.`). */
const BOLD_LABEL = /^(\*\*|__)(?:(?!\1).)+\1[\s.:!?;,]*$/u;

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

/** The sentences of `text`, in order; a bold label joins the sentence after it (a lead-in). */
export function splitSentences(text: string): string[] {
  const all = proseUnits(text).flatMap((u) =>
    u
      .split(SENTENCE_BREAK)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const out: string[] = [];
  let lead = "";
  for (const s of all) {
    if (BOLD_LABEL.test(s)) lead = lead ? `${lead} ${s}` : s;
    else {
      out.push(lead ? `${lead} ${s}` : s);
      lead = "";
    }
  }
  if (lead) out.push(lead);
  return out;
}

/** The substantive sentences of `text` that carry no citation. */
export function uncitedSentences(text: string): string[] {
  return splitSentences(text).flatMap((s) => citationlessClaims(s));
}

/**
 * Two short answers that show the rule: `correct` passes `uncitedSentences`,
 * `incorrect` fails it on exactly `uncited` (tests/check.test.ts proves both,
 * so the prompts never show an example the gate disagrees with).
 */
export const CITATION_EXAMPLE = {
  correct: "**In short:** a nightly job deletes expired carts [src/jobs/carts.ts:12-30]. It skips a cart with a pending payment [src/jobs/carts.ts:18].",
  incorrect:
    "**In short:** a nightly job deletes expired carts. It skips a cart with a pending payment [src/jobs/carts.ts:18]. In summary, carts never pile up.",
  uncited: ["**In short:** a nightly job deletes expired carts.", "In summary, carts never pile up."],
} as const;

/**
 * The citation rule as `uncitedSentences` applies it, worded for the agent
 * that writes the prose (the Ask bridge's prompts, `lens new`'s closing
 * instructions); one line per entry, no indentation.
 */
export const CITATION_RULE: readonly string[] = [
  "EVERY sentence ends with at least one citation, [path:line] or [path:start-end], a file of this repository: the summary or opening line,",
  "each lead-in, transition and conclusion, the line that introduces a list, and each list item, as much as the main facts.",
  "A sentence ends at . ! or ? followed by a space and a capital; a paragraph or a list item with no full stop is one sentence.",
  "A bold label (**How it works.**, **In short:**) is part of the sentence it introduces: that sentence's citation covers it.",
  "A sentence you cannot cite (a recap, a reassurance, a guess) is dropped, not left uncited. # headings need no citation.",
  `Correct:   ${CITATION_EXAMPLE.correct}`,
  `Incorrect: ${CITATION_EXAMPLE.incorrect}`,
  `           (refused: ${CITATION_EXAMPLE.uncited.map((s) => JSON.stringify(s)).join(" and ")} cite nothing)`,
];
