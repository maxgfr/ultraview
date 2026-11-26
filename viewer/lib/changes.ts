// Changes and insights (`ultraview diff --record`, `ultraview insights`;
// shapes in src/model/types.ts and docs/design.md §6). The viewer still reads
// them defensively: anything malformed is dropped, never thrown on.
//
// Change set (view.changes: one ChangeSet, or an array, latest first):
//   { id, at, base: { ref, sha }, head: { sha?, dirty }, risk: ModuleRisk[],
//     nodes: [{ id: "<node id>", kind, status: "added"|"changed"|"removed"|"impacted", … }] }
//   read as items { ref: id, change: status ("added" → "new"), risk: the bucket
//   of the node's module, for module nodes and their slices }. An older
//   `{ items: [{ ref, change }] }` form is read too.
// Insight (view.insights[]):
//   { id, kind, severity: "high"|"medium"|"low", title, detail, nodes: ["<node id>"], cites, prompt }
//   (`summary` read as `detail`, unknown severities as "info").
// Timeline entries (view.timeline[], newest first) are typed by
// src/model/types.ts and replay as a change view of their items.

import type { TimelineEntry } from "../../src/model/types.js";

export const OVERLAY_KINDS = ["new", "changed", "removed", "impacted"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];
export type Risk = "low" | "medium" | "high";

export interface ChangeItem {
  ref: string;
  change: OverlayKind;
  note?: string;
  risk?: Risk;
}

export interface ChangeView {
  id: string;
  title: string;
  at?: string;
  base?: string;
  head?: string;
  summary?: string;
  items: ChangeItem[];
  /** Where it comes from: the recorded change view, or a timeline entry replayed. */
  source: "change" | "timeline";
  /** timeline entries only */
  request?: string;
  origin?: string;
}

export const SEVERITIES = ["high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Insight {
  id: string;
  kind?: string;
  severity: Severity;
  title: string;
  summary?: string;
  nodes: string[];
  prompt?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function item(v: unknown): ChangeItem | undefined {
  if (!isObj(v)) return undefined;
  const ref = str(v.ref) ?? str(v.id) ?? str(v.node);
  // `kind` last: on a ChangeSet node it is the node kind (`file`), not the change.
  const raw = str(v.change) ?? str(v.status) ?? str(v.kind);
  const change: OverlayKind | undefined =
    raw === "added" ? "new" : raw === "deleted" ? "removed" : (OVERLAY_KINDS as readonly string[]).includes(raw ?? "") ? (raw as OverlayKind) : undefined;
  if (!ref || !change) return undefined;
  const risk = str(v.risk);
  return {
    ref,
    change,
    ...(str(v.note) ? { note: v.note as string } : {}),
    ...(risk === "low" || risk === "medium" || risk === "high" ? { risk } : {}),
  };
}

/** ChangeSet `risk[]`: module id → bucket. */
function riskByModule(v: unknown): Map<string, Risk> {
  const out = new Map<string, Risk>();
  for (const r of Array.isArray(v) ? v : []) {
    const b = isObj(r) ? (str(r.bucket) ?? str(r.risk)) : undefined;
    if (isObj(r) && str(r.id) && (b === "low" || b === "medium" || b === "high")) out.set(r.id as string, b);
  }
  return out;
}

/** A sha from a string or a ChangeSet `{ sha }` end. */
const shaOf = (v: unknown): string | undefined => str(v) ?? (isObj(v) ? str(v.sha) : undefined);

function changeView(v: unknown, i: number): ChangeView | undefined {
  if (!isObj(v)) return undefined;
  const risk = riskByModule(v.risk);
  const items = (Array.isArray(v.items) ? v.items : Array.isArray(v.nodes) ? v.nodes : [])
    .map(item)
    .filter((x): x is ChangeItem => !!x)
    .map((it) => {
      // A module slice (`mod:<slug>@<sys>`) shares its module's risk.
      const r = it.risk ?? (it.ref.startsWith("mod:") ? risk.get(it.ref.split("@")[0]!) : undefined);
      return r ? { ...it, risk: r } : it;
    });
  const id = str(v.id) ?? `change-${i + 1}`;
  const base = shaOf(v.base);
  const head = shaOf(v.head);
  return {
    id,
    title: str(v.title) ?? id,
    ...(str(v.at) ? { at: v.at as string } : {}),
    ...(base ? { base } : {}),
    ...(head ? { head } : {}),
    ...(str(v.summary) ? { summary: v.summary as string } : {}),
    items,
    source: "change",
  };
}

/** Every recorded change view, latest first. */
export function normalizeChanges(raw: unknown): ChangeView[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map(changeView).filter((x): x is ChangeView => !!x);
}

/**
 * Timeline entries as replayable change views, latest first. Ids are
 * `t<n>`, n the entry's rank oldest first (by `at`, then input order reversed
 * as view.timeline is newest first), so a deep link survives new entries.
 */
export function timelineViews(entries: readonly TimelineEntry[] | undefined): ChangeView[] {
  const out: ChangeView[] = [];
  const valid = (entries ?? []).filter((e) => isObj(e));
  const chronological = valid
    .map((e, k) => ({ e, k }))
    .sort((a, b) => {
      const [x, y] = [str(a.e.at) ?? "", str(b.e.at) ?? ""];
      return x < y ? -1 : x > y ? 1 : b.k - a.k;
    })
    .map(({ e }) => e);
  chronological.forEach((e, i) => {
    const items = (Array.isArray(e.items) ? e.items : []).map(item).filter((x): x is ChangeItem => !!x);
    out.push({
      id: `t${i + 1}`,
      title: str(e.title) ?? `#${i + 1}`,
      ...(str(e.at) ? { at: e.at } : {}),
      ...(str(e.base) ? { base: e.base } : {}),
      ...(str(e.head) ? { head: e.head } : {}),
      ...(str(e.summary) ? { summary: e.summary } : {}),
      ...(str(e.request) ? { request: e.request } : {}),
      ...(str(e.source) ? { origin: e.source } : {}),
      items,
      source: "timeline",
    });
  });
  return out.reverse();
}

export function normalizeInsights(raw: unknown): Insight[] {
  if (!Array.isArray(raw)) return [];
  const out: Insight[] = [];
  raw.forEach((v, i) => {
    if (!isObj(v)) return;
    const title = str(v.title) ?? str(v.message);
    if (!title) return;
    const sev = str(v.severity);
    const nodes = (Array.isArray(v.nodes) ? v.nodes : Array.isArray(v.refs) ? v.refs : []).filter((x): x is string => typeof x === "string");
    out.push({
      id: str(v.id) ?? `insight-${i + 1}`,
      ...(str(v.kind) ? { kind: v.kind as string } : {}),
      severity: (SEVERITIES as readonly string[]).includes(sev ?? "") ? (sev as Severity) : "info",
      title,
      ...((str(v.summary) ?? str(v.detail)) ? { summary: (str(v.summary) ?? str(v.detail)) as string } : {}),
      nodes,
      ...(str(v.prompt) ? { prompt: v.prompt as string } : {}),
    });
  });
  return out.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}
