// What `ultraview serve` tells a live page (docs/design.md §8.1), as one pure
// state: whether the index went stale since the map was built, whether the
// Ask bridge is on and busy, and how the question this page asked is doing.
// ui/live.ts feeds it the server's events (`hello`, `stale`, `ask-progress`,
// `ask-done`, `ask-error`) and the answers to `POST /api/ask`; the shell reads
// it to draw the stale banner and the Ask box. Every event is read
// defensively: a field of the wrong type is ignored, never trusted.

/** Longest question the server accepts. */
export const QUESTION_MAX = 500;

export interface StaleInfo {
  index: boolean;
  changed: number;
  added: number;
  removed: number;
  /** The first changed / added / removed paths (at most 20). */
  files: string[];
}

export type AskStage = "sending" | "started" | "running" | "validating";

export interface AskRun {
  /** The lens id the answer saves under, once the server named it. */
  id?: string;
  question: string;
  agent?: string;
  stage: AskStage;
  /** Bytes the agent printed so far. */
  bytes?: number;
  /** This page asked it (only then does it open the answer or show the error). */
  mine: boolean;
}

export interface LiveState {
  /** A `hello` arrived: the page is served live. Nothing live shows before. */
  connected: boolean;
  stale?: StaleInfo;
  /** The Ask bridge (`hello.ask`), null when it is off. */
  ask: { agent: string; busy: boolean } | null;
  run?: AskRun;
  /** The last ask of this page that failed. */
  error?: { question: string; error: string; problems: string[] };
  /** An answer of this page saved under this lens id, waiting to be opened once the data holds it. */
  opened?: { id: string; question: string };
  /** The stale counts the user dismissed the banner for (a new count shows it again). */
  dismissed?: string;
}

export const initialLive: LiveState = { connected: false, ask: null };

export type LiveEvent =
  | { type: "hello" | "stale" | "ask-progress" | "ask-done" | "ask-error"; data: unknown }
  | { type: "ask-sent"; question: string }
  | { type: "ask-accepted"; id: string; question: string; agent?: string }
  | { type: "ask-refused"; status: number; error: string; id?: string }
  | { type: "dismiss-stale" }
  | { type: "dismiss-error" }
  | { type: "opened" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** One `lens save` problem as a line: `{path, message}` (what serve sends) or a plain string. */
export function problemText(p: unknown): string | undefined {
  if (typeof p === "string") return p || undefined;
  if (!isObj(p) || typeof p.message !== "string") return undefined;
  return typeof p.path === "string" && p.path ? `${p.path}: ${p.message}` : p.message;
}

/** A `stale` payload (also `hello.stale`), or undefined when it is not one. */
export function readStale(v: unknown): StaleInfo | undefined {
  if (!isObj(v) || typeof v.index !== "boolean") return undefined;
  return {
    index: v.index,
    changed: count(v.changed),
    added: count(v.added),
    removed: count(v.removed),
    files: Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === "string").slice(0, 20) : [],
  };
}

/** Files changed, added or removed since the index was built. */
export function staleCount(s: StaleInfo): number {
  return s.changed + s.added + s.removed;
}

const staleKey = (s: StaleInfo) => `${s.changed}/${s.added}/${s.removed}`;

/** Whether the "code changed" banner shows: live, stale, and not dismissed for these counts. */
export function showStale(s: LiveState): boolean {
  return s.connected && !!s.stale?.index && s.dismissed !== staleKey(s.stale);
}

/** What the Ask box can do: off (no bridge, or not live), busy (an ask runs, this page's or another), or ready. */
export function askMode(s: LiveState): "off" | "busy" | "ready" {
  if (!s.connected || !s.ask) return "off";
  return s.ask.busy || s.run ? "busy" : "ready";
}

/** Whether a question can be sent as typed. */
export function questionOk(q: string): boolean {
  const t = q.trim();
  return t.length > 0 && t.length <= QUESTION_MAX;
}

const STAGES: readonly AskStage[] = ["started", "running", "validating"];

/** Whether an event about ask `id` / `question` is about the run this page follows. */
function sameRun(run: AskRun | undefined, id: string | undefined, question: string | undefined): boolean {
  if (!run) return false;
  if (run.id && id) return run.id === id;
  return run.question === question;
}

export function liveReducer(s: LiveState, e: LiveEvent): LiveState {
  switch (e.type) {
    case "hello": {
      if (!isObj(e.data)) return s;
      const a = e.data.ask;
      const ask = isObj(a) && typeof a.agent === "string" ? { agent: a.agent, busy: a.busy === true } : null;
      const stale = readStale(e.data.stale);
      // A reconnect: a run of ours the server no longer has is over.
      const run = ask?.busy ? s.run : undefined;
      const next: LiveState = { ...s, connected: true, ask };
      if (stale) next.stale = stale;
      if (run) next.run = run;
      else delete next.run;
      return next;
    }
    case "stale": {
      const stale = readStale(e.data);
      return stale ? { ...s, stale } : s;
    }
    case "ask-progress": {
      if (!isObj(e.data)) return s;
      const id = str(e.data.id);
      const question = str(e.data.question) ?? "";
      const raw = e.data.stage;
      const stage = STAGES.find((x) => x === raw) ?? "running";
      const agent = str(e.data.agent);
      const bytes = typeof e.data.bytes === "number" ? count(e.data.bytes) : undefined;
      const mine = sameRun(s.run, id, question) && !!s.run?.mine;
      const run: AskRun = { question, stage, mine, ...(id ? { id } : {}), ...(agent ? { agent } : {}), ...(bytes !== undefined ? { bytes } : {}) };
      return { ...s, run, ...(s.ask ? { ask: { ...s.ask, busy: true } } : {}) };
    }
    case "ask-done":
    case "ask-error": {
      if (!isObj(e.data)) return s;
      const id = str(e.data.id);
      const question = str(e.data.question) ?? "";
      const mine = sameRun(s.run, id, question) && !!s.run?.mine;
      const next: LiveState = { ...s, ...(s.ask ? { ask: { ...s.ask, busy: false } } : {}) };
      if (sameRun(s.run, id, question)) delete next.run;
      if (!mine) return next;
      if (e.type === "ask-done") {
        if (id) next.opened = { id, question };
        delete next.error;
      } else {
        const problems = Array.isArray(e.data.problems)
          ? e.data.problems
              .map(problemText)
              .filter((p): p is string => !!p)
              .slice(0, 20)
          : [];
        next.error = { question, error: str(e.data.error) ?? "", problems };
      }
      return next;
    }
    case "ask-sent": {
      const next: LiveState = { ...s, run: { question: e.question.trim(), stage: "sending", mine: true } };
      delete next.error;
      return next;
    }
    case "ask-accepted": {
      // The run may already have moved on (a progress event can beat the answer to the POST).
      const run = s.run?.mine ? s.run : { question: e.question, stage: "started" as const, mine: true };
      return { ...s, run: { ...run, id: e.id, ...(e.agent ? { agent: e.agent } : {}) } };
    }
    case "ask-refused": {
      const next: LiveState = { ...s, error: { question: s.run?.question ?? "", error: e.error, problems: [] } };
      if (s.run?.mine) delete next.run;
      // 409: another ask holds the bridge; its own events will free it.
      if (e.status === 409 && next.ask) next.ask = { ...next.ask, busy: true };
      return next;
    }
    case "dismiss-stale":
      return s.stale ? { ...s, dismissed: staleKey(s.stale) } : s;
    case "dismiss-error": {
      const next = { ...s };
      delete next.error;
      return next;
    }
    case "opened": {
      const next = { ...s };
      delete next.opened;
      return next;
    }
    default:
      return s;
  }
}
