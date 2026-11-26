// Third-party services the code talks to, three ways (docs/design.md §5):
//
//   sdk   an import of a known SDK (sdk-map.ts), at the import line, when the
//         workspace declares the package — `import Stripe from "stripe"`,
//         `import boto3`, `from google.cloud import storage`;
//   host  an absolute URL literal to a non-local host, id = the registrable
//         domain (`https://api.stripe.com/v1` → `stripe.com`); localhost, IPs,
//         reserved names and XML / schema namespaces are skipped;
//   env   an environment variable read whose name starts with a known SDK's
//         prefix — `process.env.STRIPE_KEY`, `os.environ["STRIPE_KEY"]`,
//         `os.getenv("STRIPE_KEY")` → `stripe`.
//
// JS/TS and Python source only; comments and docstrings are masked first, so
// a docs link in a comment is not a dependency.

import { isJsLike } from "./js.js";
import { lineIndex, maskSource } from "./mask.js";
import { isPython } from "./py.js";
import { ENV_PUBLIC_PREFIXES, IGNORED_HOSTS, IGNORED_TLDS, MULTI_LABEL_SUFFIXES, SDK_MAP, type SdkEntry } from "./sdk-map.js";
import type { ExternalFact, ExtractInput, ExtractOutput, Extractor, RepoContext } from "./types.js";

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** The npm package a bare import specifier names: `@aws-sdk/client-s3/x` → `@aws-sdk/client-s3`, `firebase/app` → `firebase`. */
function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

/** The SDK an npm package belongs to. */
export function sdkForNpm(pkg: string): SdkEntry | undefined {
  return SDK_MAP.find((e) => e.npm.some((p) => matches(p, pkg)));
}

/** The SDK a Python import module belongs to (`google.cloud.storage` → google-cloud). */
export function sdkForPyModule(module: string): SdkEntry | undefined {
  return SDK_MAP.find((e) => e.py.some((m) => module === m || module.startsWith(`${m}.`)));
}

/** The SDK an environment variable name points at, by prefix (longest first). */
export function sdkForEnv(name: string): SdkEntry | undefined {
  let n = name;
  for (const p of ENV_PUBLIC_PREFIXES) if (n.startsWith(p)) n = n.slice(p.length);
  let best: SdkEntry | undefined;
  let bestLen = 0;
  for (const e of SDK_MAP) {
    for (const p of e.env) {
      if ((n === p || n.startsWith(`${p}_`)) && p.length > bestLen) {
        best = e;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** The registrable domain of a host (`api.stripe.com` → `stripe.com`, `x.shop.co.uk` → `shop.co.uk`); undefined when local or ignored. */
export function registrableDomain(host: string): string | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return undefined;
  const labels = h.split(".");
  if (labels.some((l) => !l)) return undefined;
  const tld = labels[labels.length - 1] as string;
  if (IGNORED_TLDS.includes(tld) || !/^[a-z]{2,}$/.test(tld)) return undefined;
  const two = labels.slice(-2).join(".");
  const take = MULTI_LABEL_SUFFIXES.includes(two) ? 3 : 2;
  if (labels.length < take) return undefined;
  const domain = labels.slice(-take).join(".");
  if (IGNORED_HOSTS.includes(domain) || IGNORED_HOSTS.includes(h)) return undefined;
  return domain;
}

function jsImports(text: string): { spec: string; offset: number }[] {
  const out: { spec: string; offset: number }[] = [];
  const RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'.][^"']*)\1/g;
  for (const m of text.matchAll(RE)) out.push({ spec: m[2] as string, offset: m.index as number });
  return out;
}

function pyImportModules(text: string): { module: string; offset: number }[] {
  const out: { module: string; offset: number }[] = [];
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm)) {
    for (const part of (m[1] as string).split(",")) {
      const mod = /^\s*([\w.]+)/.exec(part)?.[1];
      if (mod) out.push({ module: mod, offset: m.index as number });
    }
  }
  for (const m of text.matchAll(/^[ \t]*from[ \t]+([\w][\w.]*)[ \t]+import[ \t]+([^\n]+)/gm)) {
    const base = m[1] as string;
    out.push({ module: base, offset: m.index as number });
    // `from google.cloud import storage` names google.cloud.storage too.
    for (const part of (m[2] as string).replace(/[()]/g, "").split(",")) {
      const name = /^\s*(\w+)/.exec(part)?.[1];
      if (name) out.push({ module: `${base}.${name}`, offset: m.index as number });
    }
  }
  return out;
}

function declared(entry: SdkEntry, deps: ReadonlySet<string>, python: boolean): boolean {
  const names = python ? entry.dist : entry.npm;
  for (const d of deps) if (names.some((p) => matches(p, d))) return true;
  return false;
}

function extractExternals(input: ExtractInput, ctx: RepoContext): ExtractOutput {
  const python = isPython(input.rel);
  const text = maskSource(input.rel, input.text);
  const skeleton = maskSource(input.rel, input.text, { strings: true });
  const inString = (i: number) => skeleton[i] === " " && text[i] !== " ";
  const lineOf = lineIndex(text);
  const deps = ctx.depsFor(input.rel);
  const out: ExternalFact[] = [];
  const push = (id: string, via: ExternalFact["via"], offset: number) => out.push({ id, via, file: input.rel, line: lineOf(offset) });

  // sdk
  if (python) {
    for (const imp of pyImportModules(text)) {
      const sdk = sdkForPyModule(imp.module);
      if (sdk && declared(sdk, deps, true)) push(sdk.id, "sdk", imp.offset);
    }
  } else {
    for (const imp of jsImports(text)) {
      const sdk = sdkForNpm(packageOf(imp.spec));
      if (sdk && declared(sdk, deps, false)) push(sdk.id, "sdk", imp.offset);
    }
  }

  // host: absolute URLs inside string literals.
  for (const m of text.matchAll(/\bhttps?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)/g)) {
    if (!inString(m.index as number)) continue;
    const domain = registrableDomain(m[1] as string);
    if (domain) push(domain, "host", m.index as number);
  }

  // env
  const ENV = python
    ? /(?<![\w.])(?:os\s*\.\s*)?(?:environ\s*\[\s*|environ\s*\.\s*get\s*\(\s*|getenv\s*\(\s*)(["'])([A-Z][A-Z0-9_]*)\1/g
    : /\b(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env)\s*(?:\.\s*([A-Z][A-Z0-9_]*)|\[\s*(["'`])([A-Z][A-Z0-9_]*)\2\s*\])/g;
  const osBound = !python || /^[ \t]*(?:import[ \t]+os\b|from[ \t]+os[ \t]+import\b)/m.test(text);
  if (osBound) {
    for (const m of text.matchAll(ENV)) {
      // `log("process.env.X")` is text: the read itself must be code.
      if (inString(m.index as number)) continue;
      const name = python ? (m[2] as string) : ((m[1] ?? m[3]) as string);
      const sdk = sdkForEnv(name);
      if (sdk) push(sdk.id, "env", m.index as number);
    }
  }
  return out.length ? { externals: out } : {};
}

export const externalsExtractor: Extractor = {
  id: "externals",
  applies: (input: ExtractInput) => isJsLike(input.rel) || isPython(input.rel),
  extract: extractExternals,
};
