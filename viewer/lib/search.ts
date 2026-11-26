// ⌘K search over every node: labels first, then ids and paths, then a fuzzy
// subsequence match. Every query term must match; scores add up. Ties go to
// the more "business" kind, then the shorter label, then the id.

import { type AnyKind, type Index, pathOf } from "./data.js";

export interface SearchDoc {
  id: string;
  kind: AnyKind;
  label: string;
  path: string;
  /** Lower-cased haystacks. */
  l: string;
  i: string;
  p: string;
}

export interface Hit {
  id: string;
  kind: AnyKind;
  label: string;
  path: string;
  score: number;
}

/** A small lift for the kinds a reader of the app looks for first. */
const KIND_BOOST: Partial<Record<AnyKind, number>> = { cap: 60, sys: 40, actor: 30, entity: 20, route: 20, screen: 20 };

const KIND_ORDER: AnyKind[] = ["cap", "actor", "sys", "entity", "route", "screen", "job", "ext", "infra", "mod", "file", "sym"];

export function searchDocs(ix: Index): SearchDoc[] {
  return ix.nodes.map((n) => {
    const path = pathOf(n) ?? "";
    return { id: n.id, kind: n.kind, label: n.label, path, l: n.label.toLowerCase(), i: n.id.toLowerCase(), p: path.toLowerCase() };
  });
}

/** Subsequence match score of `q` in `s` (0 = no match): consecutive runs and word starts score higher. */
export function fuzzy(q: string, s: string): number {
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let run = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      const boundary = si === 0 || /[\s/._\-:#]/.test(s[si - 1] as string);
      run++;
      score += 1 + run + (boundary ? 3 : 0);
      qi++;
    } else run = 0;
  }
  return qi === q.length ? score : 0;
}

/** Score one term against one document (0 = no match). */
export function termScore(term: string, d: SearchDoc): number {
  if (d.l === term) return 1000;
  if (d.l.startsWith(term)) return 800 - Math.min(d.l.length - term.length, 100);
  const at = d.l.indexOf(term);
  if (at > 0 && /[\s/._\-:#]/.test(d.l[at - 1] as string)) return 600 - Math.min(at, 100);
  if (at > 0) return 450 - Math.min(at, 100);
  if (d.p?.endsWith(term)) return 380;
  const pi = d.p.indexOf(term);
  if (pi !== -1) return 320 - Math.min(pi, 100);
  const ii = d.i.indexOf(term);
  if (ii !== -1) return 300 - Math.min(ii, 100);
  const fl = fuzzy(term, d.l);
  if (fl) return 100 + Math.min(fl, 150);
  const fp = fuzzy(term, d.p || d.i);
  if (fp) return 40 + Math.min(fp, 50);
  return 0;
}

export function search(docs: readonly SearchDoc[], query: string, limit = 60): Hit[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const d of docs) {
    let total = 0;
    for (const t of terms) {
      const s = termScore(t, d);
      if (!s) {
        total = 0;
        break;
      }
      total += s;
    }
    if (total) hits.push({ id: d.id, kind: d.kind, label: d.label, path: d.path, score: total + (KIND_BOOST[d.kind] ?? 0) });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.label.length - b.label.length ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return hits.slice(0, limit);
}

/** Hits grouped by kind, groups in the order of their best hit. */
export function groupHits(hits: readonly Hit[]): { kind: AnyKind; hits: Hit[] }[] {
  const groups = new Map<AnyKind, Hit[]>();
  for (const h of hits) {
    const g = groups.get(h.kind);
    if (g) g.push(h);
    else groups.set(h.kind, [h]);
  }
  return [...groups.entries()].map(([kind, list]) => ({ kind, hits: list }));
}
