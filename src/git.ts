// The few git facts ultraview reads itself, through the engine's `sh` (no
// shell, bounded output): HEAD's sha and committer date, the `origin` remote as
// an https URL, and a file's content at a commit. Every function answers
// undefined outside a git repository instead of throwing.

import { codeindex } from "./engine.js";

/** HEAD's full sha and committer date (ISO-8601), or undefined (not a repo, no commits yet). */
export function headState(repo: string): { sha: string; date: string } | undefined {
  const r = codeindex.sh("git", ["-C", repo, "log", "-1", "--no-color", "--format=%H%x00%cI"]);
  if (!r.ok) return undefined;
  const [sha, date] = r.stdout.trim().split("\0");
  return sha && date ? { sha, date } : undefined;
}

/**
 * A git remote URL in https form with any credentials stripped, or undefined
 * when it is not a host URL (a local path, an unknown scheme).
 *
 *   git@github.com:o/r.git            → https://github.com/o/r
 *   ssh://git@host:2222/o/r.git       → https://host/o/r
 *   https://user:token@host/o/r.git   → https://host/o/r
 */
export function httpsRemote(url: string): string | undefined {
  const u = url.trim();
  let host: string | undefined;
  let path: string | undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  const full = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (full) [, host, path] = full;
  else if (scp && !/^[a-z]:$/i.test(`${scp[1]}:`)) [, host, path] = scp;
  if (!host || !path) return undefined;
  const clean = path.replace(/\/+$/, "").replace(/\.git$/, "");
  return clean ? `https://${host.toLowerCase()}/${clean}` : undefined;
}

/** `origin` as an https URL (credentials stripped), or undefined. */
export function originRemote(repo: string): string | undefined {
  const r = codeindex.sh("git", ["-C", repo, "config", "--get", "remote.origin.url"]);
  return r.ok ? httpsRemote(r.stdout) : undefined;
}

/** A file's text at a commit (`<sha>:./<rel>`, relative to `repo`), or undefined when it is not there. */
export function fileAt(repo: string, sha: string, rel: string): string | undefined {
  const r = codeindex.sh("git", ["-C", repo, "show", "--no-color", `${sha}:./${rel}`], { maxBufferBytes: 16 * 1024 * 1024 });
  return r.ok ? r.stdout : undefined;
}
