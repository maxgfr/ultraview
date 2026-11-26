// The chat panel's network side, same origin as `ultraview serve`
// (docs/design.md §8.1): `POST /api/chat` read as an event stream (progress…,
// then turn or error; a refused request answers JSON before any stream),
// `GET /api/chat?id=`, `GET /api/chats` and `POST /api/explain`. Nothing here
// throws: a network failure is status 0.

import {
  type ChatContext,
  type ChatListItem,
  type ChatMode,
  type ChatStreamEvent,
  type FactsAnswer,
  readChatFrame,
  readChatList,
  readConversation,
  readExplain,
  sseReader,
  type ViewConversation,
} from "../lib/chat.js";

const POST = { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store" } as const;

async function errorOf(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") return (body as { error: string }).error;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

export interface ChatRequest {
  thread?: string;
  question: string;
  mode: ChatMode;
  context?: ChatContext;
}

/**
 * Ask one turn. `on` sees each event as it arrives; resolves with the status
 * of a refused request (0: unreachable) or 200 once the stream ended. A
 * stream that ends with neither a turn nor an error reports an error.
 */
export async function streamChat(req: ChatRequest, on: (e: ChatStreamEvent) => void): Promise<{ status: number; error?: string }> {
  let res: Response;
  try {
    res = await fetch("/api/chat", { ...POST, body: JSON.stringify(req) });
  } catch (e) {
    return { status: 0, error: (e as Error).message || "network error" };
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("text/event-stream") || !res.body)
    return { status: res.ok ? 502 : res.status, error: await errorOf(res) };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = sseReader();
  let ended = false;
  const feed = (frames: ReturnType<typeof sse.push>) => {
    for (const f of frames) {
      const e = readChatFrame(f);
      if (!e) continue;
      if (e.type !== "progress") ended = true;
      on(e);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(sse.push(decoder.decode(value, { stream: true })));
    }
    feed(sse.push(decoder.decode()));
    feed(sse.end());
  } catch (e) {
    if (!ended) on({ type: "error", message: (e as Error).message || "the stream broke" });
    return { status: 200 };
  }
  if (!ended) on({ type: "error", message: "" });
  return { status: 200 };
}

export async function fetchConversation(id: string): Promise<{ conversation?: ViewConversation; status: number; error?: string }> {
  try {
    const res = await fetch(`/api/chat?id=${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return { status: res.status, error: await errorOf(res) };
    const conversation = readConversation(await res.json());
    return conversation ? { conversation, status: 200 } : { status: 502, error: "not a conversation" };
  } catch (e) {
    return { status: 0, error: (e as Error).message || "network error" };
  }
}

export async function fetchChatList(): Promise<ChatListItem[] | undefined> {
  try {
    const res = await fetch("/api/chats", { credentials: "same-origin", cache: "no-store" });
    return res.ok ? readChatList(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}

export async function postExplain(node: string, mode: ChatMode, lang: string): Promise<{ facts?: FactsAnswer; status: number; error?: string }> {
  try {
    const res = await fetch("/api/explain", { ...POST, body: JSON.stringify({ node, mode, lang }) });
    if (!res.ok) return { status: res.status, error: await errorOf(res) };
    const facts = readExplain(await res.json(), node);
    return facts ? { facts, status: 200 } : { status: 502, error: "not an answer" };
  } catch (e) {
    return { status: 0, error: (e as Error).message || "network error" };
  }
}
