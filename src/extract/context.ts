// The repo context every extractor sees: the indexed file list and, per
// workspace, the dependencies its manifests declare (package.json,
// pyproject.toml, requirements*.txt, Pipfile, setup.cfg).
//
// Declared dependencies are the false-positive guard for framework
// extractors: `app.get("/x")` is an Express route only in a workspace that
// depends on express. Manifests are read through the caller's `readText`, so
// building a context is as pure as the extractors themselves.

import type { RepoContext } from "./types.js";

const PY_NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;

function normalizePy(name: string): string {
  return name.toLowerCase().replace(/[._]+/g, "-");
}

function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** Dependency names declared by a package.json (every dependency field). */
export function packageJsonDeps(text: string): string[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) out.push(...Object.keys(deps));
  }
  return out;
}

/** Requirement names from a requirements.txt (options, includes, URLs and comments skipped). */
export function requirementsDeps(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line)) continue;
    const m = PY_NAME.exec(line);
    if (m?.[1]) out.push(normalizePy(m[1]));
  }
  return out;
}

/**
 * Dependency names from a pyproject.toml: PEP 621 `[project].dependencies` and
 * optional groups, PEP 735 `[dependency-groups]`, and Poetry's
 * `[tool.poetry.*dependencies]` tables. A line-oriented reader, not a TOML
 * parser: enough for the shapes these sections take in practice.
 */
export function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  let section = "";
  let inArray = false;
  const takeStrings = (s: string) => {
    for (const m of s.matchAll(/["']([^"']+)["']/g)) {
      const name = PY_NAME.exec(m[1] as string)?.[1];
      if (name) out.push(normalizePy(name));
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (inArray) {
      takeStrings(line);
      if (line.includes("]")) inArray = false;
      continue;
    }
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      continue;
    }
    const arraySection = section === "project" || section === "project.optional-dependencies" || section === "dependency-groups";
    if (arraySection) {
      const kv = /^([\w.-]+)\s*=\s*\[(.*)$/.exec(line);
      if (!kv) continue;
      if (section === "project" && kv[1] !== "dependencies") continue;
      const rest = kv[2] as string;
      takeStrings(rest.split("]")[0] as string);
      if (!rest.includes("]")) inArray = true;
      continue;
    }
    if (/^tool\.poetry(?:\.group\.[\w-]+)?\.(?:dev-)?dependencies$/.test(section)) {
      const key = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line)?.[1];
      if (key && key.toLowerCase() !== "python") out.push(normalizePy(key));
    }
  }
  return out;
}

/** Package names from a Pipfile's `[packages]` and `[dev-packages]` tables (bare or quoted keys). */
export function pipfileDeps(text: string): string[] {
  const out: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      continue;
    }
    if (section !== "packages" && section !== "dev-packages") continue;
    const key = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9._-]*))\s*=/.exec(line);
    const name = key ? (key[1] ?? key[2] ?? key[3]) : undefined;
    if (name) out.push(normalizePy(name));
  }
  return out;
}

/**
 * Requirement names from a setup.cfg: `[options] install_requires`,
 * `setup_requires`, `tests_require`, and every `[options.extras_require]`
 * entry — inline values and indented continuation lines alike.
 */
export function setupCfgDeps(text: string): string[] {
  const out: string[] = [];
  let section = "";
  let collecting = false;
  const take = (value: string) => {
    for (const part of value.split(/[,;]/)) {
      const v = part.trim();
      if (!v || v.startsWith("-") || /^[a-z+]+:\/\//i.test(v)) continue;
      const m = PY_NAME.exec(v);
      if (m?.[1]) out.push(normalizePy(m[1]));
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(raw)) continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(raw.trim());
    if (header && !/^\s/.test(raw)) {
      section = (header[1] as string).trim();
      collecting = false;
      continue;
    }
    // A continuation line is indented; a new key starts at column 0.
    if (/^\s+\S/.test(raw)) {
      if (collecting) take(raw.replace(/\s#.*$/, ""));
      continue;
    }
    collecting = false;
    const kv = /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1] as string;
    const wanted =
      (section === "options" && (key === "install_requires" || key === "setup_requires" || key === "tests_require")) || section === "options.extras_require";
    if (!wanted) continue;
    collecting = true;
    take((kv[2] as string).replace(/\s#.*$/, ""));
  }
  return out;
}

/** The workspace a manifest belongs to. `requirements/base.txt` belongs to the directory holding `requirements/`. */
function manifestWorkspace(rel: string): string {
  const dir = dirOf(rel);
  if (baseOf(dir) === "requirements") return dirOf(dir);
  return dir;
}

type ManifestKind = "npm" | "pyproject" | "requirements" | "pipfile" | "setup-cfg";

const READERS: Record<ManifestKind, (text: string) => string[]> = {
  npm: packageJsonDeps,
  pyproject: pyprojectDeps,
  requirements: requirementsDeps,
  pipfile: pipfileDeps,
  "setup-cfg": setupCfgDeps,
};

function manifestKind(rel: string): ManifestKind | undefined {
  const base = baseOf(rel);
  if (base === "package.json") return "npm";
  if (base === "pyproject.toml") return "pyproject";
  if (base === "Pipfile") return "pipfile";
  if (base === "setup.cfg") return "setup-cfg";
  if (/^requirements[\w.-]*\.txt$/i.test(base)) return "requirements";
  if (baseOf(dirOf(rel)) === "requirements" && base.endsWith(".txt")) return "requirements";
  return undefined;
}

/** Build the context from the indexed files, reading manifests through `readText`. */
export function createRepoContext(files: readonly string[], readText: (rel: string) => string | undefined): RepoContext {
  const sorted = [...files].sort();
  const deps = new Map<string, Set<string>>();
  for (const rel of sorted) {
    const kind = manifestKind(rel);
    if (!kind) continue;
    const text = readText(rel);
    if (text === undefined) continue;
    const names = READERS[kind](text);
    const ws = manifestWorkspace(rel);
    let set = deps.get(ws);
    if (!set) deps.set(ws, (set = new Set()));
    for (const n of names) set.add(n);
  }
  const empty = new Set<string>();
  const cache = new Map<string, Set<string>>();
  const depsFor = (rel: string): Set<string> => {
    let dir = dirOf(rel);
    const start = dir;
    const hit = cache.get(start);
    if (hit) return hit;
    for (;;) {
      const set = deps.get(dir);
      if (set) {
        cache.set(start, set);
        return set;
      }
      if (dir === "") break;
      dir = dirOf(dir);
    }
    cache.set(start, empty);
    return empty;
  };
  return { files: sorted, deps, depsFor };
}
