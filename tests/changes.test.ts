import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMap } from "../src/build.js";
import { changeMarkdown, computeDiff, diffMap, readGitDiff, recordChange, stampOf } from "../src/changes.js";
import { checkMap } from "../src/check.js";
import { main } from "../src/cli.js";
import { stableJson } from "../src/json.js";
import { mermaidIds, mermaidLabel } from "../src/mermaid.js";
import type { ChangeSet, ViewModel } from "../src/model/types.js";
import { validateTimelineEntry } from "../src/model/validate.js";
import { readStatus } from "../src/status.js";
import { captureIo, copyFixture, git, gitShop } from "./helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const NOW = new Date("2026-02-03T04:05:06.000Z");
const node = (c: ChangeSet, id: string) => c.nodes.find((n) => n.id === id);
const statusOf = (c: ChangeSet, id: string) => node(c, id)?.status;

function edit(repo: string, rel: string, from: string, to: string) {
  const abs = join(repo, rel);
  const text = readFileSync(abs, "utf8");
  if (!text.includes(from)) throw new Error(`${rel} has no ${from}`);
  writeFileSync(abs, text.replace(from, to));
}

async function run(argv: string[]) {
  const cap = captureIo();
  const code = await main(argv, cap.io);
  return { code, out: cap.out(), err: cap.err() };
}

/** The base commit's sha is stable for a given fixture, but the snapshot should not hinge on it. */
const normalize = (text: string, c: ChangeSet) => text.replaceAll(c.base.sha.slice(0, 7), "<base>");

/**
 * The shop with one change of each sort: a changed service (symbol + entity
 * use), a new file, a removed routes file still imported by the server, a new
 * route in the server, a field added to an entity, and a touched file of the
 * `mod:src@database` slice.
 */
async function changedShop(): Promise<string> {
  const repo = await gitShop(cleanups);
  edit(repo, "src/services/orders.ts", 'status: "PENDING"', 'status: "CANCELLED"');
  writeFileSync(join(repo, "src/refunds.ts"), "export function refund(id: number) {\n  return { id, refunded: true };\n}\n");
  rmSync(join(repo, "src/routes/orders.ts"));
  edit(repo, "src/server.ts", 'app.get("/health"', 'app.get("/version", (_req, res) => {\n  res.send("1");\n});\n\napp.get("/health"');
  edit(repo, "prisma/schema.prisma", "model Order {", "model Order {\n  note      String?");
  edit(repo, "src/db.ts", "export const prisma", "// one client for the whole server\nexport const prisma");
  return repo;
}

describe("diff: the engine delta on the map", () => {
  it("classifies a worktree change at every level", async () => {
    const repo = await changedShop();
    const c = await diffMap(repo, { worktree: true, ast: false, now: NOW });

    expect(c).toMatchObject({
      schema: 1,
      id: "20260203-040506-worktree",
      at: NOW.toISOString(),
      mode: "worktree",
      base: { ref: "HEAD" },
      head: { dirty: true },
      depth: 2,
    });
    expect(c.base.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.head.sha).toBe(c.base.sha);

    // files
    expect(node(c, "file:src/services/orders.ts")).toMatchObject({
      status: "changed",
      parent: "mod:src-services",
      linesAdded: 1,
      linesDeleted: 1,
      hunks: [[26, 26]],
    });
    expect(node(c, "file:src/refunds.ts")).toMatchObject({ status: "added", parent: "mod:src" });
    expect(node(c, "file:src/routes/orders.ts")).toMatchObject({ status: "removed", parent: "mod:src-routes" });
    expect(statusOf(c, "file:src/server.ts")).toBe("changed");
    expect(statusOf(c, "file:src/db.ts")).toBe("changed");
    // symbols the hunks touch
    expect(statusOf(c, "sym:src/services/orders.ts#cancelOrder")).toBe("changed");
    expect(statusOf(c, "sym:src/refunds.ts#refund")).toBe("added");
    expect(statusOf(c, "sym:src/services/orders.ts#placeOrder")).toBeUndefined();
    // facts: base tree against the new one
    expect(node(c, "route:POST /api/orders")).toMatchObject({ status: "removed", parent: "file:src/routes/orders.ts", at: "src/routes/orders.ts:10" });
    expect(statusOf(c, "route:GET /version")).toBe("added");
    expect(statusOf(c, "route:GET /health")).toBe("impacted");
    expect(statusOf(c, "entity:Order")).toBe("changed");
    // Same file, its own lines untouched: impacted, not changed.
    expect(statusOf(c, "entity:User")).toBe("impacted");
    // module slices, systems, capabilities
    expect(node(c, "mod:src-routes")).toMatchObject({ status: "removed", parent: "sys:api", changedFiles: 1 });
    expect(node(c, "mod:src-services")).toMatchObject({ status: "changed", changedFiles: 1 });
    expect(node(c, "mod:src@database")).toMatchObject({ status: "changed", label: "Src @ Database", parent: "sys:database", changedFiles: 1 });
    expect(statusOf(c, "mod:src")).toBe("changed");
    expect(statusOf(c, "mod:prisma")).toBe("changed");
    expect(statusOf(c, "sys:api")).toBe("changed");
    expect(statusOf(c, "sys:database")).toBe("changed");
    expect(statusOf(c, "cap:ordering")).toBe("changed");
    expect(statusOf(c, "cap:order-tracking")).toBe("changed");
    // risk and broken imports
    expect(c.broken).toEqual([{ from: "file:src/server.ts", spec: "./routes/orders.js", target: "file:src/routes/orders.ts", kind: "import" }]);
    const routes = c.risk.find((r) => r.id === "mod:src-routes")!;
    expect(routes.reasons.join(" ")).toContain("still imported by 1 file (src/server.ts)");
    expect(c.risk.map((r) => r.bucket).every((b) => ["high", "medium", "low"].includes(b))).toBe(true);
    // counts agree with the nodes; ultraview's own files are never part of a change
    const total = Object.values(c.counts).reduce((n, k) => n + k.added + k.changed + k.removed + k.impacted, 0);
    expect(total).toBe(c.nodes.length);
    expect(c.counts.file).toEqual({ added: 1, changed: 4, removed: 1, impacted: 0 });
    expect(c.nodes.some((n) => n.id.includes(".ultraview"))).toBe(false);
    expect([...c.nodes].map((n) => n.id)).toEqual([...c.nodes].map((n) => n.id).sort());

    // Deterministic: the same state gives the same bytes.
    expect(stableJson(await diffMap(repo, { worktree: true, ast: false, now: NOW }))).toBe(stableJson(c));
  });

  it("tells impacted (blast radius) from changed", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, "src/services/orders.ts", 'status: "PENDING"', 'status: "CANCELLED"');
    const c = await diffMap(repo, { worktree: true, ast: false, now: NOW });
    expect(statusOf(c, "file:src/services/orders.ts")).toBe("changed");
    expect(node(c, "file:src/routes/orders.ts")).toMatchObject({ status: "impacted", depth: 1 });
    expect(node(c, "file:src/server.ts")).toMatchObject({ status: "impacted", depth: 2 });
    expect(node(c, "mod:src-routes")).toMatchObject({ status: "impacted", changedFiles: 0, impactedFiles: 1 });
    expect(statusOf(c, "route:DELETE /api/orders/:id")).toBe("impacted");
    expect(statusOf(c, "cap:health")).toBe("impacted");
    expect(statusOf(c, "sys:database")).toBeUndefined();
    expect(c.broken).toEqual([]);
    expect(c.counts.file).toEqual({ added: 0, changed: 1, removed: 0, impacted: 2 });
    // A blast radius of 1 hop stops at the routes.
    const shallow = await diffMap(repo, { worktree: true, depth: 1, ast: false, now: NOW });
    expect(statusOf(shallow, "file:src/server.ts")).toBeUndefined();
  });

  it("staged mode sees only the index; base mode compares with a branch", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, "src/services/orders.ts", 'status: "PENDING"', 'status: "CANCELLED"');
    edit(repo, "src/db.ts", "export const prisma", "// unstaged\nexport const prisma");
    git(repo, ["add", "src/services/orders.ts"]);
    const staged = await diffMap(repo, { staged: true, ast: false, now: NOW });
    expect(staged.mode).toBe("staged");
    expect(statusOf(staged, "file:src/services/orders.ts")).toBe("changed");
    expect(statusOf(staged, "file:src/db.ts")).toBeUndefined();

    git(repo, ["checkout", "-q", "-b", "feature"]);
    git(repo, ["commit", "-q", "-am", "feature work"]);
    const base = await diffMap(repo, { base: "main", ast: false, now: NOW });
    expect(base).toMatchObject({ mode: "base", base: { ref: "main" }, head: { dirty: false } });
    expect(base.id).toBe(`20260203-040506-${base.head.sha!.slice(0, 7)}`);
    expect(statusOf(base, "file:src/services/orders.ts")).toBe("changed");
    expect(statusOf(base, "file:src/db.ts")).toBe("changed");
  });

  it("prints a PR-ready Markdown summary with a Mermaid map of the impacted modules", async () => {
    const repo = await changedShop();
    const { change, view } = await computeDiff(repo, { worktree: true, ast: false, now: NOW });
    const md = changeMarkdown(change, view);
    await expect(normalize(md, change)).toMatchFileSnapshot("./__snapshots__/shop.diff.md");
    expect(md).toContain("```mermaid\nflowchart LR");
    expect(md).not.toContain(repo);
    // The CLI prints the same.
    const r = await run(["diff", "--worktree", "--markdown", "--repo", repo, "--no-ast"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(md);
  });

  it("refuses outside git", async () => {
    const { dir, cleanup } = copyFixture("shop-express-prisma");
    cleanups.push(cleanup);
    expect(() => readGitDiff(dir)).toThrow(/needs a git repository/);
    const r = await run(["diff", "--repo", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("needs a git repository");
    expect((await run(["diff", "--staged", "--worktree", "--repo", dir])).code).toBe(2);
    expect((await run(["diff", "--base", "main", "--staged", "--repo", dir])).code).toBe(2);
    expect((await run(["diff", "--depth", "-1", "--repo", dir])).code).toBe(2);
  });
});

describe("diff: hunks attributed to the facts they touch", () => {
  const ROUTES = "src/routes/orders.ts";
  const worktreeDiff = (repo: string) => diffMap(repo, { worktree: true, ast: false, now: NOW });
  const routeStatuses = (c: ChangeSet) =>
    Object.fromEntries(
      c.nodes
        .filter((n) => n.kind === "route")
        .map((n) => [n.label, n.status])
        .sort(),
    );

  it("a route appended after the last one is added; the last one is untouched", async () => {
    const repo = await gitShop(cleanups);
    const abs = join(repo, ROUTES);
    writeFileSync(abs, `${readFileSync(abs, "utf8")}\nordersRouter.get("/orders/:id/receipt", (req, res) => res.json({ ok: true }));\n`);
    const c = await worktreeDiff(repo);
    expect(statusOf(c, "route:GET /api/orders/:id/receipt")).toBe("added");
    expect(statusOf(c, "route:DELETE /api/orders/:id")).toBe("impacted");
    expect(c.nodes.filter((n) => n.kind === "route" && n.status === "changed")).toEqual([]);
  });

  it("an edit inside a handler body changes that route only", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, ROUTES, "cancelOrder(Number(req.params.id))", "cancelOrder(Number(req.params.id), true)");
    const c = await worktreeDiff(repo);
    expect(routeStatuses(c)).toEqual({
      "DELETE /api/orders/:id": "changed",
      "GET /api/orders": "impacted",
      "GET /api/orders/:id": "impacted",
      "GET /health": "impacted",
      "POST /api/orders": "impacted",
    });
  });

  it("computes extents from the file when facts.json predates them", async () => {
    const repo = await gitShop(cleanups);
    const abs = join(repo, ".ultraview/facts.json");
    const facts = JSON.parse(readFileSync(abs, "utf8"));
    for (const kind of ["routes", "calls", "screens", "entities", "jobs"]) for (const f of facts[kind]) delete f.end;
    writeFileSync(abs, JSON.stringify(facts));
    edit(repo, ROUTES, "cancelOrder(Number(req.params.id))", "cancelOrder(Number(req.params.id), true)");
    writeFileSync(join(repo, ROUTES), `${readFileSync(join(repo, ROUTES), "utf8")}\n\nconst LIMIT = 50;\n`);
    const c = await diffMap(repo, { worktree: true, refresh: false, now: NOW });
    expect(statusOf(c, "route:DELETE /api/orders/:id")).toBe("changed");
    expect(statusOf(c, "route:GET /api/orders/:id")).toBe("impacted");
  });

  it("a hunk between two routes changes neither", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, ROUTES, "});\n\nordersRouter\n", "});\n\nconst LIMIT = 50;\n\nordersRouter\n");
    const c = await worktreeDiff(repo);
    expect(statusOf(c, "file:src/routes/orders.ts")).toBe("changed");
    expect(statusOf(c, "route:POST /api/orders")).toBe("impacted");
    expect(statusOf(c, "route:GET /api/orders/:id")).toBe("impacted");
    expect(c.nodes.filter((n) => n.kind === "route" && n.status === "changed")).toEqual([]);
  });

  it("a multi-line registration owns every line up to its closing parenthesis", async () => {
    const repo = await gitShop(cleanups);
    edit(
      repo,
      ROUTES,
      'ordersRouter.get("/orders", async (req, res) => {\n  res.json(await listOrders(Number(req.query.userId)));\n});',
      'ordersRouter.get(\n  "/orders",\n  async (req, res) => {\n    res.json(await listOrders(Number(req.query.userId)));\n  },\n);',
    );
    git(repo, ["commit", "-qam", "multi-line route"]);
    await buildMap({ repo, ast: false });
    const facts = JSON.parse(readFileSync(join(repo, ".ultraview/facts.json"), "utf8"));
    expect(facts.routes.find((r: { method: string; path: string }) => r.method === "GET" && r.path === "/api/orders")).toMatchObject({ line: 6, end: 11 });

    edit(repo, ROUTES, "  },\n);", "  },\n  );");
    const c = await worktreeDiff(repo);
    expect(statusOf(c, "route:GET /api/orders")).toBe("changed");
    expect(statusOf(c, "route:POST /api/orders")).toBe("impacted");
  });

  it("an edit inside a Prisma model block changes that entity only", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, "prisma/schema.prisma", "@@index([userId])", "@@index([userId, status])");
    const c = await worktreeDiff(repo);
    expect(statusOf(c, "entity:Order")).toBe("changed");
    expect(statusOf(c, "entity:User")).toBe("impacted");
    expect(statusOf(c, "entity:OrderItem")).toBe("impacted");
  });

  it("blank-line or comment-only hunks change nothing, even inside a handler", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, ROUTES, "  .delete(async (req, res) => {\n", "  .delete(async (req, res) => {\n\n");
    edit(repo, ROUTES, "  res.status(201)", "  // 201: created\n  res.status(201)");
    edit(repo, "prisma/schema.prisma", "model Order {", "model Order {\n");
    const c = await worktreeDiff(repo);
    expect(statusOf(c, "file:src/routes/orders.ts")).toBe("changed");
    expect(c.nodes.filter((n) => ["route", "entity"].includes(n.kind)).map((n) => n.status)).not.toContain("changed");
    expect(statusOf(c, "route:DELETE /api/orders/:id")).toBe("impacted");
    expect(statusOf(c, "route:POST /api/orders")).toBe("impacted");
    expect(statusOf(c, "entity:Order")).toBe("impacted");
  });
});

describe("diff --record", () => {
  it("writes the change set, appends the timeline, points view.json at it and dedupes", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, "src/services/orders.ts", 'status: "PENDING"', 'status: "CANCELLED"');
    const r = await run(["diff", "--worktree", "--record", "--repo", repo, "--no-ast"]);
    expect(r.code).toBe(0);
    const id = /recorded {3}\.ultraview\/changes\/(.+)\.json/.exec(r.out)![1]!;
    expect(id).toMatch(/^\d{8}-\d{6}-worktree$/);
    const saved = JSON.parse(readFileSync(join(repo, ".ultraview/changes", `${id}.json`), "utf8")) as ChangeSet;
    expect(saved.id).toBe(id);
    const lines = readFileSync(join(repo, ".ultraview/timeline.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(validateTimelineEntry(entry)).toEqual([]);
    expect(entry).toMatchObject({
      source: "manual",
      change: id,
      auto: true,
      base: saved.base.sha,
      title: "1 file changed in Following orders, Placing an order",
    });
    expect(entry.summary).toBe(
      "1 file changed (0 added, 1 changed, 0 removed) and 2 impacted within 2 hops. Capabilities: changed Following orders, Placing an order; impacted Health check. Highest risk: Services (medium, score 45).",
    );
    expect(entry.items).toEqual([
      { ref: "cap:order-tracking", change: "changed" },
      { ref: "cap:ordering", change: "changed" },
      { ref: "sys:api", change: "changed" },
      { ref: "mod:src-services", change: "changed" },
      { ref: "file:src/services/orders.ts", change: "changed" },
    ]);
    expect(Object.keys(entry)).toEqual([...Object.keys(entry)].sort());
    // view.json now carries it, newest first, without a rebuild.
    const view = JSON.parse(readFileSync(join(repo, ".ultraview/view.json"), "utf8")) as ViewModel;
    expect(view.changes?.id).toBe(id);
    expect(view.timeline.map((t) => t.change)).toEqual([id]);
    // An auto summary is exempt from the citation rule; nothing else in check changed.
    expect(checkMap(repo).errors).toEqual([]);
    // Nothing machine-local in what gets committed.
    expect(readFileSync(join(repo, ".ultraview/changes", `${id}.json`), "utf8")).not.toContain(repo);
    expect(lines[0]).not.toContain(repo);

    // The same change again is not recorded twice.
    const again = await run(["diff", "--worktree", "--record", "--repo", repo, "--no-ast"]);
    expect(again.out).toContain(`already recorded as ${id}`);
    expect(readFileSync(join(repo, ".ultraview/timeline.jsonl"), "utf8").trimEnd().split("\n")).toHaveLength(1);

    // status notes work that differs from the last record (cheap git check).
    expect(readStatus(repo).unrecorded).toBeUndefined();
    edit(repo, "src/db.ts", "export const prisma", "// more\nexport const prisma");
    expect(readStatus(repo).unrecorded).toEqual({ last: id, mode: "worktree" });
    expect(readStatus(repo).worklist.at(-1)).toBe("record it: `ultraview diff --worktree --record`");
  });

  it("validates a written summary and refuses an uncited one", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, "src/services/orders.ts", 'status: "PENDING"', 'status: "CANCELLED"');
    const bad = await run(["diff", "--worktree", "--record", "--summary", "Cancelling now marks the order cancelled.", "--repo", repo, "--no-ast"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("uncited sentence");
    expect(existsSync(join(repo, ".ultraview/changes"))).toBe(false);
    expect(existsSync(join(repo, ".ultraview/timeline.jsonl"))).toBe(false);

    const ok = await run([
      "diff",
      "--worktree",
      "--record",
      "--source",
      "agent",
      "--title",
      "Cancel marks orders cancelled",
      "--request",
      "make cancel explicit",
      "--summary",
      "Cancelling an order now sets its status to CANCELLED. [src/services/orders.ts:26]",
      "--repo",
      repo,
      "--no-ast",
      "--json",
    ]);
    expect(ok.code).toBe(0);
    const res = JSON.parse(ok.out);
    expect(res.entry).toMatchObject({ source: "agent", title: "Cancel marks orders cancelled", request: "make cancel explicit" });
    expect(res.entry.auto).toBeUndefined();
    expect(checkMap(repo).errors).toEqual([]);
  });

  it("takes the next free id when two records share a second", async () => {
    const repo = await gitShop(cleanups);
    edit(repo, "src/services/orders.ts", 'status: "PENDING"', 'status: "CANCELLED"');
    const c = await diffMap(repo, { worktree: true, ast: false, now: NOW });
    expect(recordChange(repo, c).file).toBe(".ultraview/changes/20260203-040506-worktree.json");
    expect(recordChange(repo, c).file).toBe(".ultraview/changes/20260203-040506-worktree-2.json");
    expect(stampOf(NOW)).toBe("20260203-040506");
  });
});

describe("diff --hook", () => {
  it("is silent, records once per new state, and never fails", async () => {
    const repo = await gitShop(cleanups);
    const hook = ["diff", "--worktree", "--record", "--quiet", "--source", "agent", "--hook", "--no-ast", "--repo", repo];
    // Nothing changed yet: nothing recorded.
    expect(await run(hook)).toEqual({ code: 0, out: "", err: "" });
    expect(existsSync(join(repo, ".ultraview/timeline.jsonl"))).toBe(false);
    edit(repo, "src/services/orders.ts", 'status: "PENDING"', 'status: "CANCELLED"');
    expect(await run(hook)).toEqual({ code: 0, out: "", err: "" });
    expect(await run(hook)).toEqual({ code: 0, out: "", err: "" });
    const entries = readFileSync(join(repo, ".ultraview/timeline.jsonl"), "utf8").trimEnd().split("\n");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!)).toMatchObject({ source: "agent", auto: true });
    expect(existsSync(join(repo, ".ultraview/hook.log"))).toBe(false);

    // Outside git, or with no index: exit 0, the reason in hook.log.
    const { dir, cleanup } = copyFixture("shop-express-prisma");
    cleanups.push(cleanup);
    expect(await run([...hook.slice(0, -1), dir])).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(join(dir, ".ultraview/hook.log"), "utf8")).toMatch(/^\d{4}-\d\d-\d\dT.*no ultraindex index/m);
  });
});

describe("mermaid ids and labels", () => {
  it("sanitizes ids deterministically, collisions numbered in order", () => {
    const ids = mermaidIds(["mod:src", "mod:src@database", "mod_src", "file:src/a b.ts", "route:GET /x", "1x"]);
    expect([...ids.values()]).toEqual(["mod_src", "mod_src_database", "mod_src_2", "file_src_a_b_ts", "route_GET__x", "n_1x"]);
    expect(mermaidLabel('say "hi" <b>')).toBe('"say #quot;hi#quot; #lt;b#gt;"');
  });
});
