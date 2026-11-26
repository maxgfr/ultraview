// The app's shared state, handed down through one Preact context.

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ChangeView, Insight } from "../lib/changes.js";
import type { ChatContext, ChatState, TurnAnswer, ViewConversation } from "../lib/chat.js";
import type { Index } from "../lib/data.js";
import type { Editor, RepoRef } from "../lib/editor.js";
import type { Lang } from "../lib/i18n.js";
import type { MapState, ViewerAudience } from "../lib/levels.js";
import type { LiveState } from "../lib/live.js";
import type { ViewName } from "../lib/route.js";
import type { SearchDoc } from "../lib/search.js";

export type Theme = "light" | "dark";

export interface Settings {
  /** Undefined = follow the system. */
  theme?: Theme;
  lang: Lang;
  editor: Editor;
}

export interface UiState {
  view: ViewName;
  map: MapState;
  /** Selected node (view-model id). */
  selected?: string;
  lens?: string;
  flow?: string;
  /** 0-based flow step. */
  step: number;
  change?: string;
  audience: ViewerAudience;
  /** The accessible list instead of the drawing. */
  listMode: boolean;
  panelOpen: boolean;
  searchOpen: boolean;
  /** Active tour stop (0-based). */
  tour?: number;
  /** Nodes lit on the map, the rest dimmed. */
  spotlight?: { ids: string[]; label: string };
  /** A change view overlaid on the map. */
  overlay?: string;
  /** Ask the map to centre on a node (nonce re-triggers). */
  center?: { id: string; nonce: number };
  /** The chat panel is open. */
  chatOpen: boolean;
  /** Its conversation (`#chat=`), once it has an id; kept while the panel is closed. */
  chat?: string;
  /** Move the focus into the panel's composer (nonce re-triggers). */
  chatFocus?: number;
}

/** What the chat panel can ask: nothing on a static page, instant answers only without an agent, or the agent too. */
export type ChatCan = "static" | "noagent" | "busy" | "ready";

export interface ChatApi {
  state: ChatState;
  can: ChatCan;
  /** The conversations `render` embedded in this page (read-only). */
  embedded: readonly ViewConversation[];
  /** Open the panel: on a conversation (null: a new one), about something ("Ask about this": a node also gets its instant answer). */
  open: (opts?: { thread?: string | null; context?: ChatContext }) => void;
  close: () => void;
  /** Ask the agent, in the open conversation (or a new one). */
  send: (question: string, opts?: { context?: ChatContext; from?: string }) => void;
  setDraft: (context?: ChatContext) => void;
  dismiss: (key: string) => void;
  /** Re-read the conversations list. */
  refreshList: () => void;
  /** Light an answer's nodes on the map; `go` switches to the map, selects and centres its focus. */
  show: (answer: TurnAnswer, label: string, go?: boolean) => void;
  /** Open a node's card in the side panel (a citation was clicked). */
  openNode: (id: string) => void;
}

export type NavMode = "push" | "replace" | "none";

export interface AppApi {
  ix: Index;
  version: number;
  repo: RepoRef;
  state: UiState;
  settings: Settings;
  narrow: boolean;
  docs: SearchDoc[];
  changes: ChangeView[];
  insights: Insight[];
  update: (patch: Partial<UiState> | ((s: UiState) => Partial<UiState>), nav?: NavMode) => void;
  setSettings: (patch: Partial<Settings>) => void;
  toast: (message: string) => void;
  copy: (text: string, message: string) => void;
  select: (id: string | undefined) => void;
  /** Show a node on the map at a level that draws it, selected and centred. */
  reveal: (id: string, spotlight?: { ids: string[]; label: string }, nav?: NavMode) => void;
  /** Drill into a map node (or expand a file in place). */
  drill: (id: string) => void;
  /** What a serving `ultraview serve` reported (stale index, Ask bridge); `connected` false on a static page. */
  live: LiveState;
  dismissLive: (what: "stale" | "error") => void;
  chat: ChatApi;
}

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const api = useContext(AppContext);
  if (!api) throw new Error("useApp outside <App>");
  return api;
}
