// `ultraview hook install|uninstall [--agent claude]` (docs/design.md §7):
// opt-in only. Adds to `<repo>/.claude/settings.local.json` (personal, not
// committed: the command holds this machine's absolute path; `shared` writes
// the committed `.claude/settings.json` instead, with a warning) one Claude
// Code `Stop` hook that records what the agent changed after every turn:
//
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node '…/ultraview.mjs' diff --worktree …" } ] } ] } }
//
// Every other byte of the file is kept as it was (the edit is a splice at the
// right place, in the file's own indentation); ours is recognised by
// HOOK_MARKER, so install is idempotent and uninstall removes only ours, from
// whichever of the two files holds it. The
// command itself never fails the agent's turn: `diff --hook` exits 0 whatever
// happens and logs errors to `.ultraview/hook.log`.
//
// Never prints, never exits.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./json.js";

export const HOOK_AGENTS = ["claude"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

/** Personal, never committed: the default home of the hook (its command holds a machine-local absolute path). */
export const LOCAL_SETTINGS_FILE = ".claude/settings.local.json";
/** Shared with the team (committed): only with `shared`, and with a warning. */
export const SHARED_SETTINGS_FILE = ".claude/settings.json";
/** Every file uninstall looks in. */
export const SETTINGS_FILES = [LOCAL_SETTINGS_FILE, SHARED_SETTINGS_FILE] as const;
/** The substring that marks a hook command as ours. */
export const HOOK_MARKER = "--source agent --hook";
/** Seconds Claude Code waits for the hook before giving up on it. */
export const HOOK_TIMEOUT_SECONDS = 30;

/** POSIX single-quoting. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The hook's command. Worktree mode (staged + unstaged + untracked against
 * HEAD) because an agent rarely stages what it edits; `--hook` keeps it silent,
 * deduplicated and unable to fail the turn. `$CLAUDE_PROJECT_DIR` is the
 * project root Claude Code exports to hooks (empty → the current directory).
 */
export function hookCommand(script: string): string {
  return `node ${shQuote(script)} diff --worktree --record --quiet ${HOOK_MARKER} --repo "$CLAUDE_PROJECT_DIR"`;
}

export interface HookOptions {
  agent?: string;
  /** Show the change without writing it. */
  dryRun?: boolean;
  /** install: write the committed `.claude/settings.json` instead of `.claude/settings.local.json`. */
  shared?: boolean;
}

/** Printed with `shared`: the committed file now holds a path that only exists on this machine. */
export function sharedWarning(script: string): string {
  return `${SHARED_SETTINGS_FILE} is shared with everyone who clones the repo, but the hook command holds an absolute path specific to this machine (${script}): on another machine it will not run. Prefer the default, ${LOCAL_SETTINGS_FILE}.`;
}

export interface HookResult {
  ok: boolean;
  /** Repo-relative settings file acted on (uninstall: the first one changed). */
  file: string;
  /** Every settings file changed (or, with dryRun, that would be). */
  files: string[];
  action: "installed" | "updated" | "unchanged" | "removed" | "absent";
  dryRun: boolean;
  /** Line diff of the settings file (empty when nothing changes). */
  diff: string;
  command?: string;
  /** install with `shared`: the machine-local path warning. */
  warning?: string;
  errors: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A line diff of two texts, every line shown (`-` removed, `+` added, ` ` kept). Empty when equal. */
export function lineDiff(before: string, after: string, file: string): string {
  if (before === after) return "";
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after.replace(/\n$/, "").split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i++]}`);
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+${b[j++]}`);
    else out.push(`-${a[i++]}`);
  }
  return `${out.join("\n")}\n`;
}

// --- surgical edits on the settings text ---------------------------------------
// The file is edited in place, never re-serialised: a span-tracking parse finds
// where `hooks` / `Stop` / our entry sit, and only those bytes change. What
// install inserts, uninstall removes byte for byte.

interface JNode {
  start: number;
  end: number;
  /** Objects: members in order. */
  members?: { key: string; start: number; value: JNode }[];
  /** Arrays: items in order. */
  items?: JNode[];
  /** Strings: the decoded value. */
  str?: string;
}

/** Parse JSON text that JSON.parse already accepted, keeping every value's span. */
function parseSpans(text: string): JNode {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const str = (): JNode => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return { start, end: i, str: JSON.parse(text.slice(start, i)) as string };
  };
  const value = (): JNode => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '"') return str();
    if (c === "{" || c === "[") {
      i++;
      const members: NonNullable<JNode["members"]> = [];
      const items: JNode[] = [];
      for (ws(); text[i] !== (c === "{" ? "}" : "]"); ws()) {
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (c === "{") {
          const key = str();
          ws();
          i++; // ':'
          members.push({ key: key.str!, start: key.start, value: value() });
        } else items.push(value());
      }
      i++;
      return c === "{" ? { start, end: i, members } : { start, end: i, items };
    }
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
    return { start, end: i };
  };
  return value();
}

interface Elem {
  start: number;
  end: number;
}
const elemsOf = (n: JNode): Elem[] => (n.members ? n.members.map((m) => ({ start: m.start, end: m.value.end })) : (n.items ?? []));
const memberOf = (n: JNode | undefined, key: string) => n?.members?.find((m) => m.key === key)?.value;
const splice = (text: string, start: number, end: number, by: string) => text.slice(0, start) + by + text.slice(end);

/** Leading whitespace of the line holding `pos`. */
function indentAt(text: string, pos: number): string {
  const line = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(line))![0];
}

/** Append `elem` (JSON text, unit-indented) as the last element of a container, matching its siblings' indentation. */
function appendElem(text: string, container: JNode, elem: string, unit: string): string {
  const elems = elemsOf(container);
  const last = elems[elems.length - 1];
  if (last) {
    const base = indentAt(text, last.start);
    return splice(text, last.end, last.end, `,\n${base}${elem.split("\n").join(`\n${base}`)}`);
  }
  const outer = indentAt(text, container.start);
  const base = outer + unit;
  return splice(text, container.start + 1, container.end - 1, `\n${base}${elem.split("\n").join(`\n${base}`)}\n${outer}`);
}

/** Remove element `idx` of a container with the separator that joined it (the exact inverse of appendElem). */
function removeElem(text: string, container: JNode, idx: number): string {
  const elems = elemsOf(container);
  if (idx > 0) return splice(text, elems[idx - 1]!.end, elems[idx]!.end, "");
  if (elems.length > 1) return splice(text, elems[0]!.start, elems[1]!.start, "");
  return splice(text, container.start + 1, container.end - 1, "");
}

/** Our hook entries: [group index, hook index within the group]. */
function oursIn(stop: JNode): { group: number; hook: number; command: JNode }[] {
  const out: { group: number; hook: number; command: JNode }[] = [];
  (stop.items ?? []).forEach((g, gi) => {
    (memberOf(g, "hooks")?.items ?? []).forEach((h, hi) => {
      const command = memberOf(h, "command");
      if (command?.str?.includes(HOOK_MARKER)) out.push({ group: gi, hook: hi, command });
    });
  });
  return out;
}

interface Settings {
  /** Repo-relative path. */
  file: string;
  abs: string;
  before: string;
  /** Indentation unit of the file (default two spaces). */
  unit: string;
}

function readSettings(repo: string, file: string): Settings | { error: string } {
  const abs = join(repo, file);
  if (!existsSync(abs)) return { file, abs, before: "", unit: "  " };
  const before = readFileSync(abs, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(before);
  } catch (e) {
    return { error: `${file} is not valid JSON (${(e as Error).message}): fix it first, nothing was changed` };
  }
  if (!isObject(value)) return { error: `${file} is not a JSON object: nothing was changed` };
  if (value.hooks !== undefined && !isObject(value.hooks)) return { error: `${file}: "hooks" is not an object: nothing was changed` };
  if (isObject(value.hooks) && value.hooks.Stop !== undefined && !Array.isArray(value.hooks.Stop))
    return { error: `${file}: "hooks.Stop" is not an array: nothing was changed` };
  return { file, abs, before, unit: /^[ \t]+(?=")/m.exec(before)?.[0] ?? "  " };
}

function finish(s: Settings, after: string, action: HookResult["action"], dryRun: boolean, command?: string): HookResult {
  if (after !== s.before) {
    try {
      JSON.parse(after);
    } catch {
      return failed(`could not edit ${s.file} safely: nothing was changed`, dryRun, s.file);
    }
  }
  if (!dryRun && after !== s.before) writeFileAtomic(s.abs, after);
  return {
    ok: true,
    file: s.file,
    files: after !== s.before ? [s.file] : [],
    action,
    dryRun,
    diff: lineDiff(s.before, after, s.file),
    ...(command ? { command } : {}),
    errors: [],
  };
}

function checkAgent(agent: string | undefined): string | undefined {
  return agent === undefined || (HOOK_AGENTS as readonly string[]).includes(agent)
    ? undefined
    : `unsupported agent "${agent}" (supported: ${HOOK_AGENTS.join(", ")})`;
}

const failed = (error: string, dryRun: boolean, file: string = LOCAL_SETTINGS_FILE): HookResult => ({
  ok: false,
  file,
  files: [],
  action: "unchanged",
  dryRun,
  diff: "",
  errors: [error],
});

/**
 * Add (or update) our Stop hook; `script` is the absolute path of the
 * ultraview.mjs the hook runs. Into the personal `settings.local.json` by
 * default; `shared` writes the committed `settings.json` and warns that the
 * command holds a path only valid on this machine.
 */
export function installHook(repoArg: string, script: string, opts: HookOptions = {}): HookResult {
  const dryRun = !!opts.dryRun;
  const file = opts.shared ? SHARED_SETTINGS_FILE : LOCAL_SETTINGS_FILE;
  const bad = checkAgent(opts.agent);
  if (bad) return failed(bad, dryRun, file);
  const repo = resolve(repoArg);
  if (!existsSync(repo)) return failed(`repo not found: ${repo}`, dryRun, file);
  const s = readSettings(repo, file);
  if ("error" in s) return failed(s.error, dryRun, file);
  const command = hookCommand(resolve(script));
  const warned = (r: HookResult): HookResult => (opts.shared && r.ok ? { ...r, warning: sharedWarning(resolve(script)) } : r);
  const group = { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] };
  const pretty = (v: unknown) => JSON.stringify(v, null, s.unit);
  if (!s.before) return warned(finish(s, `${pretty({ hooks: { Stop: [group] } })}\n`, "installed", dryRun, command));
  const root = parseSpans(s.before);
  const hooks = memberOf(root, "hooks");
  if (!hooks) return warned(finish(s, appendElem(s.before, root, `"hooks": ${pretty({ Stop: [group] })}`, s.unit), "installed", dryRun, command));
  const stop = memberOf(hooks, "Stop");
  if (!stop) return warned(finish(s, appendElem(s.before, hooks, `"Stop": ${pretty([group])}`, s.unit), "installed", dryRun, command));
  const ours = oursIn(stop);
  if (!ours.length) return warned(finish(s, appendElem(s.before, stop, pretty(group), s.unit), "installed", dryRun, command));
  if (ours.every((o) => o.command.str === command)) return warned(finish(s, s.before, "unchanged", dryRun, command));
  let after = s.before;
  for (const o of [...ours].sort((a, b) => b.command.start - a.command.start)) after = splice(after, o.command.start, o.command.end, JSON.stringify(command));
  return warned(finish(s, after, "updated", dryRun, command));
}

/** Remove our entries from one settings file (a group, `Stop` or `hooks` left empty by that removal goes too). */
function uninstallFrom(repo: string, file: string, dryRun: boolean): HookResult {
  const s = readSettings(repo, file);
  if ("error" in s) return failed(s.error, dryRun, file);
  if (!s.before) return finish(s, s.before, "absent", dryRun);
  let text = s.before;
  let removed = 0;
  // One removal at a time, re-reading the spans after each.
  for (;;) {
    const stop = memberOf(memberOf(parseSpans(text), "hooks"), "Stop");
    const o = stop ? oursIn(stop)[0] : undefined;
    if (!stop || !o) break;
    const group = stop.items![o.group]!;
    const list = memberOf(group, "hooks")!;
    text = list.items!.length === 1 ? removeElem(text, stop, o.group) : removeElem(text, list, o.hook);
    removed++;
  }
  if (!removed) return finish(s, s.before, "absent", dryRun);
  const root = parseSpans(text);
  const hooks = memberOf(root, "hooks")!;
  const stopAt = hooks.members!.findIndex((m) => m.key === "Stop");
  if (!hooks.members![stopAt]!.value.items!.length) {
    text = removeElem(text, hooks, stopAt);
    const after = parseSpans(text);
    const h = memberOf(after, "hooks")!;
    if (!h.members!.length)
      text = removeElem(
        text,
        after,
        after.members!.findIndex((m) => m.key === "hooks"),
      );
  }
  return finish(s, text, "removed", dryRun);
}

/** Remove our Stop hook, and only it, from whichever settings file holds it (both, if both do). */
export function uninstallHook(repoArg: string, opts: HookOptions = {}): HookResult {
  const dryRun = !!opts.dryRun;
  const bad = checkAgent(opts.agent);
  if (bad) return failed(bad, dryRun);
  const repo = resolve(repoArg);
  const results = SETTINGS_FILES.map((f) => uninstallFrom(repo, f, dryRun));
  const bad2 = results.find((r) => !r.ok);
  if (bad2) return bad2;
  const removed = results.filter((r) => r.action === "removed");
  if (!removed.length) return { ...results[0]!, action: "absent" };
  return { ...removed[0]!, files: removed.map((r) => r.file), diff: removed.map((r) => r.diff).join("") };
}
