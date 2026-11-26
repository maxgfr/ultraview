// The live state of a served map (viewer/lib/live.ts): what `hello`, `stale`
// and the `ask-*` events of `ultraview serve` turn into (the stale banner, the
// Ask box's progress, the lens to open), plus rpc edges in the viewer's
// scenes. Pure logic; runs in node.

import { describe, expect, it } from "vitest";
import type { ViewModel } from "../src/model/types.js";
import { buildIndex } from "../viewer/lib/data.js";
import { buildScene, dominantKind } from "../viewer/lib/levels.js";
import {
  askMode,
  initialLive,
  type LiveEvent,
  type LiveState,
  liveReducer,
  QUESTION_MAX,
  questionOk,
  readStale,
  showStale,
  staleCount,
} from "../viewer/lib/live.js";

const run = (events: LiveEvent[], from: LiveState = initialLive) => events.reduce(liveReducer, from);
const hello = (ask: unknown = { agent: "claude", busy: false }, stale: unknown = { index: false, changed: 0, added: 0, removed: 0, files: [] }): LiveEvent => ({
  type: "hello",
  data: { version: 1, stale, ask },
});

describe("live state", () => {
  it("shows nothing before hello, and the Ask box only with a bridge", () => {
    expect(askMode(initialLive)).toBe("off");
    expect(showStale(initialLive)).toBe(false);
    expect(askMode(run([hello(null)]))).toBe("off");
    expect(askMode(run([hello()]))).toBe("ready");
    expect(askMode(run([hello({ agent: "codex", busy: true })]))).toBe("busy");
    // Junk is ignored, never trusted.
    expect(run([{ type: "hello", data: "nope" }])).toEqual(initialLive);
    expect(askMode(run([hello({ agent: 42 })]))).toBe("off");
  });

  it("raises the stale banner with the changed-file count, dismissed until the counts change", () => {
    const stale = { index: true, changed: 2, added: 1, removed: 0, files: ["a.ts", "b.ts", "c.ts", 7] };
    let s = run([hello(), { type: "stale", data: stale }]);
    expect(showStale(s)).toBe(true);
    expect(staleCount(s.stale!)).toBe(3);
    expect(s.stale!.files).toEqual(["a.ts", "b.ts", "c.ts"]);
    s = liveReducer(s, { type: "dismiss-stale" });
    expect(showStale(s)).toBe(false);
    s = liveReducer(s, { type: "stale", data: { ...stale } });
    expect(showStale(s)).toBe(false);
    s = liveReducer(s, { type: "stale", data: { ...stale, changed: 5 } });
    expect(showStale(s)).toBe(true);
    // Fresh again: no banner.
    s = liveReducer(s, { type: "stale", data: { index: false, changed: 0, added: 0, removed: 0, files: [] } });
    expect(showStale(s)).toBe(false);
    // Stale already at connect time (hello.stale).
    expect(showStale(run([hello(null, stale)]))).toBe(true);
    expect(readStale({ index: "yes" })).toBeUndefined();
    expect(readStale({ index: true, changed: -3, added: 1.7 })).toEqual({ index: true, changed: 0, added: 1, removed: 0, files: [] });
  });

  it("follows this page's ask from sending to the saved lens", () => {
    const q = "How are refunds handled?";
    let s = run([hello(), { type: "ask-sent", question: `  ${q} ` }]);
    expect(s.run).toEqual({ question: q, stage: "sending", mine: true });
    expect(askMode(s)).toBe("busy");
    // Progress can beat the POST's answer: it is ours by its question.
    s = liveReducer(s, { type: "ask-progress", data: { id: "how-are-refunds-handled", question: q, agent: "claude", stage: "started" } });
    expect(s.run).toMatchObject({ id: "how-are-refunds-handled", stage: "started", mine: true, agent: "claude" });
    s = liveReducer(s, { type: "ask-accepted", id: "how-are-refunds-handled", question: q, agent: "claude" });
    s = liveReducer(s, { type: "ask-progress", data: { id: "how-are-refunds-handled", question: q, agent: "claude", stage: "running", bytes: 4096 } });
    expect(s.run).toMatchObject({ stage: "running", bytes: 4096, mine: true });
    s = liveReducer(s, { type: "ask-progress", data: { id: "how-are-refunds-handled", question: q, agent: "claude", stage: "validating" } });
    s = liveReducer(s, { type: "ask-done", data: { id: "how-are-refunds-handled", question: q, agent: "claude", file: ".ultraview/lenses/x.json" } });
    expect(s.run).toBeUndefined();
    expect(s.opened).toEqual({ id: "how-are-refunds-handled", question: q });
    expect(askMode(s)).toBe("ready");
    s = liveReducer(s, { type: "opened" });
    expect(s.opened).toBeUndefined();
  });

  it("shows this page's failure with the save problems, and clears it on the next ask", () => {
    let s = run([
      hello(),
      { type: "ask-sent", question: "Why?" },
      { type: "ask-accepted", id: "why", question: "Why?" },
      {
        type: "ask-error",
        data: {
          id: "why",
          question: "Why?",
          agent: "claude",
          error: "the answer did not pass lens save",
          problems: [{ path: "answer", message: "cites src/a.ts:999, past the end of the file" }, { path: "", message: "no nodes" }, "plain", 3, { path: "x" }],
        },
      },
    ]);
    expect(s.error).toEqual({
      question: "Why?",
      error: "the answer did not pass lens save",
      problems: ["answer: cites src/a.ts:999, past the end of the file", "no nodes", "plain"],
    });
    expect(askMode(s)).toBe("ready");
    expect(s.opened).toBeUndefined();
    s = liveReducer(s, { type: "ask-sent", question: "Again?" });
    expect(s.error).toBeUndefined();
    s = liveReducer(s, { type: "dismiss-error" });
    expect(s.error).toBeUndefined();
  });

  it("another page's ask makes this one busy, but opens nothing here", () => {
    let s = run([hello(), { type: "ask-progress", data: { id: "other", question: "Other?", agent: "claude", stage: "started" } }]);
    expect(askMode(s)).toBe("busy");
    expect(s.run).toMatchObject({ mine: false, question: "Other?" });
    s = liveReducer(s, { type: "ask-done", data: { id: "other", question: "Other?" } });
    expect(askMode(s)).toBe("ready");
    expect(s.opened).toBeUndefined();
    s = run(
      [
        { type: "ask-progress", data: { id: "other", question: "Other?", stage: "started" } },
        { type: "ask-error", data: { id: "other", question: "Other?", error: "x" } },
      ],
      s,
    );
    expect(s.error).toBeUndefined();
  });

  it("a refused ask (409) leaves the bridge busy until the running one ends", () => {
    let s = run([hello(), { type: "ask-sent", question: "Q?" }, { type: "ask-refused", status: 409, error: "busy", id: "running-one" }]);
    expect(s.run).toBeUndefined();
    expect(s.error?.error).toBe("busy");
    expect(askMode(s)).toBe("busy");
    s = liveReducer(s, { type: "ask-done", data: { id: "running-one", question: "Elsewhere?" } });
    expect(askMode(s)).toBe("ready");
  });

  it("a reconnect drops a run the server no longer has", () => {
    const s = run([hello(), { type: "ask-sent", question: "Q?" }, hello()]);
    expect(s.run).toBeUndefined();
    expect(askMode(s)).toBe("ready");
  });

  it("accepts questions the server accepts", () => {
    expect(questionOk("")).toBe(false);
    expect(questionOk("   ")).toBe(false);
    expect(questionOk("Why?")).toBe(true);
    expect(questionOk("x".repeat(QUESTION_MAX))).toBe(true);
    expect(questionOk("x".repeat(QUESTION_MAX + 1))).toBe(false);
  });
});

describe("rpc edges in the viewer", () => {
  const m = { loc: 1, pagerank: 0, churn: 0, tests: 0 };
  const n = (id: string, kind: string, parent?: string) => ({ id, kind, label: id, ...(parent ? { parent } : {}), cites: [], metrics: m, caps: [], tags: [] });
  const view = {
    schema: 1,
    repo: { name: "t" },
    app: { name: "t", cites: [], audience: "developers" },
    nodes: [
      n("sys:web", "sys"),
      n("sys:api", "sys"),
      n("mod:web", "mod", "sys:web"),
      n("mod:api", "mod", "sys:api"),
      n("file:web/page.tsx", "file", "mod:web"),
      n("file:api/router.ts", "file", "mod:api"),
      n("route:QUERY user.byId", "route", "file:api/router.ts"),
    ],
    edges: [
      { from: "file:web/page.tsx", to: "route:QUERY user.byId", kind: "rpc", weight: 1, derived: true },
      { from: "file:web/page.tsx", to: "file:api/router.ts", kind: "import", weight: 1, derived: true },
      { from: "mod:web", to: "mod:api", kind: "rpc", weight: 1, derived: true },
      { from: "mod:web", to: "mod:api", kind: "import", weight: 1, derived: true },
      { from: "sys:web", to: "sys:api", kind: "rpc", weight: 1, derived: true },
    ],
    flows: [],
    lenses: [],
    timeline: [],
    changes: null,
    insights: [],
    glossary: [],
    tour: [],
    coverage: { filesInSystems: 1, modulesInCapabilities: 0 },
    stale: { lenses: [], flows: [], prose: [] },
  } as unknown as ViewModel;
  const ix = buildIndex(view);

  it("styles a line by rpc when a call to the server is among its kinds", () => {
    expect(dominantKind(["import", "rpc"])).toBe("rpc");
    expect(dominantKind(["http", "rpc"])).toBe("rpc");
    expect(dominantKind(["call", "http"])).toBe("http");
  });

  it("draws rpc at every level, merged with the imports of the same pair", () => {
    expect(buildScene(ix, { level: "sys" }, "developer").edges.map((e) => [e.id, e.kind])).toEqual([["sys:web->sys:api", "rpc"]]);
    expect(buildScene(ix, { level: "mod" }, "developer").edges.map((e) => [e.id, e.kind, e.kinds])).toEqual([["mod:web->mod:api", "rpc", ["rpc", "import"]]]);
    const file = buildScene(ix, { level: "file" }, "developer");
    expect(file.edges.map((e) => [e.id, e.kind])).toEqual([["file:web/page.tsx->file:api/router.ts", "rpc"]]);
  });
});
