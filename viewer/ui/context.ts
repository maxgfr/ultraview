// The app's shared state, handed down through one Preact context.

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ChangeView, Insight } from "../lib/changes.js";
import type { Index } from "../lib/data.js";
import type { Editor, RepoRef } from "../lib/editor.js";
import type { Lang } from "../lib/i18n.js";
import type { MapState, ViewerAudience } from "../lib/levels.js";
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
}

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const api = useContext(AppContext);
  if (!api) throw new Error("useApp outside <App>");
  return api;
}
