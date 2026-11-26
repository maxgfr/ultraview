import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentEnv,
  agentInvocation,
  askPrompt,
  chatPrompt,
  correctionPrompt,
  extractLensJson,
  findOnPath,
  nodeIdExamples,
  resolveAskAgent,
} from "../src/ask.js";
import { lensNew } from "../src/lens.js";
import { CITATION_EXAMPLE, CITATION_RULE } from "../src/model/prose.js";
import { allowedHostHeader, isLoopbackHost, type ServeHandle, startServe } from "../src/serve.js";
import { builtShop, readModelFile, writeView } from "./helpers.js";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(handle: ServeHandle, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port: handle.port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    req.end(opts.body);
  });
}

/** A Server-Sent Events client that records every event and can await the next one by name. */
function events(handle: ServeHandle) {
  const seen: { event: string; data: any }[] = [];
  const waiters: { event: string; from: number; done: (d: any) => void }[] = [];
  let buf = "";
  const flush = () => {
    for (const w of [...waiters]) {
      const hit = seen.slice(w.from).find((e) => e.event === w.event);
      if (hit) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done(hit.data);
      }
    }
  };
  let ready: () => void = () => {};
  const opened = new Promise<void>((ok) => {
    ready = ok;
  });
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
        if (event && data !== undefined) seen.push({ event, data: JSON.parse(data) });
        if (event === "hello") ready();
        i = buf.indexOf("\n\n");
      }
      flush();
    });
  });
  req.on("error", () => {});
  req.end();
  return {
    seen,
    opened,
    /** The first `event` after the `from`-th recorded one (default: from now), within `ms`. */
    next(event: string, ms = 5000, from = seen.length): Promise<any> {
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no ${event} event within ${ms} ms (seen: ${seen.map((e) => e.event).join(", ")})`)), ms);
        waiters.push({
          event,
          from,
          done: (d) => {
            clearTimeout(timer);
            done(d);
          },
        });
        flush();
      });
    },
    close: () => {
      req.destroy();
    },
  };
}

async function serveShop(opts: Partial<Parameters<typeof startServe>[0]> = {}, shop: Parameters<typeof builtShop>[1] = {}) {
  const repo = await builtShop(cleanups as (() => void)[], shop);
  const handle = await startServe({ repo, port: 0, ask: "none", ...opts });
  cleanups.push(() => handle.close());
  return { repo, handle };
}

/**
 * A fake agent CLI named `claude`: checks it was started read-only, then replies with a lens. The question picks the reply:
 * BROKEN fails the gates every round, FIXABLE only the first (the correction round's reply passes), SLOWFIX fails the first
 * and is slow to correct it, SLOW is slow, BARE writes its node ids without their kind prefix, LABELS writes its edges
 * the way issue #29 saw them (a `label`, kinds `calls` / `reads`, and one edge no repair saves).
 */
function fakeAgent(): string {
  // (the prompts it reads are kept next to it, prompt-<time>.txt, for the tests to read)
  const dir = mkdtempSync(join(tmpdir(), "ultraview-fake-agent-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const lens = readModelFile("shop.lens.json");
  const broken = { ...lens, answer: "This cites a line that does not exist. [src/services/orders.ts:999]" };
  const bare = {
    ...lens,
    nodes: ["DELETE /api/orders/:id", "src/services/orders.ts#cancelOrder", "Order", "src-services"],
    edges: [{ from: "DELETE /api/orders/:id", to: "Order", kind: "data" }],
    focus: "DELETE /api/orders/:id",
  };
  const labelled = {
    ...lens,
    edges: [
      { from: "route:DELETE /api/orders/:id", to: "sym:src/services/orders.ts#cancelOrder", kind: "calls", label: "hands the id over" },
      { from: "sym:src/services/orders.ts#cancelOrder", to: "entity:Order", kind: "reads" },
      { from: "sym:src/services/orders.ts#cancelOrder", to: "entity:Order", kind: "uses" },
    ],
  };
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const need = ["-p", "--permission-mode", "dontAsk", "--tools", "Bash,Read,Glob,Grep"];
for (const a of need) if (!args.includes(a)) { console.error("missing " + a); process.exit(3); }
if (args.some((a) => /bypass|dangerously/i.test(a))) { console.error("unsafe flag"); process.exit(4); }
if (process.env.ULTRAVIEW_SECRET) { console.error("leaked env"); process.exit(5); }
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  console.error("fake agent read " + prompt.length + " chars");
  require("node:fs").writeFileSync(${JSON.stringify(dir)} + "/prompt-" + Date.now() + ".txt", prompt);
  const fix = prompt.includes("## Correction round");
  const failing = prompt.includes("BROKEN") || (!fix && (prompt.includes("FIXABLE") || prompt.includes("SLOWFIX")));
  const slow = prompt.includes("SLOWFIX") ? fix : prompt.includes("SLOW");
  setTimeout(() => {
    const lens = failing ? ${JSON.stringify(broken)} : prompt.includes("BARE") ? ${JSON.stringify(bare)} : prompt.includes("LABELS") ? ${JSON.stringify(labelled)} : ${JSON.stringify(lens)};
    if (prompt.includes("one turn of a conversation")) {
      const { schema, id, ...answer } = lens;
      process.stdout.write(JSON.stringify({ ...answer, question: "agent rewrote it", mode: "dev", lang: "en", followUps: ["Who calls it?", "What does it store?", "Can it fail?"] }));
      return;
    }
    process.stdout.write("Here is the lens:\\n\`\`\`json\\n" + JSON.stringify({ ...lens, id: "agent-picked-id", question: "agent rewrote it" }) + "\\n\`\`\`\\n");
  }, slow ? 20000 : 300);
});
`;
  const file = join(dir, "claude");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return dir;
}

describe("serve", () => {
  it("serves the page, view.json and the API, and nothing else", async () => {
    const { repo, handle } = await serveShop();
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`);
    const page = await http(handle, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    expect(page.body).toContain('<script type="application/json" id="ultraview-data">{');
    expect(page.body).toContain('"id":"cap:ordering"');
    expect(page.body).toContain(JSON.stringify({ root: repo }).replace(/</g, "\\u003c"));

    const view = await http(handle, "/view.json");
    expect(view.status).toBe(200);
    expect(view.body).toBe(readFileSync(join(repo, ".ultraview/view.json"), "utf8"));
    expect(JSON.parse(view.body).nodes.length).toBeGreaterThan(10);

    for (const path of ["/.ultraview/model.json", "/../package.json", "/src/", "/view.json/x", "/api/nope"])
      expect((await http(handle, path)).status).toBe(404);
    expect((await http(handle, "/view.json", { method: "POST" })).status).toBe(405);

    const node = await http(handle, "/api/node?id=cap:ordering");
    expect(node.status).toBe(200);
    expect(JSON.parse(node.body)).toMatchObject({ id: "cap:ordering", kind: "cap", members: { total: expect.any(Number) } });
    const unknown = await http(handle, "/api/node?id=cap:order");
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body).suggestions).toContain("cap:ordering");

    const search = JSON.parse((await http(handle, "/api/search?q=order")).body);
    expect(search.q).toBe("order");
    expect(search.nodes[0]).toEqual({ id: "entity:Order", kind: "entity", label: "Order", parent: "file:prisma/schema.prisma", at: "prisma/schema.prisma:36" });
    expect(search.nodes.length).toBeLessThanOrEqual(25);
    expect(search.modules.map((m: any) => m.slug)).toContain("src-services");
    expect(search.modules.find((m: any) => m.slug === "src-services")).toMatchObject({ ids: ["mod:src-services"], files: ["src/services/orders.ts"] });
    expect((await http(handle, "/api/search")).status).toBe(400);

    const cg = JSON.parse((await http(handle, `/api/callgraph?sym=${encodeURIComponent("sym:src/services/orders.ts#cancelOrder")}&dir=in&depth=1`)).body);
    expect(cg).toMatchObject({ depth: 1, dir: "in", root: ["sym:src/services/orders.ts#cancelOrder"] });
    expect(cg.nodes[0]).toMatchObject({ id: "sym:src/services/orders.ts#cancelOrder", depth: 0, inView: true });
    expect(cg.edges).toContainEqual({ from: "sym:src/routes/orders.ts#ordersRouter", to: "sym:src/services/orders.ts#cancelOrder", kind: "calls", weight: 1 });
    expect((await http(handle, "/api/callgraph?sym=cancelOrder&depth=9")).status).toBe(400);
    expect((await http(handle, "/api/callgraph?sym=noSuchThing")).status).toBe(404);

    // The Ask bridge is off: the endpoint does not exist.
    expect((await http(handle, "/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"question":"x"}' })).status).toBe(404);
  });

  it("guards the Host header and refuses a non-loopback bind unless asked for", async () => {
    const { repo, handle } = await serveShop();
    expect((await http(handle, "/", { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await http(handle, "/view.json", { headers: { Host: "rebind.attacker.test:4178" } })).status).toBe(403);
    expect((await http(handle, "/", { headers: { Host: `localhost:${handle.port}` } })).status).toBe(200);
    expect(allowedHostHeader("[::1]:4178", "127.0.0.1")).toBe(true);
    expect(allowedHostHeader("192.168.1.5:4178", "0.0.0.0")).toBe(true);
    expect(allowedHostHeader("my-box.local", "my-box.local")).toBe(true);
    expect(allowedHostHeader(undefined, "127.0.0.1")).toBe(false);
    expect(isLoopbackHost("127.0.0.1") && isLoopbackHost("::1") && isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    await expect(startServe({ repo, port: 0, host: "0.0.0.0", ask: "none" })).rejects.toThrow(/refusing to bind 0\.0\.0\.0: not a loopback address/);
  });

  it("pushes a view event when an agent file changes, and a stale event when source does", async () => {
    const { repo, handle } = await serveShop();
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    expect(sse.seen[0]).toMatchObject({ event: "hello", data: { version: 1, ask: null, stale: { index: false } } });

    const viewEvent = sse.next("view");
    const lens = { ...readModelFile("shop.lens.json"), id: "live-one", question: "Does the map update live?" };
    writeView(repo, "lenses/live-one.json", lens);
    expect(await viewEvent).toMatchObject({ version: 2 });
    const view = JSON.parse((await http(handle, "/view.json")).body);
    expect(view.lenses.map((l: any) => l.id)).toContain("live-one");
    expect((await http(handle, "/")).body).toContain('"id":"live-one"');

    // A burst of writes lands as one update.
    const burst = sse.seen.length;
    const settled = sse.next("view");
    for (let i = 0; i < 5; i++) writeView(repo, "lenses/live-one.json", { ...lens, answer: `${lens.answer}\n\nEdit ${i}. [src/db.ts:1]` });
    expect(await settled).toMatchObject({ version: 3 });
    await new Promise((r) => setTimeout(r, 400));
    expect(sse.seen.slice(burst).filter((e) => e.event === "view")).toHaveLength(1);

    // Source changes never rebuild: they only say the index is stale.
    const staleEvent = sse.next("stale", 10_000);
    writeFileSync(join(repo, "src/db.ts"), `${readFileSync(join(repo, "src/db.ts"), "utf8")}\n// edited\n`);
    expect(await staleEvent).toMatchObject({ index: true, changed: 1, files: ["src/db.ts"] });
  });

  it("asks a fake agent, saves its answer as a lens and pushes it live", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({
      ask: "auto",
      env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}`, ULTRAVIEW_SECRET: "never passed on" },
    });
    expect(handle.ask).toEqual({ name: "claude", path: join(fake, "claude") });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    expect(sse.seen[0]!.data.ask).toEqual({ agent: "claude", busy: false });

    const json = { "Content-Type": "application/json" };
    // Cross-origin and non-JSON posts are refused before anything runs.
    expect((await http(handle, "/api/ask", { method: "POST", headers: { ...json, Origin: "http://evil.example" }, body: '{"question":"x"}' })).status).toBe(
      403,
    );
    expect((await http(handle, "/api/ask", { method: "POST", headers: { ...json, "Sec-Fetch-Site": "cross-site" }, body: '{"question":"x"}' })).status).toBe(
      403,
    );
    expect((await http(handle, "/api/ask", { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"question":"x"}' })).status).toBe(415);
    expect((await http(handle, "/api/ask", { method: "POST", headers: json, body: '{"question":""}' })).status).toBe(400);
    expect((await http(handle, "/api/ask", { method: "GET" })).status).toBe(405);

    const done = sse.next("ask-done", 10_000);
    const progress = sse.next("ask-progress");
    const question = "How does cancelling an order work, exactly?";
    const posted = await http(handle, "/api/ask", {
      method: "POST",
      headers: { ...json, Origin: `http://127.0.0.1:${handle.port}` },
      body: JSON.stringify({ question }),
    });
    expect(posted.status).toBe(202);
    const id = "how-does-cancelling-an-order-work-exactly";
    expect(JSON.parse(posted.body)).toEqual({ id, question, agent: "claude" });
    // One ask at a time.
    expect((await http(handle, "/api/ask", { method: "POST", headers: json, body: JSON.stringify({ question: "Another one?" }) })).status).toBe(409);
    expect(await progress).toMatchObject({ id, stage: "started", agent: "claude" });
    expect(await done).toMatchObject({ id, question, file: `.ultraview/lenses/${id}.json`, replaced: false });

    // Saved by ultraview under its own id and the asked question, with sources stamped.
    const saved = JSON.parse(readFileSync(join(repo, ".ultraview/lenses", `${id}.json`), "utf8"));
    expect(saved).toMatchObject({ id, question, focus: "route:DELETE /api/orders/:id" });
    expect(Object.keys(saved.sources)).toEqual(["src/routes/orders.ts", "src/services/orders.ts"]);
    expect(existsSync(join(repo, ".ultraview/lenses/agent-picked-id.json"))).toBe(false);
    expect(JSON.parse((await http(handle, "/view.json")).body).lenses.map((l: any) => l.id)).toContain(id);
    expect(sse.seen.some((e) => e.event === "view")).toBe(true);
    const log = readFileSync(join(repo, ".ultraview/ask.log"), "utf8");
    expect(log).toContain(`ask ${id} (claude)`);
    expect(log).toContain("[stderr] fake agent read");
    expect(log).toContain("--permission-mode dontAsk");
    expect(readFileSync(join(repo, ".ultraview/.gitignore"), "utf8")).toContain("ask.log");

    // An answer that fails `lens save` ends in ask-error and saves nothing.
    const failed = sse.next("ask-error", 10_000);
    expect((await http(handle, "/api/ask", { method: "POST", headers: json, body: JSON.stringify({ question: "BROKEN answer please" }) })).status).toBe(202);
    const err = await failed;
    expect(err).toMatchObject({ id: "broken-answer-please", error: "the answer did not pass `lens save`" });
    expect(err.problems[0].message).toMatch(/dead citation/);
    expect(existsSync(join(repo, ".ultraview/lenses/broken-answer-please.json"))).toBe(false);
  });
});

/** The events of a finished event-stream body, in order. */
const frames = (body: string) =>
  body
    .split("\n\n")
    .map((f) => ({ event: /^event: (.*)$/m.exec(f)?.[1], data: /^data: (.*)$/m.exec(f)?.[1] }))
    .filter((f): f is { event: string; data: string } => !!f.event && f.data !== undefined)
    .map((f) => ({ event: f.event, data: JSON.parse(f.data) }));

/** The prompts the fake agent read, oldest first. */
const prompts = (fake: string) =>
  readdirSync(fake)
    .filter((n) => n.startsWith("prompt-"))
    .sort()
    .map((n) => readFileSync(join(fake, n), "utf8"));

describe("conversations", () => {
  it("answers a turn as an event stream, keeps the thread, and serves the conversations", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({ ask: "auto", env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` } });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const json = { "Content-Type": "application/json" };
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      http(handle, "/api/chat", { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });

    // Refused before anything runs.
    expect((await post({ question: "x" })).status).toBe(400); // no mode
    expect((await post({ question: "x", mode: "boss" })).status).toBe(400);
    expect((await post({ question: "", mode: "dev" })).status).toBe(400);
    expect((await post({ question: "x".repeat(501), mode: "dev" })).status).toBe(400);
    expect((await post({ question: "x", mode: "dev", thread: "../model" })).status).toBe(400);
    expect((await post({ question: "x", mode: "dev", thread: "no-such-thread" })).status).toBe(404);
    expect((await post({ question: "x", mode: "dev", context: { node: "entity:Ghost" } })).status).toBe(400);
    expect((await post({ question: "x", mode: "dev", context: { color: "red" } })).status).toBe(400);
    expect((await post({ question: "x", mode: "dev", extra: 1 })).status).toBe(400);
    expect((await post({ question: "x", mode: "dev" }, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await http(handle, "/api/chat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await http(handle, "/api/chat", { method: "DELETE" })).status).toBe(405);
    expect(prompts(fake)).toEqual([]);

    // Turn 1: progress events, then the saved turn; the conversation is created and pushed live.
    const live = sse.next("chat", 10_000);
    const first = await post({ question: "How does cancelling an order work?", mode: "business", context: { node: "route:DELETE /api/orders/:id" } });
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    const ev = frames(first.body);
    expect(ev.map((e) => e.event)).toEqual([...Array(ev.length - 1).fill("progress"), "turn"]);
    expect(ev[0]!.data).toEqual({ text: "asking claude" });
    expect(ev.map((e) => e.data.text)).toContain("checking the answer: schema, node ids, citations");
    const turn = ev.at(-1)!.data;
    expect(turn).toMatchObject({ thread: "how-does-cancelling-an-order-work", index: 0 });
    // The question, mode and context are the request's, not the agent's.
    expect(turn.turn).toMatchObject({
      question: "How does cancelling an order work?",
      mode: "business",
      lang: "en",
      source: "agent",
      context: { node: "route:DELETE /api/orders/:id" },
      followUps: ["Who calls it?", "What does it store?", "Can it fail?"],
      answer: { focus: "route:DELETE /api/orders/:id" },
    });
    expect(Object.keys(turn.turn.sources)).toEqual(["src/routes/orders.ts", "src/services/orders.ts"]);
    expect(turn.turn.ms).toEqual(expect.any(Number));
    expect(await live).toEqual({ id: "how-does-cancelling-an-order-work" });
    const p1 = prompts(fake)[0]!;
    expect(p1).toContain("You answer one turn of a conversation");
    expect(p1).toContain(`lens new 'How does cancelling an order work?' --context '{"node":"route:DELETE /api/orders/:id"}'`);
    expect(p1).toContain("The user asked from the map, about: node route:DELETE /api/orders/:id (DELETE /api/orders/:id).");
    expect(p1).toContain("Mode business: the reader does not read code.");
    expect(p1).toContain("Answer in the language of the question");
    expect(p1).toContain("followUps: exactly 3 short questions");
    expect(p1).not.toContain("Conversation so far");

    // Turn 2 follows up in the thread: its prompt carries the digest.
    const second = await post({ thread: "how-does-cancelling-an-order-work", question: "et qui l'appelle ?", mode: "dev" });
    expect(frames(second.body).at(-1)).toMatchObject({ event: "turn", data: { index: 1, turn: { mode: "dev", question: "et qui l'appelle ?" } } });
    const p2 = prompts(fake)[1]!;
    expect(p2).toContain("## Conversation so far (thread how-does-cancelling-an-order-work: 1 turn(s); most recent last)");
    expect(p2).toContain('1. [en, business] "How does cancelling an order work?"');
    expect(p2).toContain("--thread how-does-cancelling-an-order-work");
    expect(p2).toContain("Mode dev: the reader is a developer.");

    const conv = await http(handle, "/api/chat?id=how-does-cancelling-an-order-work");
    expect(conv.status).toBe(200);
    expect(JSON.parse(conv.body)).toEqual(JSON.parse(readFileSync(join(repo, ".ultraview/conversations/how-does-cancelling-an-order-work.json"), "utf8")));
    expect((await http(handle, "/api/chat?id=../model")).status).toBe(400);
    expect((await http(handle, "/api/chat?id=nope")).status).toBe(404);
    expect((await http(handle, "/api/chat")).status).toBe(400);
    const list = JSON.parse((await http(handle, "/api/chats")).body);
    expect(list).toEqual([{ id: "how-does-cancelling-an-order-work", title: "How does cancelling an order work?", turns: 2, updatedAt: expect.any(String) }]);

    // An answer that fails the gates ends in an error event and saves nothing.
    const bad = await post({ thread: "how-does-cancelling-an-order-work", question: "BROKEN answer please", mode: "dev" });
    const last = frames(bad.body).at(-1)!;
    expect(last.event).toBe("error");
    expect(last.data.message).toMatch(/did not pass the turn's gates.*dead citation/);
    expect(JSON.parse((await http(handle, "/api/chat?id=how-does-cancelling-an-order-work")).body).turns).toHaveLength(2);
    // The views never changed for a conversation.
    expect(sse.seen.filter((e) => e.event === "view")).toEqual([]);
  });

  it("pushes a conversation saved from the terminal as a chat event, not a view", async () => {
    const { repo, handle } = await serveShop();
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const chat = sse.next("chat");
    const turn = {
      question: "Where is the client?",
      lang: "en",
      mode: "dev",
      source: "agent",
      answer: { answer: "The client is created once. [src/db.ts:3]", nodes: ["sym:src/db.ts#prisma"] },
      followUps: ["a?", "b?", "c?"],
      sources: {},
      at: "2026-01-01T00:00:00.000Z",
    };
    writeView(repo, "conversations/from-terminal.json", { id: "from-terminal", title: "T", createdAt: "2026-01-01T00:00:00.000Z", turns: [turn] });
    expect(await chat).toEqual({ id: "from-terminal" });
    // A draft is not a conversation; no view is re-assembled for either.
    writeView(repo, "conversations/from-terminal.draft.json", { question: "next?" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(sse.seen.filter((e) => e.event === "chat")).toHaveLength(1);
    expect(sse.seen.filter((e) => e.event === "view")).toEqual([]);
    expect(JSON.parse((await http(handle, "/api/chats")).body).map((c: any) => c.id)).toEqual(["from-terminal"]);
    // Without an agent the chat endpoint does not take questions, but still serves what is saved.
    expect(
      (await http(handle, "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"question":"x","mode":"dev"}' })).status,
    ).toBe(404);
    expect((await http(handle, "/api/chat?id=from-terminal")).status).toBe(200);
    // The served page reads conversations live: none are embedded in it.
    expect((await http(handle, "/")).body).toContain('<script type="application/json" id="ultraview-chats">[]</script>');
  });
});

describe("ask timeout", () => {
  it("stops an agent that does not answer in time", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({
      ask: "claude",
      askTimeoutMs: 1000,
      env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` },
    });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const failed = sse.next("ask-error", 5000);
    const posted = await http(handle, "/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"question":"SLOW one"}' });
    expect(posted.status).toBe(202);
    expect(await failed).toMatchObject({ id: "slow-one", error: "claude did not answer within 1 s" });
    expect(readFileSync(join(repo, ".ultraview/ask.log"), "utf8")).toContain("timed out after 1 s");
    // The slot is free again.
    expect(
      JSON.parse((await http(handle, "/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"question":"next"}' })).body),
    ).toMatchObject({ id: "next" });
  });
});

describe("ask bridge", () => {
  it("builds a turn's prompt: the digest, the click, the register and the language rule", () => {
    const thread = {
      id: "orders",
      title: "Orders",
      createdAt: "2026-01-01T00:00:00.000Z",
      turns: [
        {
          question: "Where is the client?",
          lang: "en",
          mode: "business" as const,
          source: "agent" as const,
          answer: { answer: "Created once. [src/db.ts:3]", nodes: ["sym:src/db.ts#prisma"] },
          followUps: ["a", "b", "c"],
          sources: {},
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const p = chatPrompt(
      {
        question: "und wer nutzt ihn?",
        mode: "business",
        thread,
        context: { value: { node: "sym:src/db.ts#prisma" }, lines: ["node sym:src/db.ts#prisma (prisma)"] },
      },
      "/x/ultraview.mjs",
    );
    expect(p).toContain(`node /x/ultraview.mjs lens new 'und wer nutzt ihn?' --thread orders --context '{"node":"sym:src/db.ts#prisma"}'`);
    expect(p).toContain('1. [en, business] "Where is the client?"');
    expect(p).toContain("In play (most recent first): sym:src/db.ts#prisma");
    expect(p).toContain("do not name functions, files, symbols or routes unless the question asks for them");
    expect(p).toContain('you MUST add --terms "<English code keywords>"');
    expect(p).toContain('"followUps": ["...", "...", "..."]');
    // A quote in the question or the context cannot break out of its shell argument, and nothing in them is expanded.
    expect(chatPrompt({ question: "what's $(id)?", mode: "dev" }, "/x/u.mjs")).toContain(`lens new 'what'\\''s $(id)?'`);
    expect(chatPrompt({ question: "q", mode: "dev", context: { value: { node: "sym:a.ts#it's" }, lines: [] } }, "/x/u.mjs")).toContain(
      `--context '{"node":"sym:a.ts#it'\\''s"}'`,
    );
  });

  it("states the citation rule, with its examples, where the answer is written", () => {
    for (const p of [askPrompt("q", "q", "/x/u.mjs"), chatPrompt({ question: "q", mode: "business" }, "/x/u.mjs")]) {
      const at = p.indexOf("   - answer: Markdown");
      expect(at).toBeGreaterThan(0);
      // Right under the answer bullet, before the nodes bullet: the agent reads it as it writes.
      expect(p.slice(at, p.indexOf("   - nodes:"))).toContain(CITATION_RULE.map((l) => `     ${l}`).join("\n"));
      expect(p).toContain("The citation rule, exactly as ultraview checks it before it saves your reply:");
      expect(p).toContain(`Correct:   ${CITATION_EXAMPLE.correct}`);
      expect(p).toContain(`Incorrect: ${CITATION_EXAMPLE.incorrect}`);
      expect(p).toContain("the summary or opening line,");
      expect(p).toContain("each lead-in, transition and conclusion, the line that introduces a list, and each list item");
      expect(p).toContain("A bold label (**How it works.**, **In short:**) is part of the sentence it introduces");
      expect(p).toContain("is dropped, not left uncited");
      expect(p).toContain(
        "The opening summary (In short / En bref / En resumen…, bold or not) ends with the citation(s) of the main fact(s) it sums up,\n     placed at the end of that summary sentence",
      );
      expect(p).toContain(`(refused: the opening summary ${JSON.stringify(CITATION_EXAMPLE.uncited[0])} and the closing`);
    }
    expect(correctionPrompt("P", {}, [])).toContain(
      "(a lead-in, transition or conclusion too; a bold label belongs to the sentence after it; the opening summary ends with the citation(s) of the fact(s) it sums up).",
    );
  });

  it("asks the agent for English --terms when the question is not in English", () => {
    const prompt = askPrompt("¿Cómo se cancela un pedido?", "como-se-cancela-un-pedido", "/x/ultraview.mjs");
    expect(prompt).toContain('node /x/ultraview.mjs lens new "¿Cómo se cancela un pedido?" --id como-se-cancela-un-pedido');
    expect(prompt).toContain('If the question is not in English, you MUST add --terms "<English code keywords>"');
  });

  it("finds agents on PATH and builds read-only command lines", () => {
    const fake = fakeAgent();
    expect(findOnPath("claude", fake)).toBe(join(fake, "claude"));
    expect(resolveAskAgent("codex", fake)).toBeUndefined();
    expect(resolveAskAgent("none", fake)).toBeUndefined();
    const claude = agentInvocation({ name: "claude", path: "/bin/claude" }, { script: "/x/ultraview.mjs", repo: "/r", tmpDir: "/t" });
    expect(claude.args.slice(0, 9)).toEqual([
      "-p",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Bash,Read,Glob,Grep",
      "--allowedTools",
    ]);
    expect(claude.args).toContain("Bash(node /x/ultraview.mjs lens new:*)");
    // explain is read-only: the agent may run it for a node's proven facts.
    expect(claude.args).toContain("Bash(node /x/ultraview.mjs explain:*)");
    expect(askPrompt("q", "q", "/x/ultraview.mjs")).toContain("node /x/ultraview.mjs explain <node-id> gives instant proven facts about a node");
    expect(chatPrompt({ question: "q", mode: "dev" }, "/x/ultraview.mjs")).toContain(
      "node /x/ultraview.mjs explain <node-id> gives instant proven facts about a node",
    );
    expect(claude.args).not.toContain("Bash(node /x/ultraview.mjs lens save:*)");
    const codex = agentInvocation({ name: "codex", path: "/bin/codex" }, { script: "/x/ultraview.mjs", repo: "/r", tmpDir: "/t" });
    expect(codex.args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      "/r",
      "--output-last-message",
      "/t/last-message.txt",
      "-",
    ]);
    for (const inv of [claude, codex]) expect(inv.args.join(" ")).not.toMatch(/bypass|dangerously|full-access|acceptEdits/);
    const env = agentEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "s" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "o", NO_COLOR: "1" });
    expect(extractLensJson('{"id":"a"}')).toEqual({ id: "a" });
    expect(extractLensJson('Sure:\n```json\n{"id":"b"}\n```\nDone.')).toEqual({ id: "b" });
    expect(extractLensJson("no json here")).toBeUndefined();
  });
});

describe("node ids and the correction round", () => {
  const json = { "Content-Type": "application/json" };
  const ask = (handle: ServeHandle, question: string) => http(handle, "/api/ask", { method: "POST", headers: json, body: JSON.stringify({ question }) });
  const examplesOf = (repo: string, question: string) => nodeIdExamples(lensNew(repo, question).candidates.map((c) => c.id));

  it("picks the prompt's examples from the pack: a module first, then one id of each other kind", () => {
    expect(nodeIdExamples(["route:GET /a", "sym:a.ts#f", "route:GET /b", "mod:src-a", "entity:A", "not-an-id"])).toEqual([
      "mod:src-a",
      "route:GET /a",
      "sym:a.ts#f",
    ]);
    expect(nodeIdExamples(["entity:A", "entity:B"])).toEqual(["entity:A"]);
    expect(nodeIdExamples([])).toEqual([]);
    const examples = ["mod:src-services", "route:DELETE /api/orders/:id"];
    for (const p of [askPrompt("q", "q", "/x/u.mjs", examples), chatPrompt({ question: "q", mode: "dev", examples }, "/x/u.mjs")]) {
      expect(p).toContain(
        'A node id is <kind>:<name>, the kind one of cap: sys: mod: file: sym: route: screen: entity: job: ext: infra:, written exactly as the candidates list it (e.g. "mod:src-services", "route:DELETE /api/orders/:id").',
      );
      expect(p).toContain("ultraindex module slugs and file paths are not node ids: write mod:<slug> for a module and file:<path> for a file.");
    }
    expect(askPrompt("q", "q", "/x/u.mjs")).toContain("written exactly as the candidates list it.");
    // The edge rule, under the node id rule: the kinds around the pack first, with their meaning; every kind without a pack.
    const edges = [{ from: "file:src/services/orders.ts", to: "entity:Order", kind: "data" as const }];
    for (const p of [askPrompt("q", "q", "/x/u.mjs", examples, edges), chatPrompt({ question: "q", mode: "dev", examples, edges }, "/x/u.mjs")]) {
      expect(p).toContain(
        '   - Each edge is exactly {"from": "<node id>", "to": "<node id>", "kind": "<edge kind>"}: kind optional, no other key (no label); edges may be [].\n' +
          "     Edge kinds around these candidates: data (code reads or writes an entity, or an entity relates to another). The other edge kinds: import, call, http, rpc, event, queue, extends, config, contains.\n" +
          '     e.g. {"from": "file:src/services/orders.ts", "to": "entity:Order", "kind": "data"}\n' +
          "     Any other key is dropped; an edge with another kind, or an end that is not a node of the map, is dropped.\n",
      );
      expect(p.indexOf("Each edge is exactly")).toBeGreaterThan(p.indexOf("A node id is <kind>:<name>"));
    }
    expect(askPrompt("q", "q", "/x/u.mjs")).toContain("     Edge kinds: import (a file or module imports another); call (");
    const again = correctionPrompt("PROMPT", { nodes: ["src-x"] }, [{ path: "nodes[0]", message: "bad" }]);
    expect(again.startsWith("PROMPT\n\n## Correction round\n")).toBe(true);
    expect(again).toContain('- nodes[0]: bad\n\nYour reply was:\n```json\n{\n  "nodes": [\n    "src-x"\n  ]\n}\n```');
    expect(again).toContain("Reply with ONLY the corrected JSON object");
  });

  it("repairs bare node ids before the gates, logs each repair, and shows the pack's ids in the prompt", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({ ask: "claude", env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` } });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const question = "BARE: how does cancelling an order work?";
    const done = sse.next("ask-done", 10_000);
    expect((await ask(handle, question)).status).toBe(202);
    const { file } = await done;
    const saved = JSON.parse(readFileSync(join(repo, file), "utf8"));
    expect(saved).toMatchObject({
      nodes: ["route:DELETE /api/orders/:id", "sym:src/services/orders.ts#cancelOrder", "entity:Order", "mod:src-services"],
      edges: [{ from: "route:DELETE /api/orders/:id", to: "entity:Order", kind: "data" }],
      focus: "route:DELETE /api/orders/:id",
    });
    const log = readFileSync(join(repo, ".ultraview/ask.log"), "utf8");
    expect(log).toContain('--- repaired 7 node id(s):\n  nodes[0]: "DELETE /api/orders/:id" -> "route:DELETE /api/orders/:id"\n');
    expect(log).toContain('  nodes[3]: "src-services" -> "mod:src-services"');
    expect(log).not.toContain("correction round");
    // One round only; the prompt shows real ids of this question's pack, a module's among them.
    const [prompt, ...more] = prompts(fake);
    expect(more).toEqual([]);
    const examples = examplesOf(repo, question);
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(examples[0]).toMatch(/^mod:/);
    expect(prompt).toContain(`(e.g. ${examples.map((e) => JSON.stringify(e)).join(", ")})`);
  });

  it("repairs or drops bad edges before the gates instead of refusing, logs each, and states the edge kinds in the prompt", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({ ask: "claude", env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` } });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const question = "LABELS: how does cancelling an order work?";
    const done = sse.next("ask-done", 10_000);
    expect((await ask(handle, question)).status).toBe(202);
    const { file } = await done;
    const saved = JSON.parse(readFileSync(join(repo, file), "utf8"));
    expect(saved.edges).toEqual([
      { from: "route:DELETE /api/orders/:id", to: "sym:src/services/orders.ts#cancelOrder", kind: "call" },
      { from: "sym:src/services/orders.ts#cancelOrder", to: "entity:Order", kind: "data" },
    ]);
    const log = readFileSync(join(repo, ".ultraview/ask.log"), "utf8");
    expect(log).toContain("--- repaired 2 edge kind(s); dropped 1 edge key(s), 1 edge(s):\n");
    expect(log).toContain('  edges[0].label: dropped "hands the id over" (not an edge key (an edge holds from, to, kind))\n');
    expect(log).toContain('  edges[0].kind: "calls" -> "call"\n');
    expect(log).toContain(
      '  edges[2]: dropped {"from":"sym:src/services/orders.ts#cancelOrder","to":"entity:Order","kind":"uses"} (kind "uses" is not an edge kind',
    );
    expect(log).not.toContain("correction round");
    // One round; the prompt states the edge shape and the kinds around this pack's candidates, with their meaning.
    const [prompt, ...more] = prompts(fake);
    expect(more).toEqual([]);
    const kinds = [...new Set(lensNew(repo, question).neighbourhood.map((e) => e.kind))];
    expect(kinds.length).toBeGreaterThan(0);
    expect(prompt).toContain(
      '   - Each edge is exactly {"from": "<node id>", "to": "<node id>", "kind": "<edge kind>"}: kind optional, no other key (no label); edges may be [].',
    );
    expect(prompt).toContain("     Edge kinds around these candidates: ");
    for (const k of kinds) expect(prompt).toContain(`${k} (`);
    expect(prompt).toMatch(/\n {5}e\.g\. \{"from": "[^"]+", "to": "[^"]+", "kind": "[a-z]+"\}\n/);
  });

  it("repairs a turn's edges the same way, and gives them as `repairs`", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({ ask: "claude", env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` } });
    const r = await http(handle, "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "LABELS: how does cancelling an order work?", mode: "dev" }),
    });
    const turn = frames(r.body).at(-1)!;
    expect(turn.event).toBe("turn");
    expect(turn.data.turn.answer.edges).toEqual([
      { from: "route:DELETE /api/orders/:id", to: "sym:src/services/orders.ts#cancelOrder", kind: "call" },
      { from: "sym:src/services/orders.ts#cancelOrder", to: "entity:Order", kind: "data" },
    ]);
    expect(readFileSync(join(repo, ".ultraview/ask.log"), "utf8")).toContain("--- repaired 2 edge kind(s); dropped 1 edge key(s), 1 edge(s):\n");
    const [prompt] = prompts(fake);
    expect(prompt).toContain("You answer one turn of a conversation");
    expect(prompt).toContain('   - Each edge is exactly {"from": "<node id>", "to": "<node id>", "kind": "<edge kind>"}');
    expect(prompt).toContain("Any other key is dropped; an edge with another kind, or an end that is not a node of the map, is dropped.");
  });

  it("asks once more with the gate messages and the reply, with the same command line, and saves the correction", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({
      ask: "claude",
      askModel: "sonnet",
      env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` },
    });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const done = sse.next("ask-done", 10_000);
    expect((await ask(handle, "FIXABLE: how does cancelling work?")).status).toBe(202);
    expect(await done).toMatchObject({ id: "fixable-how-does-cancelling-work", file: ".ultraview/lenses/fixable-how-does-cancelling-work.json" });
    expect(sse.seen.filter((e) => e.event === "ask-progress").map((e) => e.data.stage)).toContain("retrying");
    expect(sse.seen.find((e) => e.event === "ask-progress" && e.data.stage === "retrying")!.data).toMatchObject({ problems: 1 });
    const [first, second, ...more] = prompts(fake);
    expect(more).toEqual([]);
    expect(second!.startsWith(first!.trimEnd())).toBe(true);
    expect(second).toContain("## Correction round");
    expect(second).toContain("- answer: dead citation [src/services/orders.ts:999]");
    expect(second).toContain('"answer": "This cites a line that does not exist. [src/services/orders.ts:999]"');
    const log = readFileSync(join(repo, ".ultraview/ask.log"), "utf8");
    expect(log).toContain("--- refused by the gates (1 problem(s)):\n  answer: dead citation [src/services/orders.ts:999]");
    expect(log).toMatch(/=== correction round \(claude, \d+ s left\)/);
    // Both rounds logged, with the same read-only command line and model flag.
    expect(log.match(/^\$ .*--permission-mode dontAsk.*--model sonnet$/gm)).toHaveLength(2);
    expect(log.match(/\[stderr\] fake agent read/g)).toHaveLength(2);
    expect(log.trimEnd().endsWith("--- saved .ultraview/lenses/fixable-how-does-cancelling-work.json")).toBe(true);
  });

  it("fails with the second round's messages when the correction fails the gates too", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({ ask: "claude", env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` } });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const failed = sse.next("ask-error", 10_000);
    expect((await ask(handle, "BROKEN twice")).status).toBe(202);
    const err = await failed;
    expect(err).toMatchObject({ id: "broken-twice", error: "the answer did not pass `lens save`" });
    expect(err.problems).toEqual([{ path: "answer", message: expect.stringMatching(/^dead citation \[src\/services\/orders\.ts:999\]/) }]);
    expect(prompts(fake)).toHaveLength(2);
    expect(existsSync(join(repo, ".ultraview/lenses/broken-twice.json"))).toBe(false);
    const log = readFileSync(join(repo, ".ultraview/ask.log"), "utf8");
    expect(log).toContain("=== correction round");
    expect(log.trimEnd()).toMatch(/--- failed: the answer did not pass `lens save`\n {2}answer: dead citation/);
  });

  it("keeps the correction round within the same timeout", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { repo, handle } = await serveShop({
      ask: "claude",
      askTimeoutMs: 3000,
      env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` },
    });
    const sse = events(handle);
    cleanups.push(() => sse.close());
    await sse.opened;
    const failed = sse.next("ask-error", 8000);
    const t0 = Date.now();
    expect((await ask(handle, "SLOWFIX please")).status).toBe(202);
    const err = await failed;
    const elapsed = Date.now() - t0;
    // The whole ask, both rounds, stops at the one deadline; the first round's messages still say why.
    expect(elapsed).toBeLessThan(3000 + 1500);
    expect(err).toMatchObject({ id: "slowfix-please", error: "claude did not answer within 3 s" });
    expect(err.problems[0].message).toMatch(/^dead citation \[src\/services\/orders\.ts:999\]/);
    expect(prompts(fake)).toHaveLength(2);
    const log = readFileSync(join(repo, ".ultraview/ask.log"), "utf8");
    expect(log).toContain("=== correction round");
    expect(log).toContain("--- timed out after 3 s: stopping claude");
  });

  it("shows the correction round as a progress event of a conversation turn", async () => {
    if (process.platform === "win32") return;
    const fake = fakeAgent();
    const { handle } = await serveShop({ ask: "claude", env: { ...process.env, PATH: `${fake}${delimiter}${process.env.PATH ?? ""}` } });
    const turn = await http(handle, "/api/chat", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ question: "FIXABLE: who cancels an order?", mode: "dev" }),
    });
    const ev = frames(turn.body);
    expect(ev.map((e) => e.data.text)).toContain("the answer did not pass the gates (1 problem(s)): asking claude once to correct it");
    expect(ev.at(-1)).toMatchObject({ event: "turn", data: { index: 0, turn: { question: "FIXABLE: who cancels an order?" } } });
    const [first, second] = prompts(fake);
    expect(first).toContain("ultraindex module slugs and file paths are not node ids");
    expect(first).toMatch(/written exactly as the candidates list it \(e\.g\. "mod:/);
    expect(second).toContain("## Correction round");
  });
});
