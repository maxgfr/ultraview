// Live data for `ultraview serve`: when the page is served over http(s) and
// the server streams `/events`, a `view` message means view.json changed —
// fetch it and hand it over. On file:// (or with no event stream) this does
// nothing at all.

export function startLive(onView: (view: any) => void): () => void {
  if (typeof location === "undefined" || !/^https?:$/.test(location.protocol) || typeof EventSource === "undefined") return () => {};
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
  return () => {
    closed = true;
    es.close();
  };
}
