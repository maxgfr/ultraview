import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentEnv, agentInvocation, askPrompt, extractLensJson, findOnPath, resolveAskAgent } from "../src/ask.js";
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

/** A fake agent CLI named `claude`: checks it was started read-only, then replies with a lens. */
function fakeAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "ultraview-fake-agent-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const lens = readModelFile("shop.lens.json");
  const broken = { ...lens, answer: "This cites a line that does not exist. [src/services/orders.ts:999]" };
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
  setTimeout(() => {
    const lens = prompt.includes("BROKEN") ? ${JSON.stringify(broken)} : ${JSON.stringify(lens)};
    process.stdout.write("Here is the lens:\\n\`\`\`json\\n" + JSON.stringify({ ...lens, id: "agent-picked-id", question: "agent rewrote it" }) + "\\n\`\`\`\\n");
  }, prompt.includes("SLOW") ? 20000 : 300);
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
