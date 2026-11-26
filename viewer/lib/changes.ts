// Changes and insights arrive with M4 (`ultraview diff --record`,
// `ultraview insights`); until their shapes are final the viewer reads them
// defensively: anything malformed is dropped, never thrown on.
//
// Change view (view.changes: one object, or an array, latest first):
//   { id, title?, at?, base?, head?, summary?,
//     items: [{ ref: "<node id>", change: "new"|"changed"|"removed"|"impacted", note?, risk?: "low"|"medium"|"high" }] }
// Insight (view.insights[]):
//   { id?, kind?, severity?: "high"|"medium"|"low"|"info", title, summary?, nodes?: ["<node id>"], prompt? }
// Timeline entries (view.timeline[]) are typed by src/model/types.ts and replay
// as a change view of their items.

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
  const raw = str(v.change) ?? str(v.kind) ?? str(v.status);
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

function changeView(v: unknown, i: number): ChangeView | undefined {
  if (!isObj(v)) return undefined;
  const items = (Array.isArray(v.items) ? v.items : []).map(item).filter((x): x is ChangeItem => !!x);
  const id = str(v.id) ?? `change-${i + 1}`;
  return {
    id,
    title: str(v.title) ?? id,
    ...(str(v.at) ? { at: v.at as string } : {}),
    ...(str(v.base) ? { base: v.base as string } : {}),
    ...(str(v.head) ? { head: v.head as string } : {}),
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

/** Timeline entries as replayable change views, latest first (ids `t<index>`, stable for deep links). */
export function timelineViews(entries: readonly TimelineEntry[] | undefined): ChangeView[] {
  const out: ChangeView[] = [];
  (entries ?? []).forEach((e, i) => {
    if (!isObj(e)) return;
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
