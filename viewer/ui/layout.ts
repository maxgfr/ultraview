// Runs ELK. The elkjs worker script ships inside the page, deflated and
// base64-encoded (<script type="application/octet-stream" id="ultraview-elk">);
// it is inflated on first use and started as a Web Worker from a Blob URL —
// no external file, works offline. Where a Blob worker cannot start (some
// browsers on file://) the same script runs on the main thread through its
// built-in fake worker. Layouts are cached per scene key and data version.

import { inflateSync, strFromU8 } from "fflate";
import { type ElkNode, fromElk, gridLayout, type Layout, toElkGraph } from "../lib/elk.js";
import type { Scene } from "../lib/levels.js";

interface Port {
  postMessage(msg: unknown): void;
  onmessage: ((e: { data: any }) => void) | null;
}

let source: string | undefined;
function elkSource(): string {
  if (source !== undefined) return source;
  const el = document.getElementById("ultraview-elk");
  const b64 = el?.textContent?.trim() ?? "";
  if (!b64) throw new Error("layout engine missing from the page");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  source = strFromU8(inflateSync(bytes));
  return source;
}

function mainThreadPort(): Port {
  const mod: { exports: any } = { exports: {} };
  // The elkjs worker script exports its fake worker when it finds `module`.
  new Function("module", "exports", elkSource())(mod, mod.exports);
  const FakeWorker = mod.exports.Worker ?? mod.exports.default;
  return new FakeWorker() as Port;
}

let nextId = 1;
interface Job {
  id: number;
  msg: { id: number; cmd: string; graph: ElkNode };
  resolve: (v: ElkNode) => void;
  reject: (e: unknown) => void;
}
/** Jobs sent and not answered yet, oldest first (the worker runs them in order). */
const pending = new Map<number, Job>();
let port: Port | undefined;
let worker: Worker | undefined;
let workerUrl: string | undefined;

const REGISTER = { id: 0, cmd: "register", algorithms: ["layered"] };

function wire(p: Port): void {
  p.onmessage = (e) => {
    const { id, data, error } = e.data ?? {};
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) job.reject(error);
    else job.resolve(data);
  };
}

function fallBack(): void {
  worker = undefined;
  port = mainThreadPort();
  wire(port);
  port.postMessage(REGISTER);
  for (const job of pending.values()) port.postMessage(job.msg);
}

function startWorker(): void {
  workerUrl ??= URL.createObjectURL(new Blob([elkSource()], { type: "text/javascript" }));
  const w = new Worker(workerUrl);
  w.addEventListener("error", (ev) => {
    ev.preventDefault?.();
    if (worker === w) {
      w.terminate();
      fallBack();
    }
  });
  worker = w;
  port = w as unknown as Port;
  wire(port);
  port.postMessage(REGISTER);
}

function ensurePort(): Port {
  if (port) return port;
  try {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL?.createObjectURL !== "function") throw new Error("no workers");
    startWorker();
  } catch {
    fallBack();
  }
  return port!;
}

/** A layout nobody waits for any more: drop it; a worker busy with it is replaced, so the next map is not stuck behind it. */
function cancel(job: Job): void {
  if (!pending.delete(job.id)) return;
  job.reject(CANCELLED);
  if (worker) {
    worker.terminate();
    worker = undefined;
    port = undefined;
    const rest = [...pending.values()];
    const p = ensurePort();
    for (const j of rest) p.postMessage(j.msg);
  }
}

const CANCELLED = new Error("layout cancelled");

function run(graph: ElkNode): { promise: Promise<ElkNode>; job: Job } {
  const p = ensurePort();
  const id = nextId++;
  const msg = { id, cmd: "layout", graph, layoutOptions: {}, options: {} };
  let job!: Job;
  const promise = new Promise<ElkNode>((resolve, reject) => {
    job = { id, msg, resolve, reject };
  });
  pending.set(id, job);
  p.postMessage(msg);
  return { promise, job };
}

const cache = new Map<string, Layout>();
const inflight = new Map<string, { promise: Promise<Layout>; job?: Job; wanted: number }>();

export function cachedLayout(version: number, scene: Scene): Layout | undefined {
  return cache.get(`${version}\n${scene.key}`);
}

/**
 * Lay a scene out (cached). Resolves with a grid layout when ELK fails;
 * rejects only when every caller released it before it finished.
 */
export function layoutScene(version: number, scene: Scene): Promise<Layout> {
  const key = `${version}\n${scene.key}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) {
    running.wanted++;
    return running.promise;
  }
  const started = scene.nodes.length ? run(toElkGraph(scene, "RIGHT", scene.key === "erd" ? 120 : 64)) : undefined;
  const raw = started ? started.promise : Promise.resolve({ id: "__root", width: 0, height: 0 } as ElkNode);
  const promise = raw.then(
    (res) => fromElk(scene.key, res),
    (e) => {
      if (e === CANCELLED) throw e;
      return gridLayout(scene);
    },
  );
  const entry = { promise, ...(started ? { job: started.job } : {}), wanted: 1 };
  inflight.set(key, entry);
  promise.then(
    (layout) => {
      cache.set(key, layout);
      inflight.delete(key);
    },
    () => inflight.delete(key),
  );
  return promise;
}

/** The caller no longer needs this layout (the map moved on). */
export function releaseLayout(version: number, scene: Scene): void {
  const entry = inflight.get(`${version}\n${scene.key}`);
  if (!entry || --entry.wanted > 0) return;
  if (entry.job) cancel(entry.job);
}

/** Drop layouts of older data versions (live reload). */
export function forgetLayoutsBefore(version: number): void {
  for (const k of cache.keys()) if (Number(k.split("\n")[0]) < version) cache.delete(k);
}
