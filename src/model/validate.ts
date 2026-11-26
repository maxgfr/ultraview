// Structural validation of the agent-authored files (docs/design.md §3, §4):
// model.json, flows/<id>.json, lenses/<id>.json, and timeline entries.
//
// Hand-written and dependency-free. A tiny spec table per shape, interpreted by
// one walker: unknown keys are errors (they are almost always typos — `sumary`
// would otherwise silently drop the prose), ids follow SLUG_RE, enums are
// closed, and node ids must carry a known prefix. Every problem carries a
// JSON-pointer-ish path (`capabilities[2].members[0]`).
//
// Whether an id RESOLVES to a node is the check gate's job (src/check.ts): it
// needs the built map; this module only needs the JSON.

import { kindOf, parseId, SLUG_RE } from "./ids.js";
import {
  AUDIENCES,
  CHANGE_KINDS,
  CHAT_MODES,
  EDGE_KINDS,
  MODEL_SCHEMA,
  NODE_KINDS,
  type NodeKind,
  SYSTEM_KINDS,
  TIMELINE_SOURCES,
  TURN_SOURCES,
} from "./types.js";

export interface Problem {
  path: string;
  message: string;
}

type Spec =
  | { t: "string"; enum?: readonly string[]; slug?: boolean; nonEmpty?: boolean; nodeId?: readonly NodeKind[] }
  | { t: "literal"; value: number }
  | { t: "boolean" }
  | { t: "count" }
  | { t: "array"; of: Spec; nonEmpty?: boolean; unique?: boolean }
  | { t: "record"; of: Spec }
  | { t: "object"; fields: Record<string, Spec>; required: readonly string[] };

const str = (extra: Omit<Extract<Spec, { t: "string" }>, "t"> = {}): Spec => ({ t: "string", ...extra });
const text = str({ nonEmpty: true });
const arr = (of: Spec, extra: { nonEmpty?: boolean; unique?: boolean } = {}): Spec => ({ t: "array", of, ...extra });
const obj = (fields: Record<string, Spec>, required: readonly string[]): Spec => ({ t: "object", fields, required });

/** Any node kind. */
const ANY_NODE = NODE_KINDS;
/** What a capability may select (docs/design.md §2): anything but another capability. */
const MEMBER_KINDS = NODE_KINDS.filter((k) => k !== "cap");

const nodeRef = (kinds: readonly NodeKind[] = ANY_NODE) => str({ nonEmpty: true, nodeId: kinds });
const glob = str({ nonEmpty: true });
const schema: Spec = { t: "literal", value: MODEL_SCHEMA };
const sourcesSpec: Spec = { t: "record", of: str({ nonEmpty: true }) };

const MODEL_SPEC = obj(
  {
    schema,
    app: obj({ name: text, summary: text, audience: str({ enum: AUDIENCES }) }, ["name"]),
    systems: arr(
      obj(
        {
          id: str({ slug: true }),
          label: text,
          kind: str({ enum: SYSTEM_KINDS }),
          summary: text,
          paths: arr(glob, { nonEmpty: true }),
          exclude: arr(glob),
        },
        ["id", "label", "kind", "paths"],
      ),
    ),
    capabilities: arr(
      obj(
        {
          id: str({ slug: true }),
          label: text,
          summary: text,
          actors: arr(text, { unique: true }),
          members: arr(nodeRef(MEMBER_KINDS), { unique: true }),
          paths: arr(glob),
          tags: arr(text, { unique: true }),
        },
        ["id", "label"],
      ),
    ),
    edges: arr(obj({ from: nodeRef(), to: nodeRef(), kind: str({ enum: EDGE_KINDS }), label: text, cite: text }, ["from", "to", "kind"])),
    tour: arr(obj({ node: nodeRef(), note: text }, ["node", "note"])),
    glossary: arr(obj({ term: text, meaning: text }, ["term", "meaning"])),
  },
  ["schema", "app", "systems", "capabilities"],
);

const FLOW_SPEC = obj(
  {
    schema,
    id: str({ slug: true }),
    title: text,
    trigger: nodeRef(),
    steps: arr(obj({ node: nodeRef(), note: text }, ["node", "note"]), { nonEmpty: true }),
    sources: sourcesSpec,
  },
  ["schema", "id", "title", "steps"],
);

const LENS_SPEC = obj(
  {
    schema,
    id: str({ slug: true }),
    question: text,
    answer: text,
    nodes: arr(nodeRef(), { unique: true }),
    edges: arr(obj({ from: nodeRef(), to: nodeRef(), kind: str({ enum: EDGE_KINDS }) }, ["from", "to"])),
    focus: nodeRef(),
    sources: sourcesSpec,
  },
  ["schema", "id", "question", "answer", "nodes"],
);

const lensEdges = arr(obj({ from: nodeRef(), to: nodeRef(), kind: str({ enum: EDGE_KINDS }) }, ["from", "to"]));

const CONTEXT_SPEC = obj({ node: nodeRef(), edge: text, insight: text, step: text }, []);

const TURN_SPEC = obj(
  {
    question: text,
    lang: str({ nonEmpty: true }),
    mode: str({ enum: CHAT_MODES }),
    context: CONTEXT_SPEC,
    source: str({ enum: TURN_SOURCES }),
    answer: obj({ answer: text, nodes: arr(nodeRef(), { unique: true }), edges: lensEdges, focus: nodeRef() }, ["answer", "nodes"]),
    followUps: arr(text),
    sources: sourcesSpec,
    at: text,
    ms: { t: "count" },
  },
  ["question", "lang", "mode", "source", "answer", "followUps", "sources", "at"],
);

const CONVERSATION_SPEC = obj({ id: str({ slug: true }), title: text, createdAt: text, turns: arr(TURN_SPEC) }, ["id", "title", "createdAt", "turns"]);

const TIMELINE_SPEC = obj(
  {
    at: text,
    source: str({ enum: TIMELINE_SOURCES }),
    title: text,
    request: text,
    summary: text,
    items: arr(obj({ ref: nodeRef(), change: str({ enum: CHANGE_KINDS }), note: text }, ["ref", "change"])),
    base: text,
    head: text,
    change: text,
    auto: { t: "boolean" },
  },
  ["at", "source", "title", "summary", "items"],
);

const typeName = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const child = (base: string, key: string) => (base ? `${base}.${key}` : key);

function walkSpec(spec: Spec, value: unknown, path: string, out: Problem[]): undefined {
  const fail = (message: string): undefined => {
    out.push({ path, message });
  };
  switch (spec.t) {
    case "literal":
      if (value !== spec.value) fail(`must be ${spec.value} (got ${JSON.stringify(value) ?? "undefined"})`);
      return;
    case "boolean":
      if (typeof value !== "boolean") fail(`must be true or false (got ${typeName(value)})`);
      return;
    case "count":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        fail(`must be a non-negative integer (got ${JSON.stringify(value) ?? "undefined"})`);
      return;
    case "string": {
      if (typeof value !== "string") return fail(`must be a string (got ${typeName(value)})`);
      if (spec.nonEmpty && value.trim() === "") return fail("must not be empty");
      if (spec.slug && !SLUG_RE.test(value)) return fail(`"${value}" is not a valid id: lowercase letters, digits and dashes, starting with a letter or digit`);
      if (spec.enum && !spec.enum.includes(value)) return fail(`"${value}" is not one of ${spec.enum.join(", ")}`);
      if (spec.nodeId) {
        const kind = kindOf(value);
        if (!kind) return fail(`"${value}" is not a node id: it must start with one of ${NODE_KINDS.map((k) => `${k}:`).join(" ")}`);
        if (!spec.nodeId.includes(kind)) return fail(`"${value}": a ${kind}: id is not allowed here (expected ${spec.nodeId.map((k) => `${k}:`).join(" ")})`);
        if (!parseId(value)) return fail(`"${value}" is a malformed ${kind}: id`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) return fail(`must be an array (got ${typeName(value)})`);
      if (spec.nonEmpty && value.length === 0) fail("must not be empty");
      const seen = new Set<string>();
      value.forEach((item, i) => {
        walkSpec(spec.of, item, `${path}[${i}]`, out);
        if (spec.unique && typeof item === "string") {
          if (seen.has(item)) out.push({ path: `${path}[${i}]`, message: `duplicate "${item}"` });
          seen.add(item);
        }
      });
      return;
    }
    case "record": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`must be an object (got ${typeName(value)})`);
      for (const [k, v] of Object.entries(value)) walkSpec(spec.of, v, child(path, k), out);
      return;
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`must be an object (got ${typeName(value)})`);
      const rec = value as Record<string, unknown>;
      for (const key of spec.required) if (!(key in rec)) out.push({ path: child(path, key), message: "is required" });
      for (const [key, v] of Object.entries(rec)) {
        const field = spec.fields[key];
        if (!field) {
          out.push({ path: child(path, key), message: `unknown key "${key}" (allowed: ${Object.keys(spec.fields).join(", ")})` });
          continue;
        }
        walkSpec(field, v, child(path, key), out);
      }
      return;
    }
  }
}

/** Ids must be unique within a list (`systems`, `capabilities`). */
function uniqueIds(list: unknown, path: string, out: Problem[]): void {
  if (!Array.isArray(list)) return;
  const seen = new Map<string, number>();
  list.forEach((item, i) => {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return;
    const first = seen.get(id);
    if (first !== undefined) out.push({ path: `${path}[${i}].id`, message: `duplicate id "${id}" (first at ${path}[${first}])` });
    else seen.set(id, i);
  });
}

export function validateModel(value: unknown): Problem[] {
  const out: Problem[] = [];
  walkSpec(MODEL_SPEC, value, "", out);
  const rec = value as Record<string, unknown> | null;
  if (rec && typeof rec === "object") {
    uniqueIds(rec.systems, "systems", out);
    uniqueIds(rec.capabilities, "capabilities", out);
  }
  return out;
}

export function validateFlow(value: unknown): Problem[] {
  const out: Problem[] = [];
  walkSpec(FLOW_SPEC, value, "", out);
  return out;
}

export function validateLens(value: unknown): Problem[] {
  const out: Problem[] = [];
  walkSpec(LENS_SPEC, value, "", out);
  return out;
}

/** A BCP-47-ish language tag: `en`, `fr`, `pt-BR`, `zh-Hant`. */
export const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** Follow-up suggestions an agent turn carries. */
export const FOLLOW_UPS = 3;

/** A conversation file: the shape, then what the walker cannot say (language tags, the follow-up count). */
export function validateConversation(value: unknown): Problem[] {
  const out: Problem[] = [];
  walkSpec(CONVERSATION_SPEC, value, "", out);
  if (out.length) return out;
  (value as { turns: { lang: string; source: string; followUps: unknown[] }[] }).turns.forEach((t, i) => {
    if (!LANG_RE.test(t.lang)) out.push({ path: `turns[${i}].lang`, message: `"${t.lang}" is not a language tag (en, fr, pt-BR…)` });
    if (t.source === "agent" && t.followUps.length !== FOLLOW_UPS)
      out.push({ path: `turns[${i}].followUps`, message: `an agent turn carries exactly ${FOLLOW_UPS} follow-ups (got ${t.followUps.length})` });
    if (t.source === "facts" && t.followUps.length > FOLLOW_UPS)
      out.push({ path: `turns[${i}].followUps`, message: `at most ${FOLLOW_UPS} follow-ups (got ${t.followUps.length})` });
  });
  return out;
}

export function validateTimelineEntry(value: unknown): Problem[] {
  const out: Problem[] = [];
  walkSpec(TIMELINE_SPEC, value, "", out);
  return out;
}

/** Parse JSON text, turning a syntax error into a problem instead of a throw. */
export function parseJson(text: string): { value: unknown; problems: Problem[] } {
  try {
    return { value: JSON.parse(text), problems: [] };
  } catch (e) {
    return { value: undefined, problems: [{ path: "", message: `invalid JSON: ${(e as Error).message}` }] };
  }
}
