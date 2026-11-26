// The viewer's pure logic (viewer/lib): levels, drill and breadcrumb, deep
// links, search, the markdown subset, citations, editor links, changes and
// i18n. Runs in node: nothing here touches the DOM.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ViewModel } from "../src/model/types.js";
import { normalizeChanges, normalizeInsights, timelineViews } from "../viewer/lib/changes.js";
import { buildIndex } from "../viewer/lib/data.js";
import { absPath, editorUrl, webRemote } from "../viewer/lib/editor.js";
import { fromElk, gridLayout, toElkGraph } from "../viewer/lib/elk.js";
import { detectLang, setLang, t } from "../viewer/lib/i18n.js";
import { buildScene, EDGE_LIMIT, GROUP_LIMIT, erdScene, strongest, levelEdges, levelMembers, levelsFor, locate, subgraphScene } from "../viewer/lib/levels.js";
import { type Block, citeAt, citeLabel, type Inline, parseCites, parseInline, parseMarkdown, safeHref, stripCites } from "../viewer/lib/markdown.js";
import { breadcrumb, defaultAudience, drillTarget, levelAllowed, revealTarget } from "../viewer/lib/nav.js";
import { askAboutNode, reaskLens } from "../viewer/lib/prompts.js";
import { formatHash, parseHash, type Route } from "../viewer/lib/route.js";
import { fuzzy, groupHits, search, searchDocs } from "../viewer/lib/search.js";
import en from "../viewer/i18n/en.json";
import fr from "../viewer/i18n/fr.json";

const view = JSON.parse(readFileSync(join(import.meta.dirname, "__snapshots__/shop.view.json"), "utf8")) as ViewModel;
const ix = buildIndex(view);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

/** A synthetic view with `n` files in one module (for clustering). */
function bigView(n: number, modules = 1): ViewModel {
  const nodes: any[] = [{ id: "sys:app", kind: "sys", label: "App", cites: [], metrics: { loc: 0, pagerank: 0, churn: 0, tests: 0 }, caps: [], tags: [] }];
  for (let m = 0; m < modules; m++)
    nodes.push({
      id: `mod:m${m}`,
      kind: "mod",
      label: `M${m}`,
      parent: "sys:app",
      cites: [],
      metrics: { loc: 0, pagerank: 0, churn: 0, tests: 0 },
      caps: [],
      tags: [],
    });
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `file:m${i % modules}/f${i}.ts`,
      kind: "file",
      label: `f${i}.ts`,
      parent: `mod:m${i % modules}`,
      cites: [],
      metrics: { loc: 1, pagerank: 0, churn: 0, tests: 0 },
      caps: [],
      tags: [],
    });
  }
  return {
    ...view,
    nodes,
    edges: [{ from: "file:m0/f0.ts", to: `file:m${1 % modules}/f1.ts`, kind: "import", weight: 1, derived: true }],
    flows: [],
    lenses: [],
    tour: [],
  };
}

describe("viewer index", () => {
  it("indexes nodes, adds actor pseudo-nodes and uses-edges, counts descendants", () => {
    expect(ix.byId.get("actor:customer")?.kind).toBe("actor");
    expect(
      ix.out
        .get("actor:customer")
        ?.map((e) => `${e.kind}:${e.to}`)
        .sort(),
    ).toEqual(["uses:cap:order-tracking", "uses:cap:ordering"]);
    expect(ix.counts.get("sys:api")).toMatchObject({ mod: 3, route: 5 });
    expect(ix.counts.get("cap:ordering")?.entity).toBe(3);
    expect(ix.capSlot.get("cap:_foundations")).toBe(-1);
    expect(ix.capSlot.get("cap:ordering")).toBe(0); // highest PageRank gets the first hue
  });
});

describe("levels", () => {
  it("draws each level from its own pre-rolled edges", () => {
    expect(levelEdges(ix, "sys").every((e) => /^(sys|entity|ext|infra):/.test(e.from) && /^(sys|entity|ext|infra):/.test(e.to))).toBe(true);
    expect(levelEdges(ix, "mod").some((e) => e.from === "mod:src-routes" && e.to === "mod:src-services")).toBe(true);
    expect(levelEdges(ix, "mod").some((e) => e.from.startsWith("file:"))).toBe(false);
  });

  it("business: capabilities, actors and every entity as a chip; no entity-to-entity edges", () => {
    const s = buildScene(ix, { level: "biz" }, "business");
    expect(s.nodes.filter((n) => n.role === "card").map((n) => n.id)).toEqual(
      expect.arrayContaining(["cap:ordering", "cap:order-tracking", "cap:health", "cap:_foundations", "actor:customer", "actor:operator"]),
    );
    expect(ids(s.nodes.filter((n) => n.role === "chip"))).toEqual(["entity:Order", "entity:OrderItem", "entity:Product", "entity:User"]);
    expect(s.edges.some((e) => e.from.startsWith("entity:") && e.to.startsWith("entity:"))).toBe(false);
    // parallel call + import between two capabilities merge into one drawn edge, call wins
    const e = s.edges.find((x) => x.from === "cap:order-tracking" && x.to === "cap:ordering")!;
    expect(e.kinds).toEqual(["call", "import"]);
    expect(e.kind).toBe("call");
    expect(e.weight).toBe(4);
  });

  it("modules: grouped in their system, entities joined only when connected", () => {
    const s = buildScene(ix, { level: "mod" }, "developer");
    expect(ids(s.nodes.filter((n) => n.role === "group"))).toEqual(["sys:_unassigned", "sys:api", "sys:database"]);
    expect(s.nodes.find((n) => n.id === "mod:src-routes")?.parent).toBe("sys:api");
    expect(ids(s.nodes.filter((n) => n.role === "chip"))).toEqual(["entity:Order", "entity:Product"]);
  });

  it("focus: a capability's modules, a module's files with outside neighbours as ghosts", () => {
    expect(ids(levelMembers(ix, { level: "mod", focus: "cap:ordering" }))).toEqual(["mod:prisma", "mod:src-routes", "mod:src-services"]);
    const s = buildScene(ix, { level: "file", focus: "mod:src-services" }, "developer");
    expect(ids(s.nodes.filter((n) => n.role === "card"))).toEqual(["file:src/services/orders.ts"]);
    expect(ids(s.nodes.filter((n) => n.role === "ghost"))).toEqual(["file:src/db.ts", "file:src/routes/orders.ts"]);
    expect(s.edges.map((e) => e.id)).toContain("file:src/routes/orders.ts->file:src/services/orders.ts");
  });

  it("a file expands in place: its symbols and routes inside, edges re-pointed", () => {
    const s = buildScene(ix, { level: "file", expanded: ["file:src/routes/orders.ts"] }, "developer");
    const box = s.nodes.find((n) => n.id === "file:src/routes/orders.ts")!;
    expect(box.role).toBe("group");
    expect(s.nodes.filter((n) => n.parent === box.id).map((n) => n.id)).toContain("route:POST /api/orders");
    expect(locate(ix, s, "route:GET /health")).toBe("file:src/server.ts"); // not expanded: drawn as its file
    expect(locate(ix, s, "entity:Order")).toBe("entity:Order"); // never as its schema file
  });

  it("symbol level of one file: the file is the box, neighbouring files are ghosts", () => {
    const s = buildScene(ix, { level: "sym", focus: "file:src/services/orders.ts" }, "developer");
    expect(s.nodes.find((n) => n.id === "file:src/services/orders.ts")?.role).toBe("group");
    expect(s.nodes.filter((n) => n.role === "ghost").map((n) => n.id)).toContain("file:src/routes/orders.ts");
  });

  it("groups a level past the limit by folder, unless show all", () => {
    const big = buildIndex(bigView(GROUP_LIMIT + 50, 3));
    const s = buildScene(big, { level: "file" }, "developer");
    expect(s.grouped).toBe(true);
    expect(s.total).toBe(GROUP_LIMIT + 50);
    expect(s.nodes.filter((n) => n.role !== "group").length).toBeLessThanOrEqual(GROUP_LIMIT);
    expect(locate(big, s, "file:m1/f1.ts")).toMatch(/^dir:/);
    const all = buildScene(big, { level: "file", showAll: true }, "developer");
    expect(all.grouped).toBe(false);
    expect(all.nodes.filter((n) => n.role === "card")).toHaveLength(GROUP_LIMIT + 50);
    expect(buildScene(buildIndex(bigView(GROUP_LIMIT)), { level: "file" }, "developer").grouped).toBe(false);
  });

  it("keeps the strongest lines past the edge limit, every node's best first", () => {
    const e = (from: string, to: string, weight: number) => ({ id: `${from}->${to}`, from, to, kind: "import" as const, kinds: ["import" as const], weight });
    const edges = [e("a", "b", 9), e("a", "c", 8), e("b", "c", 7), e("x", "y", 1)];
    expect(strongest(edges, 2).map((x) => x.id)).toEqual(["a->b", "a->c"]);
    expect(strongest(edges, 3).map((x) => x.id)).toEqual(["a->b", "a->c", "x->y"]);
    expect(strongest(edges, 10)).toHaveLength(4);
    const big = bigView(400, 40);
    big.edges = [];
    for (let i = 0; i < 400; i++)
      for (const j of [1, 2])
        big.edges.push({ from: `file:m${i % 40}/f${i}.ts`, to: `file:m${(i + j) % 40}/f${(i + j) % 400}.ts`, kind: "import", weight: 1, derived: true });
    const s = buildScene(buildIndex(big), { level: "file", showAll: true }, "developer");
    expect(s.edgesTotal).toBe(800);
    expect(s.edges).toHaveLength(800); // show all draws every line
    const capped = buildScene(buildIndex(big), { level: "file", focus: "mod:m0" }, "developer");
    expect(capped.edges.length).toBeLessThanOrEqual(EDGE_LIMIT);
  });

  it("is deterministic", () => {
    const a = buildScene(ix, { level: "file" }, "developer");
    const b = buildScene(buildIndex(view), { level: "file" }, "developer");
    expect(JSON.stringify({ ...b, drawnAs: [...b.drawnAs] })).toBe(JSON.stringify({ ...a, drawnAs: [...a.drawnAs] }));
  });

  it("ERD: entities with fields, one edge per related pair", () => {
    const s = erdScene(ix);
    expect(ids(s.nodes)).toEqual(["entity:Order", "entity:OrderItem", "entity:Product", "entity:User"]);
    expect(s.nodes.find((n) => n.id === "entity:Order")!.rows).toBe(6);
    expect(s.edges.map((e) => `${e.id} ${e.label}`)).toEqual([
      "entity:Order->entity:OrderItem items · order",
      "entity:Order->entity:User user · orders",
      "entity:OrderItem->entity:Product product · items",
    ]);
  });

  it("subgraph: exactly the given nodes, their edges plus the extra ones", () => {
    const s = subgraphScene(
      ix,
      "lens:x",
      ["route:DELETE /api/orders/:id", "entity:Order", "nope:x"],
      [{ from: "route:DELETE /api/orders/:id", to: "entity:Order", kind: "data" }],
    );
    expect(ids(s.nodes)).toEqual(["entity:Order", "route:DELETE /api/orders/:id"]);
    expect(s.edges.map((e) => e.kind)).toEqual(["data"]);
  });

  it("ELK graph: groups are compound nodes, every edge on the root; grid fallback places everything", () => {
    const s = buildScene(ix, { level: "mod" }, "developer");
    const g = toElkGraph(s);
    const api = g.children!.find((c) => c.id === "sys:api")!;
    expect(api.children!.map((c) => c.id).sort()).toEqual(["mod:src", "mod:src-routes", "mod:src-services"]);
    expect(g.edges!.length).toBe(s.edges.length);
    const grid = gridLayout(s);
    expect(grid.nodes.size).toBe(s.nodes.length);
    expect(grid.edges.size).toBe(s.edges.length);
    const laid = fromElk("k", {
      id: "__root",
      width: 10,
      height: 5,
      children: [{ id: "a", x: 1, y: 2, width: 3, height: 4 }],
      edges: [{ id: "e", sources: ["a"], targets: ["a"], sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 }, bendPoints: [{ x: 0, y: 1 }] }] }],
    });
    expect(laid.nodes.get("a")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(laid.edges.get("e")).toHaveLength(3);
  });
});

describe("drill and breadcrumb", () => {
  it("drills cap/sys → modules, mod → files, file → symbols; leaves stay put", () => {
    expect(drillTarget(ix, "cap:ordering")).toEqual({ level: "mod", focus: "cap:ordering" });
    expect(drillTarget(ix, "sys:api")).toEqual({ level: "mod", focus: "sys:api" });
    expect(drillTarget(ix, "mod:src-routes")).toEqual({ level: "file", focus: "mod:src-routes" });
    expect(drillTarget(ix, "file:src/server.ts")).toEqual({ level: "sym", focus: "file:src/server.ts" });
    expect(drillTarget(ix, "entity:Order")).toBeUndefined();
    expect(drillTarget(ix, "route:GET /health")).toBeUndefined();
  });

  it("climbs from the focus to the level root", () => {
    expect(breadcrumb(ix, { level: "sys" }).map((c) => c.label)).toEqual(["sys"]);
    const b = breadcrumb(ix, { level: "sym", focus: "file:src/routes/orders.ts" });
    expect(b.map((c) => c.id ?? c.label)).toEqual(["sys", "sys:api", "mod:src-routes", "file:src/routes/orders.ts"]);
    expect(b[1]!.state).toEqual({ level: "mod", focus: "sys:api" });
    expect(breadcrumb(ix, { level: "mod", focus: "cap:health" }).map((c) => c.id ?? c.label)).toEqual(["biz", "cap:health"]);
  });

  it("reveals a node at a level that draws it", () => {
    expect(revealTarget(ix, "entity:Order")).toEqual({ level: "biz" });
    expect(revealTarget(ix, "mod:src")).toEqual({ level: "mod", focus: "sys:api" });
    expect(revealTarget(ix, "file:src/db.ts")).toEqual({ level: "file", focus: "mod:src@database" });
    const sym = revealTarget(ix, "sym:src/services/orders.ts#placeOrder");
    expect(sym).toEqual({ level: "file", focus: "mod:src-services", expanded: ["file:src/services/orders.ts"] });
    expect(locate(ix, buildScene(ix, sym, "developer"), "sym:src/services/orders.ts#placeOrder")).toBe("sym:src/services/orders.ts#placeOrder");
  });

  it("business audience keeps files and symbols out of the map", () => {
    expect(levelsFor("business")).toEqual(["biz", "sys", "mod"]);
    expect(levelAllowed("file", "business")).toBe(false);
    expect(levelAllowed("sym", "developer")).toBe(true);
    expect(defaultAudience("everyone")).toBe("business");
    expect(defaultAudience("developers")).toBe("developer");
  });
});

describe("deep links", () => {
  const cases: Route[] = [
    { view: "map" },
    { view: "map", level: "sys", node: "sys:api" },
    { view: "map", level: "file", focus: "mod:src-routes", node: "route:DELETE /api/orders/:id" },
    { view: "map", level: "sym", node: "sym:src/a b.ts#fn" },
    { view: "data", node: "entity:Order" },
    { view: "lenses", lens: "how-refunds-work" },
    { view: "flows", flow: "checkout", step: 2 },
    { view: "changes", change: "t1" },
    { view: "insights" },
    // Ids with `#`, `/`, spaces, `@` and `&` (server actions, tRPC procedures, slices).
    { view: "map", level: "file", node: "route:ACTION app/actions#save" },
    { view: "map", level: "sym", focus: "file:app/actions.ts", node: "route:ACTION app/(shop)/cart/actions#add&remove" },
    { view: "map", level: "file", node: "route:QUERY user.byId" },
    { view: "map", level: "file", focus: "mod:src@database", node: "file:src/db/a+b%20c.ts" },
    { view: "map", level: "mod", focus: "sys:web", group: "src/app~1", node: "mod:src-app@web" },
    { view: "lenses", lens: "how-refunds-work", node: "route:MUTATION order.refund" },
  ];
  it.each(cases)("round-trips %j", (r) => {
    expect(parseHash(formatHash(r))).toEqual(r);
  });

  it("percent-encodes the characters of an id that would break the hash", () => {
    const hash = formatHash({ view: "map", level: "file", node: "route:ACTION app/actions#save" });
    expect(hash).toBe("#level=file&node=route:ACTION%20app/actions%23save");
    expect(hash.indexOf("#", 1)).toBe(-1);
    expect(formatHash({ view: "map", level: "mod", focus: "mod:src@database" })).toBe("#level=mod&focus=mod:src%40database");
    expect(formatHash({ view: "map", node: "file:a&b=c.ts" })).toBe("#node=file:a%26b%3Dc.ts");
    // A pasted, already-decoded link still reads.
    expect(parseHash("#level=mod&focus=mod:src@database")).toEqual({ view: "map", level: "mod", focus: "mod:src@database" });
  });

  it("reads the documented forms and keeps ids readable", () => {
    expect(parseHash("#view=map&level=sys&node=sys:api")).toEqual({ view: "map", level: "sys", node: "sys:api" });
    expect(parseHash("#lens=how-refunds-work")).toEqual({ view: "lenses", lens: "how-refunds-work" });
    expect(parseHash("#flow=checkout&step=2")).toEqual({ view: "flows", flow: "checkout", step: 2 });
    expect(parseHash("#change=c1")).toEqual({ view: "changes", change: "c1" });
    expect(formatHash({ view: "map", level: "file", node: "sym:src/a.ts#fn" })).toBe("#level=file&node=sym:src/a.ts%23fn");
    expect(formatHash({ view: "map", node: "route:GET /api/x" })).toBe("#node=route:GET%20/api/x");
  });

  it("ignores junk", () => {
    expect(parseHash("#view=nope&level=zzz&step=-1&step=x")).toEqual({ view: "map" });
    expect(parseHash("#node=%E0%A4%A")).toEqual({ view: "map", node: "%E0%A4%A" });
    expect(parseHash("")).toEqual({ view: "map" });
  });
});

describe("search", () => {
  const docs = searchDocs(ix);
  it("ranks exact labels, then prefixes, then word starts, then paths, then fuzzy", () => {
    const hits = search(docs, "order");
    expect(hits[0]!.id).toBe("entity:Order");
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(["cap:ordering", "file:src/services/orders.ts", "route:POST /api/orders"]));
    expect(search(docs, "placing")[0]!.id).toBe("cap:ordering");
    expect(search(docs, "src/services")[0]!.id).toBe("file:src/services/orders.ts");
    expect(
      search(docs, "plcord")
        .slice(0, 3)
        .map((h) => h.id),
    ).toContain("sym:src/services/orders.ts#placeOrder");
  });

  it("needs every term to match, and returns nothing for nothing", () => {
    expect(search(docs, "orders delete").map((h) => h.id)).toEqual(["route:DELETE /api/orders/:id"]);
    expect(search(docs, "   ")).toEqual([]);
    expect(search(docs, "zzzzqqq")).toEqual([]);
    expect(fuzzy("abc", "a-b-c")).toBeGreaterThan(fuzzy("abc", "xaxbxc"));
    expect(fuzzy("abc", "ab")).toBe(0);
  });

  it("groups hits by kind in the order of their best hit", () => {
    const groups = groupHits(search(docs, "order"));
    expect(groups[0]!.kind).toBe("entity");
    expect(new Set(groups.map((g) => g.kind)).size).toBe(groups.length);
  });
});

describe("markdown subset", () => {
  const flat = (nodes: Inline[]): Inline[] => nodes.flatMap((n) => ("c" in n ? [n, ...flat(n.c)] : [n]));
  const allInline = (blocks: Block[]): Inline[] => blocks.flatMap((b) => (b.t === "p" || b.t === "h" ? flat(b.c) : b.items.flatMap((it) => flat(it))));

  it("parses paragraphs, lists, code, bold, emphasis, links and citations", () => {
    const md = parseMarkdown("First **bold** and `code`. [src/a.ts:3]\n\n- one *em*\n- two [docs](https://x.dev/a)\n\n2. b\n3. c\n\n# Head");
    expect(md.map((b) => b.t)).toEqual(["p", "ul", "ol", "h"]);
    const p = md[0] as Extract<Block, { t: "p" }>;
    expect(p.c.map((n) => n.t)).toEqual(["text", "strong", "text", "code", "text", "cite"]);
    expect((md[2] as Extract<Block, { t: "ol" }>).start).toBe(2);
    expect(allInline(md).find((n) => n.t === "link")).toEqual({ t: "link", href: "https://x.dev/a", c: [{ t: "text", v: "docs" }] });
  });

  it("neutralises HTML, script, javascript: links and attribute injection", () => {
    const md = parseMarkdown(
      '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [x](JaVaScRiPt:alert(1)) [y](java\tscript:alert(1)) [d](data:text/html,<b>) [q](https://a.dev/" onmouseover="alert(1)) [v](vbscript:x) [p](//evil.dev)',
    );
    const inl = allInline(md);
    expect(inl.filter((n) => n.t === "link")).toEqual([]);
    const text = inl
      .filter((n): n is Extract<Inline, { t: "text" }> => n.t === "text")
      .map((n) => n.v)
      .join("");
    expect(text).toContain("<script>alert(1)</script>"); // stays literal text, rendered escaped
    expect(text).toContain("click");
    for (const bad of [
      "javascript:alert(1)",
      " java\tscript:x",
      "data:text/html,x",
      'https://a.dev/" onmouseover="x',
      "vbscript:x",
      "//evil.dev",
      "javascript&colon;",
    ]) {
      expect(safeHref(bad), bad).toBe(bad === "javascript&colon;" ? bad : undefined);
    }
    expect(safeHref("https://ok.dev/p?q=1#h")).toBe("https://ok.dev/p?q=1#h");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("#anchor")).toBe("#anchor");
  });

  it("parses citation chips and leaves non-paths alone", () => {
    expect(citeAt("[src/a.ts:12]")).toEqual({ path: "src/a.ts", line: 12, raw: "[src/a.ts:12]" });
    expect(citeAt("[src/a.ts:10-12] tail")).toEqual({ path: "src/a.ts", line: 10, end: 12, raw: "[src/a.ts:10-12]" });
    expect(citeAt("[README.md:3]")?.path).toBe("README.md");
    expect(citeAt("[Note:3]")).toBeUndefined();
    expect(citeAt("[a b.ts:3]")).toBeUndefined();
    expect(parseCites("A. [x/a.ts:1] B. [x/b.ts:2-4] [not a cite]").map((c) => `${c.path}:${c.line}`)).toEqual(["x/a.ts:1", "x/b.ts:2"]);
    expect(citeLabel({ path: "src/routes/orders.ts", line: 10, end: 12, raw: "" })).toBe("orders.ts:10–12");
    expect(stripCites("The order is stored. [src/a.ts:3] Then [b.ts:1] it ends.")).toBe("The order is stored. Then it ends.");
    expect(parseInline("see [src/a.ts:3].").map((n) => n.t)).toEqual(["text", "cite", "text"]);
  });
});

describe("editor links", () => {
  const repo = { root: "/Users/me/My Repo", remote: "git@github.com:o/r.git", commit: "abc123" };
  it("builds editor URLs over the absolute path", () => {
    expect(editorUrl("vscode", repo, "src/a b.ts", 12)).toBe("vscode://file/Users/me/My%20Repo/src/a%20b.ts:12");
    expect(editorUrl("cursor", repo, "src/a.ts", 3)).toBe("cursor://file/Users/me/My%20Repo/src/a.ts:3");
    expect(editorUrl("zed", repo, "src/a.ts", 3)).toBe("zed://file/Users/me/My%20Repo/src/a.ts:3");
    expect(editorUrl("idea", repo, "src/a.ts", 3)).toBe("idea://open?file=%2FUsers%2Fme%2FMy%20Repo%2Fsrc%2Fa.ts&line=3");
    expect(absPath("C:\\code\\repo\\", "src/a.ts")).toBe("/C:/code/repo/src/a.ts");
  });

  it("builds repository-website URLs at the commit, with line ranges", () => {
    expect(editorUrl("github", repo, "src/a.ts", 10, 12)).toBe("https://github.com/o/r/blob/abc123/src/a.ts#L10-L12");
    expect(editorUrl("github", { remote: "https://github.com/o/r" }, "a.ts", 1)).toBe("https://github.com/o/r/blob/HEAD/a.ts#L1");
    expect(editorUrl("vscode", { remote: "https://gitlab.com/o/r.git" }, "a.ts", 2)).toBe("https://gitlab.com/o/r/blob/HEAD/a.ts#L2"); // no local root
    expect(editorUrl("github", { root: "/x" }, "a.ts", 1)).toBeUndefined();
    expect(editorUrl("vscode", {}, "a.ts", 1)).toBeUndefined();
  });

  it("normalises remotes", () => {
    expect(webRemote("ssh://git@github.com:22/o/r.git")).toBe("https://github.com/o/r");
    expect(webRemote("https://token@github.com/o/r.git/")).toBe("https://github.com/o/r");
    expect(webRemote("not a url")).toBeUndefined();
  });
});

describe("changes and insights (defensive)", () => {
  it("reads a change view, an array of them, and drops malformed items", () => {
    const one = normalizeChanges({
      id: "c1",
      title: "T",
      items: [{ ref: "file:a", change: "added" }, { ref: "x", change: "weird" }, null, { ref: "y", change: "impacted", risk: "high" }],
    });
    expect(one).toEqual([
      {
        id: "c1",
        title: "T",
        items: [
          { ref: "file:a", change: "new" },
          { ref: "y", change: "impacted", risk: "high" },
        ],
        source: "change",
      },
    ]);
    expect(normalizeChanges(null)).toEqual([]);
    expect(normalizeChanges([{ items: "nope" }, 3])).toEqual([{ id: "change-1", title: "change-1", items: [], source: "change" }]);
  });

  it("reads the recorded ChangeSet shape: nodes by status, module risk by bucket, base / head shas", () => {
    const [c] = normalizeChanges({
      schema: 1,
      id: "20260203-040506-worktree",
      at: "2026-02-03T04:05:06.000Z",
      mode: "worktree",
      base: { ref: "HEAD", sha: "a1b2c3d4e5f6" },
      head: { sha: "a1b2c3d4e5f6", dirty: true },
      nodes: [
        { id: "file:src/a.ts", kind: "file", label: "a.ts", status: "added", parent: "mod:src" },
        { id: "mod:src", kind: "mod", label: "Src", status: "changed", changedFiles: 1, impactedFiles: 0 },
        { id: "mod:src@database", kind: "mod", label: "Src @ Database", status: "impacted" },
        { id: "route:GET /x", kind: "route", label: "GET /x", status: "removed" },
      ],
      risk: [{ id: "mod:src", label: "Src", path: "src", score: 45, bucket: "medium", reasons: [] }],
    });
    expect(c).toEqual({
      id: "20260203-040506-worktree",
      title: "20260203-040506-worktree",
      at: "2026-02-03T04:05:06.000Z",
      base: "a1b2c3d4e5f6",
      head: "a1b2c3d4e5f6",
      items: [
        { ref: "file:src/a.ts", change: "new" },
        { ref: "mod:src", change: "changed", risk: "medium" },
        { ref: "mod:src@database", change: "impacted", risk: "medium" },
        { ref: "route:GET /x", change: "removed" },
      ],
      source: "change",
    });
  });

  it("reads view.timeline newest first, with ids stable as entries are added", () => {
    const older = { at: "2026-01-01T00:00:00Z", source: "agent" as const, title: "first", summary: "s", items: [] };
    const newer = { at: "2026-01-02T00:00:00Z", source: "pr" as const, title: "second", summary: "s", items: [] };
    expect(timelineViews([newer, older]).map((c) => [c.id, c.title])).toEqual([
      ["t2", "second"],
      ["t1", "first"],
    ]);
    const newest = { ...newer, at: "2026-01-03T00:00:00Z", title: "third" };
    expect(timelineViews([newest, newer, older]).find((c) => c.title === "first")!.id).toBe("t1");
  });

  it("replays timeline entries latest first", () => {
    const tl = timelineViews([
      { at: "2026-01-01T00:00:00Z", source: "agent", title: "first", summary: "s", items: [{ ref: "file:a", change: "new" }] },
      { at: "2026-01-02T00:00:00Z", source: "pr", title: "second", summary: "s", items: [] },
    ]);
    expect(tl.map((c) => [c.id, c.title, c.origin])).toEqual([
      ["t2", "second", "pr"],
      ["t1", "first", "agent"],
    ]);
  });

  it("reads the Insight shape (detail as the summary)", () => {
    expect(
      normalizeInsights([
        {
          id: "cycle:a>b",
          kind: "cycle",
          severity: "medium",
          title: "Import cycle: a → b → a",
          detail: "2 modules import each other.",
          nodes: ["mod:a", "mod:b"],
          cites: ["a/x.ts:1"],
          prompt: "Using ultraview and ultraindex, …",
        },
      ]),
    ).toEqual([
      {
        id: "cycle:a>b",
        kind: "cycle",
        severity: "medium",
        title: "Import cycle: a → b → a",
        summary: "2 modules import each other.",
        nodes: ["mod:a", "mod:b"],
        prompt: "Using ultraview and ultraindex, …",
      },
    ]);
  });

  it("sorts insights by severity and defaults unknown ones to info", () => {
    const ins = normalizeInsights([
      { title: "b", severity: "low" },
      { title: "a", severity: "high", nodes: ["file:x", 3] },
      { nope: 1 },
      { message: "c", severity: "bogus" },
    ]);
    expect(ins.map((i) => [i.title, i.severity])).toEqual([
      ["a", "high"],
      ["b", "low"],
      ["c", "info"],
    ]);
    expect(ins[0]!.nodes).toEqual(["file:x"]);
    expect(normalizeInsights({})).toEqual([]);
  });
});

describe("prompts", () => {
  it("names the node / lens so the agent can act on it", () => {
    expect(askAboutNode("cap:ordering", "Placing an order")).toMatch(/^Using ultraview, explain cap:ordering \(Placing an order\): /);
    expect(reaskLens("how-cancel-works", "How does cancelling work?")).toMatch(
      /^Use ultraview to re-answer the lens "How does cancelling work\?" \(id how-cancel-works\)/,
    );
  });
});

describe("i18n", () => {
  it("en and fr hold exactly the same keys and placeholders", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(en)) expect(ph((fr as Record<string, string>)[k]!), k).toEqual(ph((en as Record<string, string>)[k]!));
  });

  it("translates with params and plurals, falls back to English, then to the key", () => {
    setLang("en");
    expect(t("level.biz")).toBe("Business");
    expect(t("count.files", { count: 1, n: "1" })).toBe("1 file");
    expect(t("count.files", { count: 3, n: "3" })).toBe("3 files");
    expect(t("no.such.key")).toBe("no.such.key");
    setLang("fr");
    expect(t("level.biz")).toBe("Métier");
    expect(t("count.files", { count: 0, n: "0" })).toBe("0 fichier");
    expect(t("flows.stepOf", { n: 2, total: 3 })).toBe("Étape 2 sur 3");
    setLang("en");
  });

  it("detects the language: stored, then browser, then English", () => {
    expect(detectLang("fr", ["en-US"])).toBe("fr");
    expect(detectLang(null, ["de-DE", "fr-CA"])).toBe("fr");
    expect(detectLang("xx", ["de"])).toBe("en");
  });

  it("every key the viewer calls exists in en.json", () => {
    const dir = join(import.meta.dirname, "../viewer");
    const files = ["ui", "lib"].flatMap((d) => readdirSync(join(dir, d)).map((f) => join(dir, d, f)));
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\("([a-z][\w.+-]*)"/g)) {
        const key = m[1]!;
        if (!(key in en) && !(`${key}.other` in en)) missing.push(`${f}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
