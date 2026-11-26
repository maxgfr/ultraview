/*! ultraview viewer | MIT | https://github.com/maxgfr/ultraview
 *  Bundles Preact (MIT, https://preactjs.com) and fflate (MIT, https://github.com/101arrowz/fflate).
 *  The layout engine, elkjs (EPL-2.0, https://github.com/kieler/elkjs), is embedded separately: see NOTICE. */

// Entry point: read the data `ultraview render` embedded in the page and mount the app.

import { render } from "preact";
import type { ViewModel } from "../src/model/types.js";
import type { RepoRef } from "./lib/editor.js";
import "./styles.css";
import { App, NoData } from "./ui/App.js";

function readJson(id: string): any {
  const el = document.getElementById(id);
  if (!el?.textContent) return undefined;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return undefined;
  }
}

const view = readJson("ultraview-data") as ViewModel | null | undefined;
const env = (readJson("ultraview-env") ?? {}) as { root?: unknown };
const repo: RepoRef = typeof env.root === "string" ? { root: env.root } : {};
const root = document.getElementById("app")!;

if (view && typeof view === "object" && Array.isArray(view.nodes)) render(<App initial={view} repo={repo} />, root);
else render(<NoData />, root);
