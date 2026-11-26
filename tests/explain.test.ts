import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentInvocation, askModelProblem } from "../src/ask.js";
import { buildMap } from "../src/build.js";
import { main } from "../src/cli.js";
import { checkCitations, fileLineTable } from "../src/engine.js";
import { ESCALATE_FACTS, type Explanation, explainContext, explainNode, resolveExplainLang } from "../src/explain.js";
import { EXPLAIN_LANGS, EXPLAIN_STRINGS } from "../src/explain-strings.js";
import { uncitedSentences } from "../src/model/prose.js";
import { saveLens } from "../src/save.js";
import { type ServeHandle, startServe } from "../src/serve.js";
import { liveView } from "../src/show.js";
import { builtShop, captureIo, copyFixture, readModelFile } from "./helpers.js";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function built(name: string): Promise<string> {
  const { dir, cleanup } = copyFixture(name);
  cleanups.push(cleanup);
  await buildMap({ repo: dir, ast: false, builtAt: "2026-01-01T00:00:00.000Z" });
  return dir;
}

/** The same gates a lens answer goes through: every sentence cites, every citation resolves, `lens save` accepts it. */
function expectLensGrade(repo: string, x: Explanation): void {
  expect(uncitedSentences(x.answer)).toEqual([]);
  const live = liveView(repo);
  const check = checkCitations(x.answer, fileLineTable(live.loaded.inputs.graph));
  expect(check.unresolved).toEqual([]);
  if (x.answer) {
    expect(check.resolved.length).toBeGreaterThan(0);
    const saved = saveLens(
      repo,
      { schema: 1, id: "explain-probe", question: `explain ${x.node}`, answer: x.answer, nodes: x.nodes, edges: x.edges },
      { force: true },
    );
    expect(saved.errors).toEqual([]);
  }
  for (const id of x.nodes) expect(live.byId.has(id)).toBe(true);
  for (const e of x.edges) expect(live.byId.has(e.from) && live.byId.has(e.to)).toBe(true);
  expect(x.nodes[0]).toBe(x.node);
}

/** The templated lines (agent prose kept verbatim is not ours to reword). */
const bullets = (x: Explanation) => x.answer.split("\n").filter((l) => l.startsWith("- "));

describe("explain (shop)", () => {
  it("answers every kind from proven facts, every sentence cited, in business and dev words", async () => {
    const repo = await builtShop(cleanups as (() => void)[], { views: true });
    const ctx = explainContext(liveView(repo));
    const ex = (id: string, mode: "business" | "dev") => {
      const x = explainNode(ctx, id, { mode });
      expect(x, id).toBeDefined();
      expectLensGrade(repo, x!);
      return x!;
    };

    // A route: what it is, its capability, the function it calls and the data that function reaches.
    const route = ex("route:POST /api/orders", "dev");
    expect(route.answer).toContain("- `POST /api/orders` is a route (express) declared in `src/routes/orders.ts`. [src/routes/orders.ts:10-12]");
    expect(route.answer).toContain("- It is part of: Placing an order. [src/routes/orders.ts:10-12]");
    expect(route.answer).toContain("- Calls: `placeOrder` [src/routes/orders.ts:11].");
    expect(route.answer).toContain("- Reads: `Product` [src/services/orders.ts:14].");
    expect(route.answer).toContain("- Writes: `Order` [src/services/orders.ts:16].");
    // The flow step on it, kept verbatim with its citations.
    expect(route.answer).toContain("step 1: The server mounts the order routes under /api. [src/server.ts:7]");
    expect(route.edges).toContainEqual({ from: "route:POST /api/orders", to: "sym:src/services/orders.ts#placeOrder", kind: "call" });
    expect(route.nodes).toEqual(["route:POST /api/orders", "cap:ordering", "entity:Order", "entity:Product", "sym:src/services/orders.ts#placeOrder"]);
    expect(route.escalate).toBe(false);

    const routeBiz = ex("route:POST /api/orders", "business");
    expect(routeBiz.answer).toContain("- POST /api/orders is a request the app answers, to create something. [src/routes/orders.ts:10-12]");
    expect(routeBiz.answer).toContain("- Writes: Order [src/services/orders.ts:16].");

    // An entity: fields, relations, who reads and writes it.
    const order = ex("entity:Order", "dev");
    expect(order.answer).toContain("- Its relations: user → `User`, items → `OrderItem`. [prisma/schema.prisma:36-45]");
    expect(order.answer).toContain("- Read by: `listOrders` [src/services/orders.ts:9].");
    expect(order.answer).toContain("- Written by: `placeOrder` [src/services/orders.ts:16], `cancelOrder` [src/services/orders.ts:26].");
    const orderBiz = ex("entity:Order", "business");
    // Business words name the requests behind the code, never the functions.
    expect(orderBiz.answer).toContain("- Written by: POST /api/orders [src/services/orders.ts:16], DELETE /api/orders/:id [src/services/orders.ts:26].");
    expect(orderBiz.answer).toContain("- Each Order is linked to: User, OrderItem. [prisma/schema.prisma:36-45]");

    // A symbol: who calls it and what it touches.
    const sym = ex("sym:src/services/orders.ts#placeOrder", "dev");
    expect(sym.answer).toContain("- `placeOrder` is an exported symbol (function) in `src/services/orders.ts`. [src/services/orders.ts:12-22]");
    expect(sym.answer).toContain("- Called by: `POST /api/orders` [src/routes/orders.ts:11].");
    const symBiz = ex("sym:src/services/orders.ts#placeOrder", "business");
    expect(symBiz.answer).toContain("- It is a building block of Main server. [src/services/orders.ts:12-22]");
    expect(symBiz.answer).toContain("- Called by: POST /api/orders [src/routes/orders.ts:11].");

    // A module (dev lists its files and symbols), a system (its prose and its model edge), a capability.
    const mod = ex("mod:src-services", "dev");
    expect(mod.answer).toContain("- It holds the files: `src/services/orders.ts` [src/services/orders.ts:1].");
    expect(mod.answer).toContain("`placeOrder` [src/services/orders.ts:12]");
    const sys = ex("sys:database", "business");
    expect(sys.answer.split("\n")[0]).toBe("The shop's data model and the client the server reaches it with. [prisma/schema.prisma:36] [src/db.ts:3]");
    expect(sys.answer).toContain("- Linked to Main server: connection string from DATABASE_URL. [prisma/schema.prisma:10]");
    const cap = ex("cap:ordering", "business");
    expect(cap.answer).toContain("- Requests it answers: POST /api/orders [src/routes/orders.ts:10].");
    expect(cap.counts.prose).toBeGreaterThan(0);
    ex("file:src/services/orders.ts", "dev");

    // Business never names a symbol or a file in its own sentences; dev does.
    for (const id of [
      "route:POST /api/orders",
      "entity:Order",
      "sym:src/services/orders.ts#placeOrder",
      "mod:src-services",
      "cap:ordering",
      "file:src/services/orders.ts",
    ]) {
      const b = bullets(ex(id, "business")).join("\n");
      expect(b, id).not.toMatch(/placeOrder|listOrders|cancelOrder|`/);
      expect(b.replace(/\[[^\]]+\]/g, ""), id).not.toMatch(/src\/|\.ts\b|\.prisma\b/);
    }
    expect(bullets(sym).join("\n")).toMatch(/`placeOrder`.*`src\/services\/orders\.ts`/);
  });

  it("escalates when there is no prose and few facts", async () => {
    const repo = await builtShop(cleanups as (() => void)[]);
    const ctx = explainContext(liveView(repo));
    const app = explainNode(ctx, "sym:src/server.ts#app", { mode: "dev" })!;
    expect(app.counts).toEqual({ prose: 0, facts: 0 });
    expect(app.escalate).toBe(true);
    expect(app.answer).toBe("- `app` is an exported symbol (const) in `src/server.ts`. [src/server.ts:4]");
    // Thin: what it is and its capability, nothing else.
    const thin = explainNode(ctx, "route:GET /api/orders/:id")!;
    expect(thin.counts.facts).toBeLessThan(ESCALATE_FACTS);
    expect(thin.escalate).toBe(true);
    // Rich enough without prose.
    const rich = explainNode(ctx, "entity:Order")!;
    expect(rich.counts.prose).toBe(0);
    expect(rich.counts.facts).toBeGreaterThanOrEqual(ESCALATE_FACTS);
    expect(rich.escalate).toBe(false);
    // Prose alone is enough.
    expect(explainNode(ctx, "cap:health")!.escalate).toBe(false);
    expect(explainNode(ctx, "nope:x")).toBeUndefined();
  });

  it("localizes the templates, falls back to English and says so", async () => {
    const repo = await builtShop(cleanups as (() => void)[]);
    const ctx = explainContext(liveView(repo));
    const fr = explainNode(ctx, "route:POST /api/orders", { mode: "business", lang: "fr-FR" })!;
    expect(fr.lang).toBe("fr");
    expect(fr.langFallback).toBeUndefined();
    expect(fr.answer).toContain("- POST /api/orders est une requête à laquelle l'application répond, pour créer quelque chose. [src/routes/orders.ts:10-12]");
    expect(fr.answer).toContain("- Écrit : Order [src/services/orders.ts:16].");
    expectLensGrade(repo, fr);
    const ja = explainNode(ctx, "route:POST /api/orders", { lang: "ja" })!;
    expect(ja).toMatchObject({ lang: "en", langFallback: "ja" });
    expect(ja.answer).toBe(explainNode(ctx, "route:POST /api/orders")!.answer);
    expect(resolveExplainLang(undefined)).toEqual({ lang: "en" });
    // Every table holds every key, and the same placeholders.
    const keys = Object.keys(EXPLAIN_STRINGS.en).sort();
    for (const lang of EXPLAIN_LANGS) {
      expect(Object.keys(EXPLAIN_STRINGS[lang]).sort()).toEqual(keys);
      for (const k of keys) {
        const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(ph(EXPLAIN_STRINGS[lang][k as keyof typeof EXPLAIN_STRINGS.en]), `${lang} ${k}`).toEqual(
          ph(EXPLAIN_STRINGS.en[k as keyof typeof EXPLAIN_STRINGS.en]),
        );
      }
    }
  });

  it("is deterministic and fast: every node of the shop, both modes, far under the bound", async () => {
    const repo = await builtShop(cleanups as (() => void)[], { views: true });
    const live = liveView(repo);
    const ctx = explainContext(live);
    const t0 = performance.now();
    const all = live.view.nodes.flatMap((n) => (["business", "dev"] as const).map((mode) => explainNode(ctx, n.id, { mode })!));
    const ms = performance.now() - t0;
    expect(all.length).toBe(live.view.nodes.length * 2);
    // ~5 ms here; the bound is generous so a loaded CI machine never flakes.
    expect(ms).toBeLessThan(2000);
    for (const x of all) {
      expect(uncitedSentences(x.answer), x.node).toEqual([]);
      expect(checkCitations(x.answer, fileLineTable(live.loaded.inputs.graph)).unresolved, x.node).toEqual([]);
    }
    // Same inputs, same bytes (a fresh context too).
    const again = explainContext(liveView(repo));
    expect(live.view.nodes.map((n) => JSON.stringify(explainNode(again, n.id, { mode: "dev" })))).toEqual(
      all.filter((x) => x.mode === "dev").map((x) => JSON.stringify(x)),
    );
  });
});

describe("explain (other stacks)", () => {
  it("explains externals and jobs", async () => {
    const repo = await built("fastapi-sqlalchemy");
    const ctx = explainContext(liveView(repo));
    const ext = explainNode(ctx, "ext:stripe", { mode: "dev" })!;
    expectLensGrade(repo, ext);
    expect(ext.answer).toContain("- `stripe` is a third-party service, reached through env, host. [app/services/payments.py:6]");
    expect(ext.answer).toContain("- Used by: `app/services/payments.py` [app/services/payments.py:6].");
    const extBiz = explainNode(ctx, "ext:stripe")!;
    expectLensGrade(repo, extBiz);
    expect(extBiz.answer).toContain("- stripe is an outside service the app relies on. [app/services/payments.py:6]");
    const cron = explainNode(ctx, "job:cron:nightly-report", { mode: "dev" })!;
    expectLensGrade(repo, cron);
    expect(cron.answer).toContain("on the schedule `0 3 * * *`. [app/worker.py:19-22]");
    expect(explainNode(ctx, "job:send_receipt")!.answer).toBe("- send_receipt is work the app runs in the background. [app/worker.py:7-9]");
    const route = explainNode(ctx, "route:POST /api/orders", { mode: "dev" })!;
    expectLensGrade(repo, route);
    expect(route.answer).toContain("handled by `create_order`. [app/routers/orders.py:25-31]");
    expect(route.answer).toContain("`charge` [app/routers/orders.py:29]");
  });

  it("explains a route's callers and a screen's calls", async () => {
    const repo = await built("nuxt-mongoose");
    const ctx = explainContext(liveView(repo));
    const route = explainNode(ctx, "route:GET /api/products", { mode: "business" })!;
    expectLensGrade(repo, route);
    expect(route.answer).toContain("- Called by: / [pages/index.vue:2], /products [pages/products/index.vue:2].");
    expect(route.edges).toContainEqual({ from: "screen:/products", to: "route:GET /api/products", kind: "http" });
    const screen = explainNode(ctx, "screen:/products", { mode: "dev" })!;
    expectLensGrade(repo, screen);
    expect(screen.answer).toContain("- Calls: `GET /api/products` [pages/products/index.vue:2], `POST /api/products` [pages/products/index.vue:5].");
  });
});

describe("explain CLI", () => {
  it("prints the answer, --json the object, and refuses bad input", async () => {
    const repo = await builtShop(cleanups as (() => void)[]);
    let c = captureIo();
    expect(await main(["explain", "route:POST /api/orders", "--repo", repo, "--mode", "dev", "--json"], c.io)).toBe(0);
    const x = JSON.parse(c.out()) as Explanation;
    expect(x).toMatchObject({ node: "route:POST /api/orders", mode: "dev", lang: "en", escalate: false, source: "facts" });
    expect(x.citations).toContain("src/routes/orders.ts:11");
    c = captureIo();
    expect(await main(["explain", "sym:src/server.ts#app", "--repo", repo, "--lang", "de"], c.io)).toBe(0);
    expect(c.out()).toContain("- It is a building block of Main server. [src/server.ts:4]");
    expect(c.out()).toContain('lang      no templates for "de": English used');
    expect(c.out()).toContain("escalate  yes");
    c = captureIo();
    expect(await main(["explain", "route:POST /api/orders", "--repo", repo, "--mode", "pm"], c.io)).toBe(2);
    expect(c.err()).toContain("--mode must be one of business, dev");
    c = captureIo();
    expect(await main(["explain", "route:POST /api/orders", "--repo", repo, "--lang", "not a tag"], c.io)).toBe(2);
    c = captureIo();
    expect(await main(["explain", "route:POST /api/nope", "--repo", repo], c.io)).toBe(2);
    expect(c.err()).toContain("unknown node id");
    c = captureIo();
    expect(await main(["serve", "--repo", repo, "--ask-model", "--dangerously"], c.io)).toBe(2);
    c = captureIo();
    expect(await main(["serve", "--repo", repo, "--ask-model=-x"], c.io)).toBe(2);
    expect(c.err()).toContain("--ask-model must be a model name");
  });
});

interface Reply {
  status: number;
  body: string;
}

function post(
  handle: ServeHandle,
  path: string,
  body: string,
  headers: Record<string, string> = { "Content-Type": "application/json" },
  method = "POST",
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port: handle.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("POST /api/explain", () => {
  it("answers {answer, nodes, edges, escalate}, 404 an unknown node, 400 a bad mode", async () => {
    const repo = await builtShop(cleanups as (() => void)[], { views: true });
    const handle = await startServe({ repo, port: 0, ask: "none" });
    cleanups.push(() => handle.close());
    const ok = await post(handle, "/api/explain", JSON.stringify({ node: "entity:Order", mode: "dev", lang: "fr" }));
    expect(ok.status).toBe(200);
    const x = JSON.parse(ok.body) as Explanation;
    expect(Object.keys(x)).toEqual(expect.arrayContaining(["answer", "nodes", "edges", "escalate", "citations"]));
    expect(x).toMatchObject({ node: "entity:Order", mode: "dev", lang: "fr", escalate: false });
    expect(x.answer).toContain("- Lu par : `listOrders` [src/services/orders.ts:9].");
    expectLensGrade(repo, x);
    // Default mode is business.
    expect(JSON.parse((await post(handle, "/api/explain", '{"node":"entity:Order"}')).body).mode).toBe("business");
    const unknown = await post(handle, "/api/explain", '{"node":"entity:Ordr","mode":"dev"}');
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toMatchObject({ error: "unknown node id: entity:Ordr" });
    expect((await post(handle, "/api/explain", '{"node":"entity:Order","mode":"pm"}')).status).toBe(400);
    expect((await post(handle, "/api/explain", '{"node":"entity:Order","lang":"x y"}')).status).toBe(400);
    expect((await post(handle, "/api/explain", '{"mode":"dev"}')).status).toBe(400);
    expect((await post(handle, "/api/explain", "{not json")).status).toBe(400);
    expect((await post(handle, "/api/explain", '{"node":"entity:Order"}', { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post(handle, "/api/explain", "", {}, "GET")).status).toBe(405);
  });
});

/** A fake agent CLI named `name` that records its arguments into `<dir>/args.json`, then answers with the shop lens. */
function fakeAgent(name: "claude" | "codex"): string {
  const dir = mkdtempSync(join(tmpdir(), "ultraview-fake-model-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const lens = JSON.stringify(readModelFile("shop.lens.json"));
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(args));
process.stdin.resume();
process.stdin.on("end", () => {
  const out = args.indexOf("--output-last-message");
  if (out !== -1) fs.writeFileSync(args[out + 1], ${JSON.stringify(lens)});
  else process.stdout.write(${JSON.stringify(lens)});
});
`;
  const file = join(dir, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return dir;
}

/** An event stream: `hello` resolves once connected; `until` resolves with the first of the named events. */
function stream(handle: ServeHandle) {
  const seen: { event: string; data: any }[] = [];
  const waiters: { wanted: string[]; done: (e: { event: string; data: any }) => void }[] = [];
  let hello: (d: any) => void = () => {};
  const opened = new Promise<any>((ok) => {
    hello = ok;
  });
  const flush = () => {
    for (const w of [...waiters]) {
      const hit = seen.find((e) => w.wanted.includes(e.event));
      if (hit) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done(hit);
      }
    }
  };
  let buf = "";
  const req = request({ host: "127.0.0.1", port: handle.port, path: "/events" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let i = buf.indexOf("\n\n");
      while (i !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event && data !== undefined) {
          seen.push({ event, data: JSON.parse(data) });
          if (event === "hello") hello(JSON.parse(data));
        }
        i = buf.indexOf("\n\n");
      }
      flush();
    });
  });
  req.on("error", () => {});
  req.end();
  cleanups.push(() => void req.destroy());
  return {
    opened,
    until: (wanted: string[]) =>
      new Promise<{ event: string; data: any }>((done) => {
        waiters.push({ wanted, done });
        flush();
      }),
  };
}

describe("serve --ask-model", () => {
  it("checks the model name and builds both agents' command lines with it", () => {
    for (const ok of ["sonnet", "haiku", "claude-haiku-4-5", "opus[1m]", "gpt-5-codex", "o4-mini"]) expect(askModelProblem(ok), ok).toBeUndefined();
    for (const bad of ["", "-m", "--dangerously-skip-permissions", "a b", "x;rm -rf /", "a".repeat(101)]) expect(askModelProblem(bad), bad).toBeDefined();
    const ctx = { script: "/x/ultraview.mjs", repo: "/r", tmpDir: "/t" };
    const claude = agentInvocation({ name: "claude", path: "/bin/claude" }, { ...ctx, model: "haiku" });
    expect(claude.args.slice(-2)).toEqual(["--model", "haiku"]);
    expect(agentInvocation({ name: "claude", path: "/bin/claude" }, ctx).args).not.toContain("--model");
    const codex = agentInvocation({ name: "codex", path: "/bin/codex" }, { ...ctx, model: "gpt-5-codex" });
    expect(codex.args.slice(-3)).toEqual(["-m", "gpt-5-codex", "-"]);
    expect(agentInvocation({ name: "codex", path: "/bin/codex" }, ctx).args).not.toContain("-m");
  });

  it("refuses a bad model at start", async () => {
    const repo = await builtShop(cleanups as (() => void)[]);
    await expect(startServe({ repo, port: 0, ask: "none", askModel: "--x" })).rejects.toThrow("--ask-model must be a model name");
  });

  for (const agent of ["claude", "codex"] as const) {
    it(`passes the model to a ${agent} ask`, async () => {
      const repo = await builtShop(cleanups as (() => void)[]);
      const fake = fakeAgent(agent);
      const model = agent === "claude" ? "haiku" : "gpt-5-codex";
      const handle = await startServe({
        repo,
        port: 0,
        ask: agent,
        askModel: model,
        env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` },
      });
      cleanups.push(() => handle.close());
      expect(handle.askModel).toBe(model);
      const events = stream(handle);
      expect((await events.opened).ask).toEqual({ agent, busy: false, model });
      const r = await post(handle, "/api/ask", JSON.stringify({ question: "How is an order placed?" }));
      expect(r.status).toBe(202);
      const ev = await events.until(["ask-done", "ask-error"]);
      expect(ev.event).toBe("ask-done");
      const args = JSON.parse(readFileSync(join(fake, "args.json"), "utf8")) as string[];
      const flag = agent === "claude" ? "--model" : "-m";
      expect(args[args.indexOf(flag) + 1]).toBe(model);
      expect(readFileSync(join(repo, ".ultraview/ask.log"), "utf8")).toContain(`${flag} ${model}`);
    });
  }
});
