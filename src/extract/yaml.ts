// A tiny, dependency-free, line-based YAML outline reader: enough to find
// `services:` keys in a compose file, `on.schedule[].cron` in a workflow, and
// `kind` / `metadata.name` in Kubernetes manifests — every node with its line.
//
// Not a YAML parser. It reads block mappings and block sequences by
// indentation; flow collections (`[a, b]`, `{a: 1}`) stay raw scalar text;
// block scalars (`|`, `>`) are skipped; anchors, tags and multi-line plain
// scalars are not interpreted. Comments are blanked first (mask.ts), so a
// commented-out service is not a service.

import { maskComments } from "./mask.js";

export interface YamlNode {
  /** Mapping key, unquoted; undefined for a sequence item. */
  key?: string;
  /** Inline scalar value, unquoted; undefined when the value is a nested block (or empty). */
  value?: string;
  /** 1-based line. */
  line: number;
  indent: number;
  /** A `- …` sequence item. */
  item: boolean;
  children: YamlNode[];
}

function unquote(raw: string): string {
  const v = raw.trim();
  const m = /^(["'])([\s\S]*)\1$/.exec(v);
  return m ? (m[2] as string) : v;
}

const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'#\-?:,[\]{}][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

/** One YAML document's top-level nodes per document (`---` separates documents). */
export function yamlDocuments(text: string): YamlNode[][] {
  const masked = maskComments(text, "hash");
  const lines = masked.split("\n");
  const docs: YamlNode[][] = [];
  let roots: YamlNode[] = [];
  let stack: YamlNode[] = [];
  let blockIndent = -1;
  const attach = (node: YamlNode) => {
    while (stack.length && (stack[stack.length - 1] as YamlNode).indent >= node.indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  };
  const keyValue = (content: string, indent: number, line: number): YamlNode | undefined => {
    const m = KEY.exec(content);
    if (!m) return undefined;
    const node: YamlNode = { key: unquote(m[1] as string), line, indent, item: false, children: [] };
    const rest = (m[2] ?? "").trim();
    if (/^[|>][-+0-9]*$/.test(rest)) blockIndent = indent;
    else if (rest && !/^[&*!]\S*$/.test(rest)) node.value = unquote(rest.replace(/^[&!]\S+\s+/, ""));
    return node;
  };
  lines.forEach((raw, i) => {
    const line = i + 1;
    const text = raw.replace(/\r$/, "");
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(text)) {
      if (roots.length) docs.push(roots);
      roots = [];
      stack = [];
      blockIndent = -1;
      return;
    }
    if (!text.trim()) return;
    const indent = text.length - text.trimStart().length;
    if (blockIndent !== -1) {
      if (indent > blockIndent) return;
      blockIndent = -1;
    }
    let content = text.trim();
    let at = indent;
    // `- a: 1` opens an item whose first mapping key sits two columns in.
    while (content === "-" || content.startsWith("- ")) {
      const item: YamlNode = { line, indent: at, item: true, children: [] };
      attach(item);
      const rest = content.slice(1);
      const lead = rest.length - rest.trimStart().length;
      content = rest.trim();
      at += 1 + lead;
      if (!content) return;
      if (!KEY.test(content) && !content.startsWith("- ")) {
        item.value = unquote(content);
        return;
      }
    }
    const node = keyValue(content, at, line);
    if (node) attach(node);
  });
  if (roots.length) docs.push(roots);
  return docs;
}

/** The child of `nodes` (a node's children, or a document's roots) with mapping key `key`. */
export function yamlChild(nodes: readonly YamlNode[] | undefined, key: string): YamlNode | undefined {
  return nodes?.find((n) => n.key === key);
}
