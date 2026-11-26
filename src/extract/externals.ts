// Third-party services the code talks to, three ways (docs/design.md §5):
//
//   sdk   an import of a known SDK (sdk-map.ts), at the import line, when the
//         workspace declares the package — `import Stripe from "stripe"`,
//         `import boto3`, `from google.cloud import storage`;
//   host  an absolute URL literal to a non-local host that REACHES the
//         network, id = the registrable domain (`https://api.acme.io/v1` →
//         `acme.io`) or the SDK id for a known API host (`api.stripe.com` →
//         `stripe`). A literal reaches the network when it is:
//           - an HTTP call's URL (`fetch("https://…")`, `axios.get`,
//             `requests.post`, `x.get("https://…")`, `new Request(…)`), or the
//             `url` / `uri` of a call or client config (`axios({ url })`,
//             `new HttpLink({ uri })`);
//           - a client base URL (`axios.create({ baseURL })`,
//             `httpx.Client(base_url=…)`, `createClient("https://…")`);
//           - a configuration default (`process.env.X ?? "https://…"`,
//             `os.getenv("X", "https://…")`, zod `.default("https://…")`) or
//             a value named like one: `*_HOST` / `*_ENDPOINT` / `*_API*` /
//             `*_DSN` constants anywhere, `*_URL` constants in a settings
//             module (`settings.py`, `config/*`, `env.ts`, `*.config.js`),
//             service-qualified camelCase names (`apiBaseUrl`, `webhookUrl`);
//           - a known SDK's API host, wherever it sits;
//         and, through the `external-hosts` linker, the host of every
//         absolute-URL call fact (constants, client instances and Python
//         calls resolved there). localhost, IPs, reserved names (RFC 2606 /
//         6761 / 6762, `example.*`, `exemple.*`) and XML / schema / sitemap
//         namespaces are skipped;
//   env   an environment variable read whose name starts with a known SDK's
//         prefix — `process.env.STRIPE_KEY`, `os.environ["STRIPE_KEY"]`,
//         `os.getenv("STRIPE_KEY")` → `stripe`.
//
// Every other absolute URL in a string is a hyperlink (JSX `href`, content,
// i18n and error strings, prose): recorded as a `links` fact, never an
// external. JS/TS and Python source only; comments and docstrings are masked
// first, so a docs link in a comment is nothing at all.

import { isJsLike, readArgs } from "./js.js";
import { lineIndex, maskSource } from "./mask.js";
import { isPython } from "./py.js";
import {
  ENV_IGNORED,
  ENV_PUBLIC_PREFIXES,
  IGNORED_DOMAIN_LABELS,
  IGNORED_HOSTS,
  IGNORED_TLDS,
  MULTI_LABEL_SUFFIXES,
  NAMESPACE_PATH,
  SDK_MAP,
  type SdkEntry,
} from "./sdk-map.js";
import type { ExternalFact, ExtractInput, ExtractOutput, Extractor, Facts, LinkFact, Linker, RepoContext } from "./types.js";

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
  if (ENV_IGNORED.test(name)) return undefined;
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
  if (IGNORED_DOMAIN_LABELS.includes(labels[labels.length - take] as string)) return undefined;
  return domain;
}

/** The SDK whose API host this is (`api.stripe.com` → stripe, `x.supabase.co` → supabase). */
export function sdkForHost(host: string): SdkEntry | undefined {
  const h = host.toLowerCase();
  return SDK_MAP.find((e) => (e.hosts ?? []).some((p) => (p.startsWith("*.") ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p)));
}

/** The external id of a URL host: a known SDK's id, else its registrable domain; undefined when skipped. */
export function hostExternalId(host: string, path = "/"): string | undefined {
  if (NAMESPACE_PATH.test(path)) return undefined;
  const domain = registrableDomain(host);
  if (!domain) return undefined;
  return sdkForHost(host)?.id ?? domain;
}

// --- where a URL literal sits -------------------------------------------------

const QUOTES = new Set(['"', "'", "`"]);

/** Callees that send a request to their first argument (bare `get` / `post`: imported request helpers). */
const HTTP_FUNCTIONS = new Set([
  "fetch",
  "$fetch",
  "ofetch",
  "useFetch",
  "useLazyFetch",
  "useSWR",
  "axios",
  "ky",
  "got",
  "superagent",
  "needle",
  "urlopen",
  "Request",
  "wretch",
  "get",
  "post",
  "put",
  "patch",
  "request",
  "fetchJson",
  "fetchJSON",
  "getJson",
  "getJSON",
]);
/** Methods that send a request to their first argument, on any receiver (`requests.get`, `client.post`, `http.request`). */
const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "request",
  "fetch",
  "stream",
  "urlopen",
  "ws_connect",
  "clone",
  "fetchJson",
  "fetchJSON",
  "getJson",
  "getJSON",
]);
/** Client constructors and factories: a URL first argument or `url` / `uri` / `baseURL` option is the service they talk to. */
const CLIENT_FACTORIES = new Set([
  "create",
  "extend",
  "createClient",
  "GraphQLClient",
  "ApolloClient",
  "HttpLink",
  "createHttpLink",
  "httpLink",
  "httpBatchLink",
  "httpBatchStreamLink",
  "createWSClient",
  "io",
  "EventSource",
  "WebSocket",
  "Client",
  "AsyncClient",
  "Session",
]);
/** Environment / settings getters whose later arguments are defaults (`os.getenv("X", "https://…")`, `env("X", default=…)`). */
const ENV_GETTERS = /(?:^|\.)(?:getenv|get_env|env|config|str|url)$|(?:^|\.)environ\.get$/;
/** Option keys naming the endpoint of a call or client config. */
const URL_KEYS = new Set(["url", "uri", "baseURL", "baseUrl", "base_url", "prefixUrl", "prefix_url", "endpoint", "host", "server"]);

/** Words that qualify a `…Url` / `…_host` name as a service endpoint rather than a page (`apiUrl` yes, `privacyUrl` no). */
const SERVICE_QUALIFIERS = new Set([
  "api",
  "apis",
  "base",
  "prefix",
  "server",
  "service",
  "backend",
  "webhook",
  "hook",
  "graphql",
  "gql",
  "rpc",
  "trpc",
  "rest",
  "soap",
  "auth",
  "oauth",
  "oidc",
  "token",
  "ws",
  "wss",
  "websocket",
  "socket",
  "sse",
  "upstream",
  "proxy",
  "gateway",
  "ingest",
  "collector",
  "tracker",
  "tracking",
  "analytics",
  "matomo",
  "sentry",
  "endpoint",
  "remote",
  "broker",
  "s3",
  "storage",
  "bucket",
  "smtp",
  "mail",
  "elastic",
  "search",
  "redis",
  "db",
  "database",
]);
/** Qualifiers too generic on their own outside a settings module (`const baseUrl = "https://site"` builds links). */
const WEAK_QUALIFIERS = new Set(["base", "prefix", "remote"]);
const SERVICE_TAILS = new Set(["url", "uri", "endpoint", "host", "hostname", "dsn", "base", "root", "origin", "server"]);
/** Tokens of an UPPER_SNAKE name that make it a service endpoint anywhere (`SEARCH_API_BASE`, `SMTP_HOST`, `SENTRY_DSN`). */
const UPPER_SERVICE_TOKENS = /^(?:URIS?|HOST(?:NAME)?S?|ENDPOINTS?|API\w*|DSN)$/;
/** `*_URL` alone: a service in a settings module, a page link elsewhere (`const HELP_URL = "https://…"` in a component). */
const UPPER_URL_TOKENS = /^URLS?$/;

/** A settings / configuration / environment module (`settings.py`, `config/app.ts`, `src/env.js`, `next.config.js`). */
export function isConfigFile(rel: string): boolean {
  return /(?:^|\/)(?:settings|config|configs|configuration|conf|env|environment|environments)(?:\/|\.|_|-|$)|\.config\.[cm]?[jt]s$/i.test(rel);
}

/**
 * Is `name` a configuration value naming a service endpoint? `SEARCH_API_BASE`,
 * `SENTRY_DSN`, `SMTP_HOST`, `baseURL`, `apiHost`, `webhook_url`; `PDF_URL` only
 * in a settings module (`config`: the file is one). Never `url`, `href`,
 * `privacyUrl`, `homeUrl`.
 */
export function isServiceName(rawName: string, config = false): boolean {
  const name = rawName.replace(/^[_$]+/, "");
  if (/^[A-Z][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name)) {
    const tokens = name.split("_");
    return tokens.some((t) => UPPER_SERVICE_TOKENS.test(t)) || (config && tokens.some((t) => UPPER_URL_TOKENS.test(t)));
  }
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const last = words[words.length - 1];
  if (!last || !SERVICE_TAILS.has(last)) return false;
  if (words.length === 1) return last === "endpoint" || last === "dsn";
  const qualifiers = words.slice(0, -1).filter((w) => SERVICE_QUALIFIERS.has(w));
  // `baseUrl` / `prefixUrl` alone name a site root as often as an API: configuration only in a settings module.
  return qualifiers.some((w) => !WEAK_QUALIFIERS.has(w)) || (config && qualifiers.length > 0);
}

/** The call whose argument list holds offset `from` (directly, or in an object literal argument), searching the skeleton. */
function enclosingCall(sk: string, from: number): { callee: string; arg: number; inObject: boolean } | undefined {
  let depth = 0;
  let commas = 0;
  let inObject = false;
  const stop = Math.max(0, from - 4000);
  for (let i = from - 1; i >= stop; i--) {
    const ch = sk[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch === "(") {
        const m = /(\??\.\s*)?([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^<>()]*>)?\s*$/.exec(sk.slice(Math.max(0, i - 200), i));
        // `git().clone(` / `getClient().get(`: a method on a call result keeps its leading dot.
        return m ? { callee: `${m[1] ? "." : ""}${(m[2] as string).replace(/[\s?]/g, "")}`, arg: commas, inObject } : undefined;
      }
      // An object literal argument, not a block (`) {`, `=> {`).
      if (ch === "{" && !inObject && !/(?:\)|=>|\b(?:else|try|do|finally))\s*$/.test(sk.slice(Math.max(0, i - 20), i))) {
        inObject = true;
        commas = 0;
        continue;
      }
      return undefined;
    } else if (ch === "," && depth === 0) commas++;
  }
  return undefined;
}

/** Start of the expression element holding offset `from`: after the nearest top-level `,` `;` opener, or statement-ending newline. */
function elementStart(text: string, sk: string, from: number, python: boolean): number {
  let depth = 0;
  const stop = Math.max(0, from - 2000);
  for (let i = from - 1; i >= stop; i--) {
    const ch = sk[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      // A grouping paren (`URL = (\n "https://…"\n)`) is part of the element.
      if (ch === "(" && /(?:[=:]|\breturn)\s*$/.test(sk.slice(Math.max(0, i - 20), i))) continue;
      return i + 1;
    } else if (depth === 0 && (ch === "," || ch === ";")) return i + 1;
    else if (depth === 0 && ch === "\n") {
      // A newline ends the statement unless an operator carries it over (multi-line ternaries, `??`, `=`).
      const after = text.slice(i + 1, from).trimStart();
      const before = text.slice(Math.max(0, i - 80), i).trimEnd();
      // Python: a line ending in `:` opens a block, it does not carry an expression over.
      if (/^(?:[?:|&+.=]|\?\?)/.test(after) || /(?:[=?|&+,\\([{]|=>|\bor|\band)$/.test(before) || (!python && before.endsWith(":"))) continue;
      return i + 1;
    }
  }
  return stop;
}

/** The name an expression element assigns or keys its value under: `API_URL = …`, `base_url=…`, `apiUrl: …`, `"api_url": …`. */
function elementName(element: string): string | undefined {
  const assign =
    /^\s*(?:export\s+)?(?:(?:const|let|var|readonly|static|private|public|protected|declare)\s+)*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?::[^=]*?)?\s*:?=(?![=>])/.exec(
      element,
    );
  if (assign) return (assign[1] as string).split(".").pop()?.trim();
  const key = /^\s*(?:([A-Za-z_$][\w$]*)|"([^"\n]*)"|'([^'\n]*)')\s*:(?!:)/.exec(element);
  return key ? (key[1] ?? key[2] ?? key[3]) : undefined;
}

const HTTP_CALL_SITE = new RegExp(
  `(?<![\\w$.])(?:${[...HTTP_FUNCTIONS].map((n) => n.replace(/\$/g, "\\$")).join("|")})\\s*\\(|\\.\\s*(?:${[...HTTP_METHODS].join("|")})\\s*\\(`,
  "g",
);

/** The URL argument source of every HTTP call site of a file: the first argument, and any `url=` / `url:` argument. */
function httpCallArguments(text: string, sk: string): string[] {
  const out: string[] = [];
  for (const m of sk.matchAll(HTTP_CALL_SITE)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!call?.args.length) continue;
    out.push((call.args[0] as { raw: string }).raw);
    for (const a of call.args.slice(1)) if (/^url\s*=/.test(a.raw)) out.push(a.raw);
  }
  return out;
}

export type UrlUse = "service" | "link" | "skip";

/**
 * How the absolute URL starting at `at` is used: `service` when it reaches the
 * network (call, client base, configuration), `skip` for an XML namespace,
 * else `link`. `text` is comment-masked, `sk` the string-masked skeleton.
 */
export interface UrlUseOptions {
  /** The file is a settings module (`*_URL` constants are configuration there). */
  config?: boolean;
  /** Does a variable of this name reach an HTTP call of the same file (`url = "https://…"` … `urlopen(url)`)? */
  reachesCall?: (name: string) => boolean;
}

export function urlUse(text: string, sk: string, at: number, python: boolean, opts: UrlUseOptions = {}): UrlUse {
  if (/xmlns(?::[\w-]+)?\s*=\s*\{?\s*["'`]$/.test(text.slice(Math.max(0, at - 24), at))) return "skip";
  // A Content-Security-Policy source: the page connects to, runs or embeds what
  // `connect-src` / `script-src` / `frame-src` / `worker-src` allow; other
  // directives (`img-src`, `font-src`…) only load assets.
  const csp = /\b((?:connect|script|frame|worker|child|default|img|style|font|media|manifest|object)-src|form-action)\b[^;`]*$/.exec(
    text.slice(Math.max(0, at - 600), at),
  );
  if (csp) return /^(?:connect|script|frame|worker|child)-src$/.test(csp[1] as string) ? "service" : "link";
  // A URL inside prose ("see https://…") or after a substitution is a link.
  if (!QUOTES.has(sk[at - 1] as string)) return "link";
  let q = at - 1;
  // Python string prefixes (`f"…"`, `rb"…"`) belong to the literal.
  const prefix = python ? /(?<![\w$])[rRbBuUfF]{1,2}$/.exec(sk.slice(Math.max(0, q - 2), q)) : null;
  if (prefix) q -= prefix[0].length;
  const before = text.slice(Math.max(0, q - 160), q);
  if (/(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env)\s*(?:\.\s*[\w$]+|\[[^\]]*\])\s*(?:\?\?|\|\|)\s*$/.test(before)) return "service";
  if (/(?:environ\s*\.\s*get|getenv)\s*\([^()]*\)\s*or\s*$/.test(before)) return "service";
  const call = enclosingCall(sk, q);
  const last = call?.callee.split(".").pop() ?? "";
  const httpCall = !!call && (HTTP_FUNCTIONS.has(call.callee) || (call.callee.includes(".") && HTTP_METHODS.has(last)));
  const client = !!call && (httpCall || CLIENT_FACTORIES.has(last));
  if (call && !call.inObject) {
    if (call.arg === 0 && (httpCall || client)) return "service";
    if (call.arg >= 1 && ENV_GETTERS.test(call.callee)) return "service";
    if (last === "default") return "service";
  }
  const name = elementName(text.slice(elementStart(text, sk, q, python), q));
  if (name && isServiceName(name, opts.config)) return "service";
  if (name && opts.reachesCall?.(name)) return "service";
  if (name && client && URL_KEYS.has(name)) return "service";
  if (name === "default" && call && ENV_GETTERS.test(call.callee)) return "service";
  return "link";
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
  const config = isConfigFile(input.rel);
  let callArgs: string[] | undefined;
  const reachesCall = (name: string) => {
    callArgs ??= httpCallArguments(text, skeleton);
    const word = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
    return callArgs.some((a) => word.test(a));
  };
  const out: ExternalFact[] = [];
  const links: LinkFact[] = [];
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

  // host: absolute URLs inside string literals that reach the network; the rest are links.
  for (const m of text.matchAll(
    /\bhttps?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)(?::\d+)?(\/[^\s"'`?#)<>]*)?/g,
  )) {
    const at = m.index as number;
    if (!inString(at)) continue;
    const host = m[1] as string;
    const id = hostExternalId(host, m[2] ?? "/");
    if (!id) continue;
    const sdkHost = sdkForHost(host) !== undefined;
    const use = sdkHost ? "service" : urlUse(text, skeleton, at, python, { config, reachesCall });
    if (use === "service") push(id, "host", at);
    else if (use === "link") links.push({ host: id, file: input.rel, line: lineOf(at) });
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
  const result: ExtractOutput = {};
  if (out.length) result.externals = out;
  if (links.length) result.links = links;
  return result;
}

export const externalsExtractor: Extractor = {
  id: "externals",
  applies: (input: ExtractInput) => isJsLike(input.rel) || isPython(input.rel),
  extract: extractExternals,
};

/**
 * Hosts of absolute-URL call facts (`fetch(SHOP_FEED)` with a same-file
 * constant, calls through a client instance, Python `requests` / `httpx`):
 * each is an external, unless the calling file already cites that external.
 * Runs after the `http-calls` linker, which adds calls through imported clients.
 */
export const externalHostsLinker: Linker = {
  id: "external-hosts",
  link(facts: Facts): Facts {
    const cited = new Set(facts.externals.map((x) => `${x.file}\u0000${x.id}`));
    const added: ExternalFact[] = [];
    for (const c of facts.calls) {
      const m = /^https?:\/\/([^/:]+)(?::\d+)?(\/.*)?$/i.exec(c.url);
      if (!m) continue;
      const id = hostExternalId(m[1] as string, m[2] ?? "/");
      if (!id || cited.has(`${c.file}\u0000${id}`)) continue;
      cited.add(`${c.file}\u0000${id}`);
      added.push({ id, via: "host", file: c.file, line: c.line });
    }
    return added.length ? { ...facts, externals: [...facts.externals, ...added] } : facts;
  },
};
