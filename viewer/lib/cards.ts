// What a map card says, in words: its kind, its label as drawn, its short
// line, its tooltip and what a screen reader hears. Pure: no DOM (the drawing
// helpers that measure text stay in ui/format.ts, which re-exports these).

import { type AnyKind, type Counts, type Index, pathOf, type XNode } from "./data.js";
import { num, t } from "./i18n.js";
import type { SceneNode, ViewerAudience } from "./levels.js";

export function kindName(kind: AnyKind | "cluster" | "folder"): string {
  return t(`kind.${kind}`);
}

/** The text a scene node shows: aggregate chips name their count ("28 data models"). */
export function sceneLabel(n: SceneNode): string {
  if (n.part !== undefined) return `${t("map.part", { n: n.part + 1 })} · ${n.label}`;
  if (n.role !== "agg") return n.label;
  const count = n.count ?? 0;
  return t(n.kind === "entity" ? "count.entities" : n.kind === "ext" ? "count.externals" : "count.infra", { count, n: num(count) });
}

/** Counts a folder card shows, most telling first. */
export function groupParts(counts: Partial<Counts>): string[] {
  const parts: string[] = [];
  const order: [keyof Counts, string][] = [
    ["mod", "count.modules"],
    ["file", "count.files"],
    ["route", "count.routes"],
    ["screen", "count.screens"],
    ["entity", "count.entities"],
    ["sym", "count.symbols"],
  ];
  for (const [k, key] of order) {
    const c = counts[k];
    if (c) parts.push(t(key, { count: c, n: num(c) }));
  }
  return parts;
}

/** The short line under a card's label: what it holds, or where it lives. */
export function subline(ix: Index, n: XNode, audience: ViewerAudience): string {
  return sublineParts(ix, n, audience).join(" · ");
}

/** The pieces of a card's short line, most telling first. */
export function sublineParts(ix: Index, n: XNode, audience: ViewerAudience): string[] {
  const c = ix.counts.get(n.id);
  const parts: string[] = [];
  const add = (count: number | undefined, key: string) => {
    if (count) parts.push(t(key, { count, n: num(count) }));
  };
  switch (n.kind) {
    case "cap":
      add(c?.mod, "count.modules");
      add(c?.route, "count.routes");
      add(c?.entity, "count.entities");
      if (!parts.length) add(c?.file, "count.files");
      break;
    case "actor":
      parts.push(t("kind.actor"));
      break;
    case "sys":
      if (audience === "business" && n.caps.length) return [capNames(ix, n.caps)];
      add(c?.mod, "count.modules");
      add(c?.file, "count.files");
      add(c?.route, "count.routes");
      break;
    case "mod":
      if (audience === "business" && n.caps.length) return [capNames(ix, n.caps)];
      add(c?.file, "count.files");
      add(c?.route, "count.routes");
      add(c?.entity, "count.entities");
      break;
    case "file": {
      if (audience === "developer") {
        const p = pathOf(n) ?? "";
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        if (dir) parts.push(dir);
      }
      add(c?.route, "count.routes");
      add(c?.sym, "count.symbols");
      break;
    }
    case "entity":
      add(n.fields?.length, "count.fields");
      if (!parts.length) parts.push(kindName(n.kind));
      break;
    default: {
      parts.push(kindName(n.kind));
      const at = audience === "developer" ? n.at : undefined;
      if (at) parts.push(at.split("/").pop() ?? at);
    }
  }
  return parts;
}

function capNames(ix: Index, caps: readonly string[]): string {
  const names = caps.map((c) => ix.byId.get(c)?.label ?? c);
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
}

/** A map card's tooltip: its whole label, however the card wraps or cuts it. */
export function cardTitle(n: SceneNode): string {
  return sceneLabel(n);
}

/** What a screen reader hears for a map card: its whole label, what it holds, how to act on it. */
export function cardAria(ix: Index, n: SceneNode, audience: ViewerAudience, usedBy?: number): string {
  const node = ix.byId.get(n.ref);
  const folder = n.role === "cluster" && !!n.group;
  const label = n.part !== undefined ? t("map.part", { n: n.part + 1 }) : sceneLabel(n);
  const aria = folder
    ? `${t("kind.folder")}: ${sceneLabel(n)}. ${groupParts(n.counts ?? {}).join(", ")}. ${t("graph.folderHint")}`
    : n.role === "agg"
      ? `${label}. ${t(n.kind === "entity" ? "graph.aggDataHint" : "graph.aggHint")}`
      : node
        ? describeNode(ix, node, audience)
        : `${kindName(n.kind)}: ${label}`;
  const cluster = n.role === "cluster" && !folder ? `. ${t("graph.clusterHint")}` : "";
  const ghost = n.role === "ghost" ? `. ${t("graph.ghostHint")}` : "";
  const hub = usedBy ? `. ${t("graph.hubHint", { count: usedBy })}` : "";
  return `${aria}${cluster}${ghost}${hub}`;
}

/** One-sentence spoken description of a node, for screen readers. */
export function describeNode(ix: Index, n: XNode, audience: ViewerAudience): string {
  const s = subline(ix, n, audience);
  return `${kindName(n.kind)}: ${n.label}${s ? `. ${s}` : ""}`;
}
