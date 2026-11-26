// Screens declared in literal route tables.
//
// React Router (`react-router` / `react-router-dom` declared, file imports it):
//   createBrowserRouter / createHashRouter / createMemoryRouter / useRoutes
//   ([{ path, element | Component | lazy, children, index }]) — a table passed
//   by name resolves to its same-file `const`; arrays typed `RouteObject[]`;
//   JSX `<Route path="…" element={…}>` trees, nested children joined.
// Vue Router (`vue-router` declared, file imports it or types `RouteRecordRaw`):
//   `routes: [{ path, component | components, children }]` and arrays typed
//   `RouteRecordRaw[]`.
//
// A route is a screen when it renders something; redirects (`<Navigate>`,
// `redirect:` without a component) and pathless layouts are not, though a
// layout's children still nest under its path.

import { importsModule, readArgs, stringLiteral } from "./js.js";
import { cleanRoutePath, stripParamPatterns } from "./routing.js";
import { declares, isScriptFile, objectProps, propValue, sourceViews } from "./source.js";
import type { ExtractInput, ExtractOutput, Extractor, ScreenFact } from "./types.js";

/** Join a child route path to its parent's: absolute children stand alone. */
function joinChild(parent: string, child: string): string {
  if (child.startsWith("/")) return cleanRoutePath(child);
  return cleanRoutePath(`${parent}/${child}`);
}

interface TableKeys {
  framework: string;
  /** Keys whose presence makes the route render a screen. */
  renders: readonly string[];
  /** A rendering value that is in fact a redirect. */
  redirect?: RegExp;
}

const REACT_KEYS: TableKeys = { framework: "react-router", renders: ["element", "Component", "lazy", "component"], redirect: /^<\s*Navigate\b/ };
const VUE_KEYS: TableKeys = { framework: "vue-router", renders: ["component", "components"] };

/** Walk a literal route array whose `[` is at `open`, emitting screens. */
function walkTable(
  text: string,
  open: number,
  parent: string,
  keys: TableKeys,
  rel: string,
  lineOf: (o: number) => number,
  out: ScreenFact[],
  depth = 0,
): void {
  if (depth > 20 || text[open] !== "[") return;
  const arr = readArgs(text, open);
  if (!arr) return;
  for (const el of arr.args) {
    if (!el.raw.startsWith("{")) continue;
    const obj = objectProps(text, el.start);
    if (!obj) continue;
    const pathProp = propValue(obj.props, "path");
    const raw = pathProp ? stringLiteral(pathProp.value) : undefined;
    if (pathProp && raw === undefined) continue;
    const isIndex = propValue(obj.props, "index")?.value === "true";
    const path = raw !== undefined ? joinChild(parent, stripParamPatterns(raw)) : parent;
    const render = keys.renders.map((k) => propValue(obj.props, k)).find((p) => p !== undefined);
    const redirect = render && keys.redirect?.test(render.value);
    if ((raw !== undefined || isIndex) && render && !redirect)
      out.push({ path, file: rel, line: lineOf(el.start), end: lineOf(obj.end - 1), framework: keys.framework });
    const children = propValue(obj.props, "children");
    if (children?.value.startsWith("[")) walkTable(text, children.start, path, keys, rel, lineOf, out, depth + 1);
  }
}

/** The `[` of the same-file `const name = [` (typed or not), if any. */
function constArray(skeleton: string, name: string): number | undefined {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=;]+)?=\\s*\\[`).exec(skeleton);
  return m ? m.index + m[0].length - 1 : undefined;
}

/** Arrays typed as route tables: `const routes: RouteObject[] = [`, `export const routes: RouteRecordRaw[] = [`. */
function typedArrays(skeleton: string, typeName: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*:\\s*(?:readonly\\s+)?(?:${typeName})\\s*\\[\\s*\\]\\s*=\\s*\\[`, "g");
  for (const m of skeleton.matchAll(re)) out.push((m.index as number) + m[0].length - 1);
  return out;
}

/** End of a JSX opening tag starting at `<` (`/>` or `>` outside braces); `selfClosing` tells which. */
function tagEnd(skeleton: string, from: number): { end: number; selfClosing: boolean } | undefined {
  let depth = 0;
  for (let i = from + 1; i < skeleton.length; i++) {
    const ch = skeleton[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && ch === ">") return { end: i + 1, selfClosing: skeleton[i - 1] === "/" };
  }
  return undefined;
}

/**
 * Attribute source of a tag with brace contents blanked, so nested elements'
 * attributes are not read — except a brace holding a plain string
 * (`path={"/about"}`), kept as written.
 */
function topLevelAttrs(text: string, skeleton: string, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) {
    if (skeleton[i] !== "{") {
      out += text[i] as string;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < to; j++) {
      if (skeleton[j] === "{") depth++;
      else if (skeleton[j] === "}" && --depth === 0) break;
    }
    if (j >= to) {
      out += " ".repeat(to - i);
      break;
    }
    const inner = text.slice(i + 1, j);
    out += /^\s*(["'`])[^"'`]*\1\s*$/.test(inner) ? `{${inner}}` : `{${" ".repeat(inner.length)}}`;
    i = j;
  }
  return out;
}

function jsxRoutes(text: string, skeleton: string, rel: string, lineOf: (o: number) => number, out: ScreenFact[]): void {
  const stack: string[] = [];
  for (const m of skeleton.matchAll(/<\s*Route\b|<\/\s*Route\s*>/g)) {
    const at = m.index as number;
    if (m[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const tag = tagEnd(skeleton, at);
    if (!tag) continue;
    const parent = stack[stack.length - 1] ?? "/";
    const attrs = topLevelAttrs(text, skeleton, at, tag.end);
    // The element's own value (`element={<Navigate …/>}`) is blanked in attrs; read it from text.
    const pathM = /\spath\s*=\s*(?:(["'])([^"']*)\1|\{\s*(["'`])([^"'`]*)\3\s*\})/.exec(attrs);
    const path = pathM ? joinChild(parent, stripParamPatterns((pathM[2] ?? pathM[4]) as string)) : parent;
    const isIndex = /\sindex(?:\s*=\s*\{\s*true\s*\})?(?=[\s/>])/.test(attrs);
    const renderM = /\s(element|Component|component|lazy)\s*=\s*\{/.exec(attrs);
    let redirect = false;
    if (renderM) {
      const open = at + (renderM.index as number) + renderM[0].length - 1;
      redirect = /^\{\s*<\s*Navigate\b/.test(text.slice(open, open + 40));
    }
    if ((pathM || isIndex) && renderM && !redirect) out.push({ path, file: rel, line: lineOf(at), end: lineOf(tag.end - 1), framework: "react-router" });
    if (!tag.selfClosing) stack.push(path);
  }
}

function extractReactRouter(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  if (!importsModule(text, "react-router-dom") && !importsModule(text, "react-router")) return {};
  const screens: ScreenFact[] = [];
  const tables = new Set<number>(typedArrays(skeleton, "RouteObject"));
  for (const m of skeleton.matchAll(/(?<![\w$.])(?:createBrowserRouter|createHashRouter|createMemoryRouter|createStaticRouter|useRoutes)\s*\(/g)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    const first = call?.args[0];
    if (!first) continue;
    if (first.raw.startsWith("[")) tables.add(first.start);
    else if (/^[A-Za-z_$][\w$]*$/.test(first.raw)) {
      const at = constArray(skeleton, first.raw);
      if (at !== undefined) tables.add(at);
    }
  }
  for (const at of [...tables].sort((a, b) => a - b)) walkTable(text, at, "/", REACT_KEYS, input.rel, lineOf, screens);
  jsxRoutes(text, skeleton, input.rel, lineOf, screens);
  return screens.length ? { screens } : {};
}

export const reactRouterExtractor: Extractor = {
  id: "react-router",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["react-router", "react-router-dom"]);
  },
  extract: extractReactRouter,
};

function extractVueRouter(input: ExtractInput): ExtractOutput {
  const { text, skeleton, lineOf } = sourceViews(input);
  if (!importsModule(text, "vue-router") && !/\bRouteRecordRaw\b/.test(skeleton)) return {};
  const tables = new Set<number>(typedArrays(skeleton, "RouteRecordRaw"));
  for (const m of skeleton.matchAll(/(?<![\w$.])createRouter\s*\(\s*\{/g)) {
    const obj = objectProps(text, (m.index as number) + m[0].length - 1);
    const routes = obj ? propValue(obj.props, "routes") : undefined;
    if (!routes) continue;
    if (routes.value.startsWith("[")) tables.add(routes.start);
    else if (/^[A-Za-z_$][\w$]*$/.test(routes.value)) {
      const at = constArray(skeleton, routes.value);
      if (at !== undefined) tables.add(at);
    }
  }
  const screens: ScreenFact[] = [];
  for (const at of [...tables].sort((a, b) => a - b)) walkTable(text, at, "/", VUE_KEYS, input.rel, lineOf, screens);
  return screens.length ? { screens } : {};
}

export const vueRouterExtractor: Extractor = {
  id: "vue-router",
  applies(input, ctx) {
    return isScriptFile(input.rel) && declares(ctx, input.rel, ["vue-router"]);
  },
  extract: extractVueRouter,
};
