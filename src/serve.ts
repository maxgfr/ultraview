// `ultraview serve`, as a library call (docs/design.md §7, §8): a local,
// dependency-free (node:http) server for the map, with live data.
//
//   GET  /               the viewer page, rendered from the current view (src/render.ts)
//   GET  /view.json      the current view-model
//   GET  /events         Server-Sent Events: hello, view, stale, ask-progress, ask-done, ask-error
//   GET  /api/node       ?id=          the node card (`show --json`)
//   GET  /api/search     ?q=           node label / id match + ultraindex find over modules
//   GET  /api/callgraph  ?sym=&depth=&dir=   the codeindex symbol neighbourhood
//   POST /api/ask        {question}    the Ask bridge (src/ask.ts), when an agent CLI is enabled
//   POST /api/explain    {node, mode, lang?}   the instant answer from proven facts (src/explain.ts)
//
// Live data: `.ultraview/` (model.json, flows/, lenses/, timeline.jsonl,
// changes/, facts.json) and `.ultraindex/` are watched; a change re-assembles
// the view from the files as they stand (no re-indexing), debounced, and
// pushes `view` when the bytes changed. Source files are watched too, but a
// change there never rebuilds: it re-checks the index and pushes `stale`.
//
// Security: binds loopback by default (a non-loopback host only when asked for
// explicitly); every request's Host header must name a loopback host, an IP
// literal or the bound host (DNS rebinding); POST requires JSON and a
// same-origin Origin / Sec-Fetch-Site when the browser sends them, and comes
// from a loopback client when bound wider; no CORS headers; nothing but the
// routes above is served (no files, no directory listing); bounded inputs and
// outputs.

import type { ChildProcess } from "node:child_process";
import { existsSync, type FSWatcher, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type AskAgent, type AskMode, askAgent, askLensId, askModelProblem, checkQuestion, resolveAskAgent } from "./ask.js";
import { codeindex, indexExists, loadCache, loadManifest, runFind } from "./engine.js";
import { explainContext, explainRequest } from "./explain.js";
import { modId } from "./model/ids.js";
import type { ViewModel, ViewNode } from "./model/types.js";
import { INDEX_DIR_NAME, VIEW_DIR, viewPaths } from "./paths.js";
import { type FreshView, freshView, indexStaleness, type StaleState, writeView } from "./refresh.js";
import { renderHtml, viewerTemplatePath } from "./render.js";
import { nodeCard, similarIds } from "./show.js";

export const SERVE_PORT = 4178;
export const SERVE_HOST = "127.0.0.1";
/** Agent-file changes are coalesced over this window before re-assembling. */
export const SERVE_DEBOUNCE_MS = 150;
/** SSE heartbeat (comment line), so proxies and browsers keep the stream open. */
export const HEARTBEAT_MS = 15_000;
/** File watchers can drop events (FSEvents right after a watch starts, network drives): the agent files are also polled. */
export const AGENT_POLL_MS = 1000;
/** Source changes are coalesced over this window before re-checking the index. */
const SOURCE_DEBOUNCE_MS = 1000;
/** Fallback poll of the index freshness when source directories cannot be watched. */
const SOURCE_POLL_MS = 30_000;
/** Most source directories watched one by one (platforms without recursive watch). */
const WATCH_DIRS_MAX = 2000;
const SSE_CLIENTS_MAX = 32;
const BODY_MAX = 16 * 1024;
const QUERY_MAX = 300;
const SEARCH_NODES = 25;
const SEARCH_MODULES = 8;
const CALLGRAPH_NODES = 200;
const CALLGRAPH_EDGES = 400;

/** Files under `.ultraview/` that never trigger a re-assembly (outputs, logs). */
const IGNORED_VIEW_FILES = new Set(["index.html", "ask.log", ".gitignore"]);
/** Agent-authored subdirectories of `.ultraview/`. */
const AGENT_DIRS = ["flows", "lenses", "changes"];
/** Never source: a change under these is not a reason to call the index stale. */
const NOT_SOURCE = [VIEW_DIR, INDEX_DIR_NAME, ".git", "node_modules"];

export interface ServeOptions {
  repo: string;
  /** Default SERVE_PORT; 0 picks a free port. */
  port?: number;
  /** Default SERVE_HOST. A non-loopback host needs `hostExplicit`. */
  host?: string;
  /** The host was asked for explicitly (`--host`): a non-loopback bind is allowed. */
  hostExplicit?: boolean;
  /** Default `auto`. */
  ask?: AskMode;
  /** The model the agent runs for asks (claude `--model`, codex `-m`); its default when absent. */
  askModel?: string;
  askTimeoutMs?: number;
  /** Environment for the agent lookup (PATH) and the agent's own minimal env. Default process.env. */
  env?: NodeJS.ProcessEnv;
  debounceMs?: number;
  heartbeatMs?: number;
  /** Safety-net poll of the agent files' sizes and mtimes, for events a watcher drops. Default AGENT_POLL_MS. */
  pollMs?: number;
  /** Viewer template (default: the packaged viewer). */
  template?: string;
  /** Non-fatal problems (a failed re-assembly, a watcher that could not start). */
  onWarning?: (message: string) => void;
}

export type { StaleState } from "./refresh.js";

export interface ServeHandle {
  url: string;
  host: string;
  port: number;
  repo: string;
  /** The agent the Ask bridge runs, when enabled. */
  ask?: AskAgent;
  /** The model it runs, when `askModel` was given. */
  askModel?: string;
  /** Re-assemble now; true when the view changed (and `view` was pushed). */
  refresh: () => boolean;
  close: () => Promise<void>;
  /** Resolves once the server is closed. */
  closed: Promise<void>;
}

/** Loopback names and addresses. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The hostname part of a Host header (`[::1]:4178` → `::1`), lowercase. */
function hostnameOf(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") === -1 ? undefined : h.indexOf("]"));
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/** Whether a request's Host header is one this server answers (DNS-rebinding guard). */
export function allowedHostHeader(header: string | undefined, boundHost: string): boolean {
  if (!header) return false;
  const name = hostnameOf(header);
  if (!name) return false;
  return isLoopbackHost(name) || isIP(name) !== 0 || name === boundHost.replace(/^\[|\]$/g, "").toLowerCase();
}

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, head = false, extra: Record<string, string> = {}): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": String(buf.length), ...extra });
  res.end(head ? undefined : buf);
}

function sendJson(res: ServerResponse, status: number, value: unknown, head = false): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value), head);
}

function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on("end", () => done(over ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => done(undefined));
  });
}

interface LiveState extends FreshView {
  version: number;
}

interface SymbolGraphCache {
  key: string;
  graph: ReturnType<typeof codeindex.buildSymbolGraph>;
}

const KIND_RANK: Record<string, number> = { cap: 0, sys: 1, route: 2, screen: 3, entity: 4, job: 5, ext: 6, infra: 7, mod: 8, sym: 9, file: 10 };

/** Nodes whose label or id contains `q`, best first. */
export function searchNodes(view: ViewModel, q: string, n = SEARCH_NODES): { id: string; kind: string; label: string; parent?: string; at?: string }[] {
  const needle = q.toLowerCase();
  const scored: { node: ViewNode; s: number }[] = [];
  for (const node of view.nodes) {
    const label = node.label.toLowerCase();
    const id = node.id.toLowerCase();
    const s = label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : id.includes(needle) ? 3 : -1;
    if (s >= 0) scored.push({ node, s });
  }
  return scored
    .sort(
      (a, b) =>
        a.s - b.s ||
        (KIND_RANK[a.node.kind] ?? 99) - (KIND_RANK[b.node.kind] ?? 99) ||
        a.node.id.length - b.node.id.length ||
        (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
    )
    .slice(0, n)
    .map(({ node }) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.parent ? { parent: node.parent } : {}),
      ...(node.at ? { at: node.at } : {}),
    }));
}

export async function startServe(opts: ServeOptions): Promise<ServeHandle> {
  const repo = resolve(opts.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`repo not found: ${repo}`);
  const paths = viewPaths(repo);
  if (!indexExists(paths.index)) throw new Error("no ultraindex index: run `ultraview build` first");
  const host = opts.host ?? SERVE_HOST;
  if (!isLoopbackHost(host) && !opts.hostExplicit)
    throw new Error(`refusing to bind ${host}: not a loopback address (pass --host ${host} explicitly to serve the map beyond this machine)`);
  const loopbackOnly = isLoopbackHost(host);
  const env = opts.env ?? process.env;
  const warn = opts.onWarning ?? (() => {});
  const debounceMs = opts.debounceMs ?? SERVE_DEBOUNCE_MS;
  const askModelError = opts.askModel !== undefined ? askModelProblem(opts.askModel) : undefined;
  if (askModelError) throw new Error(askModelError);
  const askModel = opts.askModel;
  const agent = resolveAskAgent(opts.ask ?? "auto", env.PATH ?? env.Path);
  const template = readFileSync(opts.template ?? viewerTemplatePath(), "utf8");

  // --- the live view (src/refresh.ts, the same re-assembly as `render`) -------------
  let state: LiveState = { ...freshView(repo), version: 1 };
  writeView(paths.view, state.text);
  let html: { version: number; text: string } | undefined;

  // --- SSE -------------------------------------------------------------------
  const clients = new Set<ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  const refresh = (): boolean => {
    signature = agentSignature();
    let next: FreshView;
    try {
      next = freshView(repo);
    } catch (e) {
      warn(`could not re-assemble the view: ${(e as Error).message}`);
      return false;
    }
    if (next.text === state.text) return false;
    state = { ...next, version: state.version + 1 };
    try {
      writeView(paths.view, state.text);
    } catch (e) {
      warn(`could not write ${paths.view}: ${(e as Error).message}`);
    }
    broadcast("view", { version: state.version, bytes: Buffer.byteLength(state.text) });
    return true;
  };

  // Trailing debounce, capped so a steady stream of writes still lands.
  let viewTimer: NodeJS.Timeout | undefined;
  let firstPending = 0;
  const scheduleRefresh = () => {
    const now = Date.now();
    if (!viewTimer) firstPending = now;
    if (viewTimer) clearTimeout(viewTimer);
    const wait = Math.max(0, Math.min(debounceMs, firstPending + debounceMs * 6 - now));
    viewTimer = setTimeout(() => {
      viewTimer = undefined;
      refresh();
    }, wait);
  };

  // A cheap signature of what the view is assembled from (names, sizes, mtimes):
  // when it moves without a watcher event, re-assemble anyway.
  const agentSignature = (): string => {
    const parts: string[] = [];
    const stamp = (abs: string, name: string) => {
      try {
        const st = statSync(abs);
        parts.push(`${name}:${st.size}:${st.mtimeMs}`);
      } catch {
        // absent
      }
    };
    for (const f of ["model.json", "facts.json", "timeline.jsonl"]) stamp(join(paths.dir, f), f);
    for (const d of AGENT_DIRS) {
      const abs = join(paths.dir, d);
      let names: string[] = [];
      try {
        names = readdirSync(abs).sort();
      } catch {
        continue;
      }
      for (const n of names) stamp(join(abs, n), `${d}/${n}`);
    }
    for (const f of ["graph.json", "manifest.json"]) stamp(join(paths.index, f), `index/${f}`);
    return parts.join("\n");
  };
  let signature = agentSignature();
  const agentPoll = setInterval(() => {
    const next = agentSignature();
    if (next === signature) return;
    signature = next;
    scheduleRefresh();
  }, opts.pollMs ?? AGENT_POLL_MS);
  agentPoll.unref();

  // --- index freshness (source changes never rebuild) --------------------------
  let stale: StaleState = { index: false, changed: 0, added: 0, removed: 0, files: [] };
  const checkIndex = () => {
    let next: StaleState;
    try {
      next = indexStaleness(repo);
    } catch (e) {
      warn(`could not check the index: ${(e as Error).message}`);
      return;
    }
    if (JSON.stringify(next) === JSON.stringify(stale)) return;
    stale = next;
    broadcast("stale", stale);
  };
  checkIndex();
  let sourceTimer: NodeJS.Timeout | undefined;
  const scheduleCheck = () => {
    if (sourceTimer) clearTimeout(sourceTimer);
    sourceTimer = setTimeout(() => {
      sourceTimer = undefined;
      checkIndex();
    }, SOURCE_DEBOUNCE_MS);
  };

  // --- watchers ----------------------------------------------------------------
  const watchers = new Map<string, FSWatcher>();
  const watchDir = (abs: string, recursive: boolean, on: (file: string | null) => void): boolean => {
    if (watchers.has(abs)) return true;
    try {
      const w = watch(abs, { recursive, persistent: false }, (_type, file) => on(file === null ? null : String(file)));
      w.on("error", () => {
        w.close();
        watchers.delete(abs);
      });
      watchers.set(abs, w);
      return true;
    } catch {
      return false;
    }
  };
  const onViewDirEvent = (file: string | null) => {
    if (file !== null) {
      const name = file.split(/[\\/]/).pop()!;
      if (IGNORED_VIEW_FILES.has(name) || name.endsWith(".tmp")) return;
      if (AGENT_DIRS.includes(name)) {
        const sub = join(paths.dir, name);
        if (existsSync(sub)) watchDir(sub, false, onViewDirEvent);
      }
      if (name === "view.json") {
        let disk: string | undefined;
        try {
          disk = readFileSync(paths.view, "utf8");
        } catch {
          disk = undefined;
        }
        if (disk === state.text) return; // our own write
      }
    }
    scheduleRefresh();
  };
  if (!watchDir(paths.dir, false, onViewDirEvent)) warn(`cannot watch ${paths.dir}: live updates are off`);
  for (const d of AGENT_DIRS) if (existsSync(join(paths.dir, d))) watchDir(join(paths.dir, d), false, onViewDirEvent);
  watchDir(paths.index, false, () => {
    scheduleRefresh();
    scheduleCheck();
  });

  const isSource = (rel: string) => !NOT_SOURCE.some((d) => rel === d || rel.startsWith(`${d}/`) || rel.startsWith(`${d}${sep}`));
  let poll: NodeJS.Timeout | undefined;
  const recursiveOk = process.platform === "darwin" || process.platform === "win32";
  const watchedRecursively =
    recursiveOk &&
    watchDir(repo, true, (file) => {
      if (file === null || isSource(file.split(sep).join("/"))) scheduleCheck();
    });
  if (!watchedRecursively) {
    // One watch per directory holding indexed files (never node_modules & co).
    const dirs = new Set<string>([repo]);
    for (const f of state.loaded.inputs.graph.files) dirs.add(dirname(join(repo, f.rel)));
    if (dirs.size <= WATCH_DIRS_MAX) {
      for (const d of [...dirs].sort())
        watchDir(d, false, (file) => {
          if (file === null) return scheduleCheck();
          const rel = relative(repo, join(d, file)).split(sep).join("/");
          if (isSource(rel)) scheduleCheck();
        });
    } else {
      poll = setInterval(checkIndex, SOURCE_POLL_MS);
      poll.unref();
    }
  }

  // --- the symbol graph, on demand -----------------------------------------------
  let symCache: SymbolGraphCache | undefined;
  const symbolGraph = () => {
    const graphFile = join(paths.index, "graph.json");
    const key = existsSync(graphFile) ? String(statSync(graphFile).mtimeMs) : "none";
    if (symCache?.key === key) return symCache.graph;
    const scan = loadManifest(paths.index)?.scan;
    const s = codeindex.scanRepo(repo, {
      include: scan?.include,
      exclude: scan?.exclude,
      maxBytes: scan?.maxBytes,
      maxFiles: scan?.maxFiles,
      ...(scan?.gitignore === false ? { gitignore: false } : {}),
      out: paths.index,
      cache: loadCache(paths.index),
    });
    const graph = codeindex.buildSymbolGraph(s, codeindex.computeImportPairs(s));
    symCache = { key, graph };
    return graph;
  };

  // --- the Ask bridge --------------------------------------------------------------
  let asking: { id: string; question: string; child?: ChildProcess } | undefined;
  const startAsk = (question: string) => {
    const id = askLensId(repo, question);
    const current: { id: string; question: string; child?: ChildProcess } = { id, question };
    asking = current;
    const who = agent!.name;
    void askAgent(
      {
        repo,
        question,
        agent: agent!,
        ...(askModel ? { model: askModel } : {}),
        env,
        timeoutMs: opts.askTimeoutMs,
        onProgress: (stage, detail) => broadcast("ask-progress", { id, question, agent: who, stage, ...detail }),
        onChild: (child) => {
          current.child = child;
        },
      },
      id,
    ).then((o) => {
      if (asking === current) asking = undefined;
      if (o.ok) {
        refresh();
        broadcast("ask-done", { id, question, agent: who, file: o.file, replaced: o.replaced, sources: o.sources });
      } else broadcast("ask-error", { id, question, agent: who, error: o.error, ...(o.problems ? { problems: o.problems } : {}) });
    });
    return id;
  };

  // --- routes ------------------------------------------------------------------------
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!allowedHostHeader(req.headers.host, host)) return send(res, 403, "text/plain; charset=utf-8", "forbidden host\n");
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const head = method === "HEAD";
    const getOnly = () => {
      if (method === "GET" || head) return true;
      send(res, 405, "text/plain; charset=utf-8", "method not allowed\n", false, { Allow: "GET, HEAD" });
      return false;
    };
    const param = (name: string): string | undefined => {
      const v = url.searchParams.get(name);
      return v === null ? undefined : v.slice(0, QUERY_MAX);
    };

    switch (url.pathname) {
      case "/":
      case "/index.html": {
        if (!getOnly()) return;
        if (html?.version !== state.version) html = { version: state.version, text: renderHtml(template, state.view, { root: repo }) };
        return send(res, 200, "text/html; charset=utf-8", html.text, head);
      }
      case "/view.json":
        if (!getOnly()) return;
        return send(res, 200, "application/json; charset=utf-8", state.text, head);
      case "/events": {
        if (!getOnly()) return;
        if (clients.size >= SSE_CLIENTS_MAX) return send(res, 503, "text/plain; charset=utf-8", "too many event streams\n");
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write(
          `retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ version: state.version, stale, ask: agent ? { agent: agent.name, busy: !!asking, ...(askModel ? { model: askModel } : {}) } : null })}\n\n`,
        );
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      case "/api/node": {
        if (!getOnly()) return;
        const id = param("id");
        if (!id) return sendJson(res, 400, { error: "missing ?id=" }, head);
        const card = nodeCard({ view: state.view, byId: state.byId, fileSystems: state.assembled.fileSystems }, id);
        if (!card) return sendJson(res, 404, { error: `unknown node id: ${id}`, suggestions: similarIds(state.view, id) }, head);
        return sendJson(res, 200, card, head);
      }
      case "/api/search": {
        if (!getOnly()) return;
        const q = param("q")?.trim();
        if (!q) return sendJson(res, 400, { error: "missing ?q=" }, head);
        const modules = (runFind(paths.index, q, SEARCH_MODULES) ?? [])
          .filter((r) => r.score > 0)
          .map((r) => {
            const whole = modId(r.slug);
            const ids = [whole, ...state.view.nodes.filter((n) => n.slice?.of === whole).map((n) => n.id)].filter((x) => state.byId.has(x));
            return { slug: r.slug, ids, score: r.score, matched: r.matched, files: r.files.slice(0, 10) };
          });
        return sendJson(res, 200, { q, nodes: searchNodes(state.view, q), modules }, head);
      }
      case "/api/callgraph": {
        if (!getOnly()) return;
        const raw = param("sym");
        if (!raw) return sendJson(res, 400, { error: "missing ?sym=" }, head);
        const depth = Number(param("depth") ?? "1");
        if (!Number.isInteger(depth) || depth < 1 || depth > 3) return sendJson(res, 400, { error: "depth must be 1, 2 or 3" }, head);
        const dir = param("dir") ?? "both";
        if (dir !== "in" && dir !== "out" && dir !== "both") return sendJson(res, 400, { error: "dir must be in, out or both" }, head);
        const sym = raw.startsWith("sym:") ? raw.slice(4) : raw;
        let n: ReturnType<typeof codeindex.neighborhood>;
        try {
          n = codeindex.neighborhood(symbolGraph(), sym, { depth, direction: dir });
        } catch (e) {
          return sendJson(res, 500, { error: `callgraph unavailable: ${(e as Error).message}` }, head);
        }
        if (!n.root.length) return sendJson(res, 404, { error: `unknown symbol: ${raw}` }, head);
        const viewId = (id: string) => `sym:${id}`;
        const nodes = n.nodes.slice(0, CALLGRAPH_NODES).map((x) => ({
          id: viewId(x.id),
          name: x.name,
          kind: x.kind,
          file: x.file,
          line: x.line,
          depth: x.depth,
          inView: state.byId.has(viewId(x.id)),
        }));
        const kept = new Set(nodes.map((x) => x.id));
        const edges = n.edges
          .filter((e) => kept.has(viewId(e.from)) && kept.has(viewId(e.to)))
          .slice(0, CALLGRAPH_EDGES)
          .map((e) => ({ from: viewId(e.from), to: viewId(e.to), kind: e.kind, weight: e.weight }));
        const truncated = !!n.truncated || n.nodes.length > nodes.length || n.edges.length > edges.length;
        return sendJson(
          res,
          200,
          { sym: raw, depth, dir, root: n.root.map((r) => viewId(r.id)), nodes, edges, ...(truncated ? { truncated: true } : {}) },
          head,
        );
      }
      case "/api/explain": {
        if (method !== "POST") return send(res, 405, "text/plain; charset=utf-8", "method not allowed\n", false, { Allow: "POST" });
        if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return sendJson(res, 415, { error: "send application/json" });
        const body = await readBody(req, BODY_MAX);
        if (body === undefined) return sendJson(res, 413, { error: `body over ${BODY_MAX} bytes` });
        const r = explainRequest(explainContext(state), body, (id) => similarIds(state.view, id));
        return sendJson(res, r.status, r.value);
      }
      case "/api/ask": {
        if (!agent) return sendJson(res, 404, { error: "the Ask bridge is off (no agent CLI found, or --ask none)" });
        if (method !== "POST") return send(res, 405, "text/plain; charset=utf-8", "method not allowed\n", false, { Allow: "POST" });
        if (!loopbackOnly && !isLoopbackHost(req.socket.remoteAddress ?? "")) return sendJson(res, 403, { error: "asking is only allowed from this machine" });
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: "cross-origin request refused" });
        const site = req.headers["sec-fetch-site"];
        if (site !== undefined && site !== "same-origin" && site !== "none") return sendJson(res, 403, { error: "cross-site request refused" });
        if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return sendJson(res, 415, { error: "send application/json" });
        const body = await readBody(req, BODY_MAX);
        if (body === undefined) return sendJson(res, 413, { error: `body over ${BODY_MAX} bytes` });
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: "body is not JSON" });
        }
        const q = checkQuestion((parsed as { question?: unknown } | null)?.question);
        if ("error" in q) return sendJson(res, 400, { error: q.error });
        if (asking) return sendJson(res, 409, { error: "an ask is already running", id: asking.id });
        const id = startAsk(q.question);
        return sendJson(res, 202, { id, question: q.question, agent: agent.name });
      }
      default:
        return send(res, 404, "text/plain; charset=utf-8", "not found\n", head);
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message });
      else res.end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      fail(e.code === "EADDRINUSE" ? new Error(`port ${opts.port ?? SERVE_PORT} is in use on ${host}: pass --port <n>`) : e);
    };
    server.once("error", onError);
    server.listen(opts.port ?? SERVE_PORT, host, () => {
      server.off("error", onError);
      ok();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? SERVE_PORT);
  const urlHost = host.includes(":") ? `[${host}]` : host;

  let closing: Promise<void> | undefined;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((ok) => {
    markClosed = ok;
  });
  const close = () => {
    closing ??= new Promise<void>((ok) => {
      clearInterval(heartbeat);
      if (poll) clearInterval(poll);
      clearInterval(agentPoll);
      if (viewTimer) clearTimeout(viewTimer);
      if (sourceTimer) clearTimeout(sourceTimer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      asking?.child?.kill("SIGTERM");
      for (const c of clients) c.end();
      clients.clear();
      server.close(() => {
        markClosed();
        ok();
      });
      server.closeAllConnections?.();
    });
    return closing;
  };

  return { url: `http://${urlHost}:${port}/`, host, port, repo, ...(agent ? { ask: agent } : {}), ...(askModel ? { askModel } : {}), refresh, close, closed };
}
