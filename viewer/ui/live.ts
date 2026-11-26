// Live data for `ultraview serve`: when the page is served over http(s) and
// the server streams `/events`, a `view` message means view.json changed —
// fetch it and hand it over; `hello`, `stale` and the `ask-*` messages go to
// the live state (lib/live.ts) as they come. On file:// (or with no event
// stream) this does nothing at all. `postAsk` sends a question to the Ask
// bridge (`POST /api/ask`, same origin, JSON).

import type { LiveEvent } from "../lib/live.js";

const SERVER_EVENTS = ["hello", "stale", "ask-progress", "ask-done", "ask-error"] as const;

/** Whether this page can talk to a serving ultraview at all. */
export function canBeLive(): boolean {
  return typeof location !== "undefined" && /^https?:$/.test(location.protocol) && typeof EventSource !== "undefined";
}

export function startLive(onView: (view: any) => void, onEvent: (e: LiveEvent) => void = () => {}): () => void {
  if (!canBeLive()) return () => {};
  let closed = false;
  let opened = false;
  let es: EventSource;
  try {
    es = new EventSource("/events");
  } catch {
    return () => {};
  }
  es.onopen = () => {
    opened = true;
  };
  es.onerror = () => {
    // Never connected: no event stream here (a plain static server). Stop quietly.
    if (!opened) es.close();
  };
  es.addEventListener("view", () => {
    fetch("/view.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((v) => {
        if (!closed && v && typeof v === "object" && Array.isArray(v.nodes)) onView(v);
      })
      .catch(() => {});
  });
  for (const type of SERVER_EVENTS) {
    es.addEventListener(type, (m) => {
      if (closed) return;
      let data: unknown;
      try {
        data = JSON.parse((m as MessageEvent<string>).data);
      } catch {
        return;
      }
      onEvent({ type, data });
    });
  }
  return () => {
    closed = true;
    es.close();
  };
}

export type AskReply = { ok: true; id: string; question: string; agent?: string } | { ok: false; status: number; error: string; id?: string };

/** Send a question to the Ask bridge. Never throws: a network failure is status 0. */
export async function postAsk(question: string): Promise<AskReply> {
  let res: Response;
  try {
    res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message || "network error" };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const id = typeof body.id === "string" ? body.id : undefined;
  if (res.status === 202 && id)
    return {
      ok: true,
      id,
      question: typeof body.question === "string" ? body.question : question,
      ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
    };
  return { ok: false, status: res.status, error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`, ...(id ? { id } : {}) };
}
