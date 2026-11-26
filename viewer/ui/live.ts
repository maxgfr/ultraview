// Live data for `ultraview serve`: when the page is served over http(s) and
// the server streams `/events`, a `view` message means view.json changed —
// fetch it and hand it over; `hello`, `stale` and the `ask-*` messages go to
// the live state (lib/live.ts) as they come; `chat {id}` (a conversation file
// changed) goes to the chat panel. On file:// (or with no event stream) this
// does nothing at all.

import type { LiveEvent } from "../lib/live.js";

const SERVER_EVENTS = ["hello", "stale", "ask-progress", "ask-done", "ask-error"] as const;

/** Whether this page can talk to a serving ultraview at all. */
export function canBeLive(): boolean {
  return typeof location !== "undefined" && /^https?:$/.test(location.protocol) && typeof EventSource !== "undefined";
}

export function startLive(onView: (view: any) => void, onEvent: (e: LiveEvent) => void = () => {}, onChat: (id: string) => void = () => {}): () => void {
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
  es.addEventListener("chat", (m) => {
    if (closed) return;
    try {
      const d: unknown = JSON.parse((m as MessageEvent<string>).data);
      if (d && typeof d === "object" && typeof (d as { id?: unknown }).id === "string") onChat((d as { id: string }).id);
    } catch {
      // not JSON: ignored
    }
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
