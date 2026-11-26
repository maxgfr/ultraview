import { join } from "node:path";

// Where ultraview keeps its files inside the analyzed repository (docs/design.md §1).
// `.ultraindex/` belongs to ultraindex; `.ultraview/` is ours: the committed
// meaning (model, flows, lenses, timeline, changes) plus three gitignored
// generated files.

export const VIEW_DIR = ".ultraview";
export const INDEX_DIR_NAME = ".ultraindex";

/** The generated files `build` lists in `.ultraview/.gitignore`. */
export const GENERATED_FILES = ["facts.json", "view.json", "index.html"] as const;

export interface ViewPaths {
  repo: string;
  index: string;
  dir: string;
  facts: string;
  view: string;
  html: string;
  model: string;
  gitignore: string;
}

export function viewPaths(repo: string): ViewPaths {
  const dir = join(repo, VIEW_DIR);
  return {
    repo,
    index: join(repo, INDEX_DIR_NAME),
    dir,
    facts: join(dir, "facts.json"),
    view: join(dir, "view.json"),
    html: join(dir, "index.html"),
    model: join(dir, "model.json"),
    gitignore: join(dir, ".gitignore"),
  };
}
