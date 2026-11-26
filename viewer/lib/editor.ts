// "Open in editor" links for a citation: an editor URL scheme over the
// repository's absolute path (injected by `ultraview render`), or the file on
// the repository's remote when there is no local checkout to open.

export const EDITORS = ["vscode", "cursor", "zed", "idea", "github"] as const;
export type Editor = (typeof EDITORS)[number];

export interface RepoRef {
  /** Absolute path of the repository on this machine. */
  root?: string;
  /** Web URL of the repository (`https://github.com/o/r`), or a git remote URL. */
  remote?: string;
  commit?: string;
}

/** `git@github.com:o/r.git` / `ssh://git@host/o/r.git` / `https://host/o/r.git` → `https://host/o/r`. */
export function webRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  let r = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(r);
  if (scp) r = `https://${scp[1]}/${scp[2]}`;
  r = r.replace(/^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\//, "https://$1/").replace(/^git:\/\//, "https://");
  r = r.replace(/^(https?:\/\/)[^/@]+@/, "$1");
  r = r.replace(/\/+$/, "").replace(/\.git$/, "");
  return /^https?:\/\/[^/]+\/.+/.test(r) ? r : undefined;
}

function encodePath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
    .join("/");
}

/** The absolute path of a repo-relative file, forward slashes, leading slash (`/C:/x/y` on Windows). */
export function absPath(root: string, rel: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const joined = `${r}/${rel.replace(/^\/+/, "")}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/** The URL opening `path` at `line` with an editor, or undefined when it cannot be built. */
export function editorUrl(editor: Editor, repo: RepoRef, path: string, line = 1, end?: number): string | undefined {
  const ln = Math.max(1, Math.floor(line) || 1);
  if (editor === "github" || !repo.root) {
    const web = webRemote(repo.remote);
    if (!web) return undefined;
    const range = end && end > ln ? `#L${ln}-L${end}` : `#L${ln}`;
    return `${web}/blob/${encodeURIComponent(repo.commit || "HEAD")}/${encodePath(path)}${range}`;
  }
  const abs = absPath(repo.root, path);
  switch (editor) {
    case "vscode":
    case "cursor":
    case "zed":
      return `${editor}://file${encodePath(abs)}:${ln}`;
    case "idea":
      return `idea://open?file=${encodeURIComponent(abs)}&line=${ln}`;
  }
}
