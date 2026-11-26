// Component packing for the Data view (viewer/lib/pack.ts): shelves that
// target the viewport's aspect ratio, no overlaps, deterministic, and a schema
// of one component left exactly as ELK laid it out. Runs in node; the ELK cases
// use the same elkjs the viewer embeds.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import type { ViewModel } from "../src/model/types.js";
import { buildIndex } from "../viewer/lib/data.js";
import { type Box, type ElkNode, fromElk, type Layout, toElkGraph } from "../viewer/lib/elk.js";
import { erdScene, type Scene, type SceneNode } from "../viewer/lib/levels.js";
import { PACK_GAP, type PackItem, packLayout, packShelves, sceneComponents } from "../viewer/lib/pack.js";

/** The fit area of a 1440 x 800 viewport (Graph.tsx leaves 48 x 96 of margins). */
const VIEW = { w: 1440 - 48, h: 800 - 96 };
const ASPECT = VIEW.w / VIEW.h;

const overlaps = (a: Box, b: Box, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

function expectApart(boxes: Box[], gap: number): void {
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!, gap - 1e-6)).toBe(false);
}

function boxesOf(items: readonly PackItem[], pos: Map<string, { x: number; y: number }>): Box[] {
  return items.map((it) => ({ ...pos.get(it.id)!, w: it.w, h: it.h }));
}

/** A seeded shuffle (mulberry32), so a test that reorders input is itself deterministic. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let a = seed;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A Data-view scene: `n` entity cards of varied heights, linked by `links` (index pairs). */
function erdLike(n: number, links: [number, number][]): Scene {
  const nodes: SceneNode[] = Array.from({ length: n }, (_, i) => {
    const rows = 2 + (i % 6);
    return {
      id: `entity:T${String(i).padStart(2, "0")}`,
      ref: `entity:T${i}`,
      role: "card",
      kind: "entity",
      label: `T${i}`,
      rows,
      w: 232,
      h: 36 + rows * 20 + 8,
    };
  });
  const edges = links.map(([a, b]) => ({
    id: `${nodes[a]!.id}->${nodes[b]!.id}`,
    from: nodes[a]!.id,
    to: nodes[b]!.id,
    kind: "data" as const,
    kinds: ["data" as const],
    weight: 1,
  }));
  return {
    key: "erd",
    nodes,
    edges,
    total: n,
    edgesTotal: edges.length,
    grouped: false,
    aggregated: [],
    drawnAs: new Map(nodes.map((x) => [x.id, x.id])),
    hubs: new Map(),
    hubEdges: [],
  };
}

async function elkLayout(scene: Scene): Promise<Layout> {
  const res = await new ELK().layout(toElkGraph(scene, "RIGHT", 120) as any);
  return fromElk(scene.key, res as unknown as ElkNode);
}

/** The scale fit-to-screen picks for a layout (Graph.tsx's fitCam, without its clamps). */
const fitScale = (l: Layout) => Math.min(VIEW.w / l.width, VIEW.h / l.height);

describe("packShelves", () => {
  const cards: PackItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, w: 232, h: 144 }));

  it("30 equal cards make a grid near the target aspect, not a column", () => {
    const p = packShelves(cards, ASPECT);
    const cols = new Set([...p.pos.values()].map((q) => q.x)).size;
    const rows = new Set([...p.pos.values()].map((q) => q.y)).size;
    expect(cols).toBeGreaterThanOrEqual(5);
    expect(cols).toBeLessThanOrEqual(8);
    expect(rows).toBeGreaterThanOrEqual(4);
    expect(rows).toBeLessThanOrEqual(6);
    expect(Math.abs(Math.log(p.width / p.height / ASPECT))).toBeLessThan(0.25);
    expectApart(boxesOf(cards, p.pos), PACK_GAP);
  });

  it("follows the target: a tall viewport gets fewer columns than a wide one", () => {
    const wide = packShelves(cards, 2.5);
    const tall = packShelves(cards, 0.6);
    expect(wide.width / wide.height).toBeGreaterThan(tall.width / tall.height);
    expect(tall.width).toBeLessThan(wide.width);
  });

  it("mixed sizes: largest first, no overlaps, consistent gaps, inside the reported box", () => {
    const items: PackItem[] = [
      { id: "big", w: 900, h: 420 },
      { id: "mid", w: 584, h: 200 },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, w: 232, h: 64 + (i % 5) * 40 })),
    ];
    const p = packShelves(items, ASPECT);
    expect(p.pos.get("big")).toEqual({ x: 0, y: 0 });
    const boxes = boxesOf(items, p.pos);
    expectApart(boxes, PACK_GAP);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(p.width);
      expect(b.y + b.h).toBeLessThanOrEqual(p.height);
    }
    expect(Math.max(...boxes.map((b) => b.x + b.w))).toBe(p.width);
    expect(Math.max(...boxes.map((b) => b.y + b.h))).toBe(p.height);
  });

  it("is deterministic: the input order does not matter", () => {
    const items: PackItem[] = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, w: 120 + (i % 4) * 60, h: 60 + (i % 3) * 50 }));
    const a = packShelves(items, ASPECT);
    const b = packShelves(shuffled(items, 7), ASPECT);
    expect([...b.pos].sort()).toEqual([...a.pos].sort());
    expect([b.width, b.height]).toEqual([a.width, a.height]);
  });

  it("edge cases: nothing, one item, an item wider than every other shelf", () => {
    expect(packShelves([], ASPECT)).toEqual({ pos: new Map(), width: 0, height: 0 });
    expect(packShelves([{ id: "a", w: 10, h: 20 }], ASPECT)).toEqual({ pos: new Map([["a", { x: 0, y: 0 }]]), width: 10, height: 20 });
    const p = packShelves(
      [
        { id: "wide", w: 5000, h: 100 },
        { id: "x", w: 100, h: 50 },
      ],
      Number.NaN,
    );
    expectApart(
      boxesOf(
        [
          { id: "wide", w: 5000, h: 100 },
          { id: "x", w: 100, h: 50 },
        ],
        p.pos,
      ),
      PACK_GAP,
    );
  });
});

describe("sceneComponents", () => {
  it("groups entities linked by relations, isolated ones alone, in scene order", () => {
    const s = erdLike(5, [
      [3, 1],
      [1, 4],
    ]);
    expect(sceneComponents(s)).toEqual([["entity:T00"], ["entity:T01", "entity:T03", "entity:T04"], ["entity:T02"]]);
  });
});

describe("packLayout", () => {
  it("one component: the layout comes back untouched", () => {
    const view = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/shop.view.json"), "utf8")) as ViewModel;
    const s = erdScene(buildIndex(view));
    expect(sceneComponents(s)).toHaveLength(1);
    const l: Layout = {
      key: "erd",
      nodes: new Map(s.nodes.map((n, i) => [n.id, { x: 24 + i * 300, y: 24, w: n.w, h: n.h }])),
      edges: new Map(),
      width: 1,
      height: 1,
      engine: "elk",
    };
    expect(packLayout(l, s, ASPECT)).toBe(l);
  });

  it("30 entities, 1 relation (real ELK): a readable grid at fit-to-screen, edges moved with their cards", async () => {
    const s = erdLike(30, [[0, 1]]);
    const raw = await elkLayout(s);
    // The bug: ELK stacks the components in one column.
    expect(raw.height / raw.width).toBeGreaterThan(4);
    expect(fitScale(raw)).toBeLessThan(0.2);

    const l = packLayout(raw, s, ASPECT);
    expect(l.nodes.size).toBe(30);
    expect(Math.abs(Math.log(l.width / l.height / ASPECT))).toBeLessThan(0.3);
    expect(fitScale(l)).toBeGreaterThan(0.6);
    const rows = new Set([...l.nodes.values()].map((b) => b.y)).size;
    expect(rows).toBeLessThanOrEqual(8);
    expectApart([...l.nodes.values()], 20);
    for (const b of l.nodes.values()) {
      expect(b.x).toBeGreaterThanOrEqual(24);
      expect(b.y).toBeGreaterThanOrEqual(24);
      expect(b.x + b.w).toBeLessThanOrEqual(l.width - 24 + 1e-6);
      expect(b.y + b.h).toBeLessThanOrEqual(l.height - 24 + 1e-6);
    }
    // The linked pair keeps its shape, and its edge still joins the two cards.
    const [a0, b0] = [raw.nodes.get("entity:T00")!, raw.nodes.get("entity:T01")!];
    const [a1, b1] = [l.nodes.get("entity:T00")!, l.nodes.get("entity:T01")!];
    expect([b1.x - a1.x, b1.y - a1.y]).toEqual([b0.x - a0.x, b0.y - a0.y]);
    const dx = a1.x - a0.x;
    const dy = a1.y - a0.y;
    expect(l.edges.get("entity:T00->entity:T01")).toEqual(raw.edges.get("entity:T00->entity:T01")!.map((p) => ({ x: p.x + dx, y: p.y + dy })));
    // Deterministic: the same scene packs the same way.
    expect([...packLayout(await elkLayout(s), s, ASPECT).nodes]).toEqual([...l.nodes]);
  });

  it("well connected (real ELK): one component, same layout as before", async () => {
    const s = erdLike(
      12,
      Array.from({ length: 11 }, (_, i) => [i, i + 1] as [number, number]),
    );
    const raw = await elkLayout(s);
    expect(packLayout(raw, s, ASPECT)).toBe(raw);
  });

  it("mixed (real ELK): two schemas and loose tables never overlap and fit better than ELK's column", async () => {
    const s = erdLike(26, [
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 4],
      [5, 6],
      [6, 7],
    ]);
    const raw = await elkLayout(s);
    const l = packLayout(raw, s, ASPECT);
    expectApart([...l.nodes.values()], 20);
    expect(fitScale(l)).toBeGreaterThan(fitScale(raw) * 1.5);
    expect(l.edges.size).toBe(raw.edges.size);
  });
});
