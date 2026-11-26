import { describe, expect, it } from "vitest";
import { hostExternalId, isConfigFile, isServiceName, registrableDomain, sdkForEnv, sdkForNpm, sdkForPyModule } from "../src/extract/externals.js";
import { runExtractors } from "../src/extract/index.js";
import { SDK_MAP } from "../src/extract/sdk-map.js";

function extOf(files: Record<string, string>): string[] {
  const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
  return facts.externals.map((e) => `${e.id} ${e.via} ${e.file}:${e.line}`);
}
const lines = (...l: string[]) => l.join("\n");

describe("externals extractor", () => {
  it("reads JS SDK imports of declared packages (scoped, subpaths, require, dynamic import)", () => {
    expect(
      extOf({
        "package.json": '{"dependencies":{"stripe":"1","@aws-sdk/client-s3":"3","firebase":"10","ioredis":"5","@sentry/node":"8"}}',
        "src/a.ts": lines(
          'import Stripe from "stripe";',
          'import { S3Client } from "@aws-sdk/client-s3";',
          'import { initializeApp } from "firebase/app";',
          'const Redis = require("ioredis");',
          'const Sentry = await import("@sentry/node");',
        ),
      }),
    ).toEqual(["stripe sdk src/a.ts:1", "aws sdk src/a.ts:2", "firebase sdk src/a.ts:3", "redis sdk src/a.ts:4", "sentry sdk src/a.ts:5"]);
  });

  it("reads Python SDK imports of declared distributions", () => {
    expect(
      extOf({
        "requirements.txt": "stripe\nboto3\ngoogle-cloud-storage\nsentry-sdk\npsycopg2-binary\nPyGithub\n",
        "app/a.py": lines(
          "import stripe",
          "import boto3, json",
          "from google.cloud import storage",
          "import sentry_sdk as sentry",
          "import psycopg2.extras",
          "from github import Github",
        ),
      }),
    ).toEqual([
      "stripe sdk app/a.py:1",
      "aws sdk app/a.py:2",
      "google-cloud sdk app/a.py:3",
      "sentry sdk app/a.py:4",
      "postgres sdk app/a.py:5",
      "github sdk app/a.py:6",
    ]);
  });

  it("reads hosts of URLs that reach the network: known SDK API hosts by SDK id, others by registrable domain", () => {
    expect(
      extOf({
        "src/a.ts": lines(
          'fetch("https://api.stripe.com/v1/charges");',
          "const u = `https://hooks.slack.com/services/${id}`;",
          'const shop = await fetch("https://www.shop.co.uk/feed");',
        ),
        "app/b.py": 'URL = f"https://api.openai.com/v1/{path}"',
      }),
    ).toEqual(["openai host app/b.py:1", "stripe host src/a.ts:1", "slack host src/a.ts:2", "shop.co.uk host src/a.ts:3"]);
  });

  it("reads env vars by SDK prefix (framework public prefixes stripped)", () => {
    expect(
      extOf({
        "src/a.ts": lines(
          "const k = process.env.STRIPE_SECRET_KEY;",
          'const u = process.env["NEXT_PUBLIC_SUPABASE_URL"];',
          "const t = import.meta.env.VITE_SENTRY_DSN;",
          "const g = process.env.GOOGLE_CLOUD_PROJECT;",
        ),
        "app/b.py": lines("import os", 'os.environ["OPENAI_API_KEY"]', 'os.environ.get("AWS_REGION")', 'os.getenv("TWILIO_TOKEN")'),
      }),
    ).toEqual([
      "openai env app/b.py:2",
      "aws env app/b.py:3",
      "twilio env app/b.py:4",
      "stripe env src/a.ts:1",
      "supabase env src/a.ts:2",
      "sentry env src/a.ts:3",
      "google-cloud env src/a.ts:4",
    ]);
  });

  it("maps names through the data module", () => {
    expect(sdkForNpm("@slack/web-api")?.id).toBe("slack");
    expect(sdkForNpm("@octokit/rest")?.id).toBe("github");
    expect(sdkForPyModule("slack_sdk.web")?.id).toBe("slack");
    expect(sdkForEnv("STRIPEY")).toBeUndefined();
    expect(sdkForEnv("GOOGLE_CLOUD_X")?.id).toBe("google-cloud");
    expect(new Set(SDK_MAP.map((e) => e.id)).size).toBe(SDK_MAP.length);
    expect(registrableDomain("api.stripe.com")).toBe("stripe.com");
    expect(registrableDomain("localhost")).toBeUndefined();
    expect(registrableDomain("db.internal")).toBeUndefined();
    expect(registrableDomain("10.0.0.1")).toBeUndefined();
  });

  describe("false-positive guards", () => {
    it("ignores undeclared SDKs, relative imports and local modules", () => {
      expect(
        extOf({
          "package.json": '{"dependencies":{"express":"4"}}',
          "src/a.ts": lines('import Stripe from "stripe";', 'import { x } from "./stripe";'),
          "requirements.txt": "flask\n",
          "app/a.py": lines("import stripe", "from .openai import client"),
        }),
      ).toEqual([]);
    });

    it("ignores comments, docstrings, local and schema hosts, and URLs outside strings", () => {
      expect(
        extOf({
          "src/a.ts": lines(
            "// see https://stripe.com/docs",
            "/* https://api.github.com */",
            'fetch("http://localhost:3000/x");',
            'fetch("http://127.0.0.1/x");',
            'const ns = "http://www.w3.org/2000/svg";',
            'const ex = "https://example.com/a";',
            'const api = "https://api.internal/x";',
          ),
          "app/a.py": lines('"""Docs: https://docs.python.org/3/"""', "# https://pypi.org/project/x", 'x = "http://schemas.xmlsoap.org/soap/"'),
        }),
      ).toEqual([]);
    });

    it("ignores env vars of unknown services, env reads in strings and comments, and skips tests and markdown", () => {
      expect(
        extOf({
          "src/a.ts": lines("const p = process.env.PORT;", "// process.env.STRIPE_KEY", 'log("process.env.OPENAI_KEY");', "const x = env.STRIPE_KEY;"),
          "app/a.py": lines("import os", 'config.environ["STRIPE_KEY"]', 'os.getenv("DATABASE_URL")', "print(\"os.getenv('OPENAI_KEY')\")"),
          "app/b.py": 'environ["STRIPE_KEY"]',
          "src/a.test.ts": 'fetch("https://api.stripe.com"); process.env.STRIPE_KEY;',
          "docs/setup.md": "Set STRIPE_KEY and call https://api.stripe.com",
        }),
      ).toEqual([]);
    });
  });
});

function linksOf(files: Record<string, string>): string[] {
  const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
  return (facts.links ?? []).map((l) => `${l.host} ${l.file}:${l.line}`);
}

describe("externals precision: only URLs that reach the network", () => {
  it("counts HTTP call sites, client bases, call / client options, env and config defaults, service-named values", () => {
    expect(
      extOf({
        "package.json": '{"dependencies":{"axios":"1"}}',
        "src/api.ts": lines(
          'const res = await fetch("https://feeds.acme.io/v1/items");',
          'axios.post("https://hooks.acme-chat.com/x", body);',
          'export const client = axios.create({ baseURL: "https://api.payroll.dev/v2" });',
          'const gql = new ApolloClient({ uri: "https://graph.cms.dev/graphql" });',
          'const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.gateway.dev";',
          'const MATOMO_HOST = "https://stats.analytics.dev";',
          'const cfg = { apiBaseUrl: "https://core.backend.dev" };',
          "const PDF_ENDPOINT =",
          '  isProd ? "https://pdf.render.dev" : "https://pdf-staging.render.dev";',
          'const schema = z.object({ SITE: z.string().url().default("https://cfg.defaults.dev") });',
          'const sb = createClient("https://abc.supabase.co", key);',
        ),
        "app/settings.py": lines(
          "import os",
          'SEARCH_HOST = os.getenv("SEARCH_HOST", "https://search.index.dev")',
          'client = httpx.Client(base_url="https://api.partner.dev")',
          'r = requests.get("https://data.opendata.dev/x.json")',
          'api_url: str = "https://api.settings.dev"',
          'TOKEN_URL = env("TOKEN_URL", default="https://auth.idp.dev/token")',
        ),
      }),
    ).toEqual([
      "index.dev host app/settings.py:2",
      "partner.dev host app/settings.py:3",
      "opendata.dev host app/settings.py:4",
      "settings.dev host app/settings.py:5",
      "idp.dev host app/settings.py:6",
      "acme.io host src/api.ts:1",
      "acme-chat.com host src/api.ts:2",
      "payroll.dev host src/api.ts:3",
      "cms.dev host src/api.ts:4",
      "gateway.dev host src/api.ts:5",
      "analytics.dev host src/api.ts:6",
      "backend.dev host src/api.ts:7",
      "render.dev host src/api.ts:9",
      "defaults.dev host src/api.ts:10",
      "supabase host src/api.ts:11",
    ]);
  });

  it("counts a constant that reaches a call at the literal, and calls through an imported client via the call fact", () => {
    expect(
      extOf({
        "src/feed.ts": lines('const FEED = "https://www.shop.co.uk/feed";', "", "export async function load() {", "  return fetch(FEED);", "}"),
      }),
    ).toEqual(["shop.co.uk host src/feed.ts:1"]);
    expect(linksOf({ "src/feed.ts": lines('const FEED = "https://www.shop.co.uk/feed";', "fetch(FEED);") })).toEqual([]);
    // The client module cites its base URL; the calling module gets the external from its call fact (external-hosts linker).
    expect(
      extOf({
        "package.json": '{"dependencies":{"axios":"1"}}',
        "src/lib/partner.ts": lines('import axios from "axios";', 'export const partner = axios.create({ baseURL: "https://api.partner.dev/v1" });'),
        "src/sync.ts": lines('import { partner } from "./lib/partner";', "", 'export const sync = () => partner.get("/items");'),
      }),
    ).toEqual(["partner.dev host src/lib/partner.ts:2", "partner.dev host src/sync.ts:3"]);
  });

  it("records plain hyperlinks as links, not externals: JSX href, content and error strings, link-named values", () => {
    const files = {
      "src/Footer.tsx": lines(
        "export function Footer() {",
        "  return (",
        "    <footer>",
        '      <a href="https://www.cnil.fr/fr/cookies">CNIL</a>',
        '      <Link href="https://www.service-public.fr/particuliers">SP</Link>',
        "    </footer>",
        "  );",
        "}",
      ),
      "src/content.ts": lines(
        'export const help = "Read the guide at https://docs.vendor.dev/guide before you start.";',
        'export const privacyUrl = "https://legal.cnil.fr/privacy";',
        'export const links = [{ label: "Code", url: "https://github.com/acme/app" }];',
        'throw new Error("Install it (https://tools.vendor.dev/install) and retry.");',
      ),
    };
    expect(extOf(files)).toEqual([]);
    expect(linksOf(files)).toEqual([
      "cnil.fr src/Footer.tsx:4",
      "service-public.fr src/Footer.tsx:5",
      "vendor.dev src/content.ts:1",
      "cnil.fr src/content.ts:2",
      "github.com src/content.ts:3",
      "vendor.dev src/content.ts:4",
    ]);
  });

  it("counts a literal assigned to a variable that reaches an HTTP call of the same file", () => {
    const files = {
      "tools/fetch.py": lines(
        "import urllib.request",
        "def download():",
        "    URL = (",
        '        "https://files.opendata.dev/export.xlsx"',
        "    )",
        "    with urllib.request.urlopen(URL) as r:",
        "        return r.read()",
        "def notify(msg):",
        '    url = f"https://bot.chat.dev/send?text={msg}"',
        "    urlopen(Request(url))",
        "async def lookup(q):",
        '    url = "https://search.registry.dev/search"',
        "    return await get(url, params={'q': q})",
      ),
      "src/clone.ts": "await git().clone(`https://forge.code.dev/${project}`, dir);",
      "src/Page.tsx": lines('const url = "https://www.portal.gouv.fr/help";', "export const P = () => <a href={url}>help</a>;"),
    };
    expect(extOf(files)).toEqual([
      "code.dev host src/clone.ts:1",
      "opendata.dev host tools/fetch.py:4",
      "chat.dev host tools/fetch.py:9",
      "registry.dev host tools/fetch.py:12",
    ]);
    expect(linksOf(files)).toEqual(["portal.gouv.fr src/Page.tsx:1"]);
  });

  it("reads Content-Security-Policy sources: connect / script / frame sources are services, asset sources links", () => {
    const files = {
      "src/proxy.ts": lines(
        "const csp = `",
        "  default-src 'self';",
        "  img-src 'self' https://images.cdn-host.dev;",
        "  script-src 'self' https://www.tagmanager.dev https://forms.survey.dev;",
        "  connect-src 'self' https://geo.api.gouv.fr https://ingest.metrics.dev;",
        "  frame-src https://embed.video.dev;",
        "`;",
      ),
    };
    expect(extOf(files)).toEqual([
      "survey.dev host src/proxy.ts:4",
      "tagmanager.dev host src/proxy.ts:4",
      "api.gouv.fr host src/proxy.ts:5",
      "metrics.dev host src/proxy.ts:5",
      "video.dev host src/proxy.ts:6",
    ]);
    expect(linksOf(files)).toEqual(["cdn-host.dev src/proxy.ts:3"]);
  });

  it("false-positive guard: CI runner variables are not the service their prefix names", () => {
    expect(extOf({ "release.config.js": "const b = process.env.GITHUB_REF_NAME || process.env.GITHUB_SHA; const t = process.env.GITHUB_TOKEN;" })).toEqual([
      "github env release.config.js:1",
    ]);
  });

  it("a `*_URL` constant is configuration in a settings module and a link in a component", () => {
    const files = {
      "src/config.ts": 'export const PAYROLL_URL = "https://payroll.partner.dev";',
      "src/components/Help.tsx": 'const HELP_URL = "https://help.portal.dev/start";',
    };
    expect(extOf(files)).toEqual(["partner.dev host src/config.ts:1"]);
    expect(linksOf(files)).toEqual(["portal.dev src/components/Help.tsx:1"]);
  });

  it("caps links at the first 3 locations per host and drops hosts that are externals", () => {
    const many = Array.from({ length: 6 }, (_, i) => `const l${i} = "https://www.cnil.fr/p${i}";`);
    expect(
      linksOf({
        "src/a.ts": lines(...many),
        "src/b.ts": lines('const docs = "https://partner.dev/docs";', 'fetch("https://api.partner.dev/x");'),
      }),
    ).toEqual(["cnil.fr src/a.ts:1", "cnil.fr src/a.ts:2", "cnil.fr src/a.ts:3"]);
  });

  describe("false-positive guards", () => {
    it("skips placeholders, reserved names and XML / sitemap namespaces entirely (neither external nor link)", () => {
      const files = {
        "src/a.ts": lines(
          'fetch("https://exemple.fr/api");',
          'fetch("https://www.example.co.uk/api");',
          'fetch("https://api.service.test/x");',
          'fetch("https://host.invalid/x");',
          'fetch("http://printer.local/x");',
          'fetch("http://api.localhost/x");',
          'const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;',
          'const ns = "http://www.google.com/schemas/sitemap-image/1.1";',
          'const og = "https://ogp.me/ns#";',
          'const API_URL = "https://placeholder.exemple.com";',
        ),
      };
      expect(extOf(files)).toEqual([]);
      expect(linksOf(files)).toEqual([]);
    });

    it("plain url / href / host props and generic names stay links; comparisons are not assignments", () => {
      const files = {
        "src/a.ts": lines(
          'const meta = { url: "https://www.agency.gouv.fr", openGraph: { url: "https://og.agency.gouv.fr" } };',
          'const homeUrl = "https://www.portal.gouv.fr";',
          'if (window.location.origin === "https://www.site.gouv.fr") track();',
          'const tos = cond ? "https://terms.site.dev" : "https://terms2.site.dev";',
        ),
      };
      expect(extOf(files)).toEqual([]);
      expect(linksOf(files).map((l) => l.split(" ")[0])).toEqual(["agency.gouv.fr", "portal.gouv.fr", "site.gouv.fr", "site.dev"]);
    });
  });

  it("names: service-ish configuration vs page links", () => {
    for (const n of [
      "API_URL",
      "SENTRY_DSN",
      "SEARCH_HOST",
      "PDF_ENDPOINT",
      "STRIPE_API_BASE",
      "apiUrl",
      "apiHost",
      "webhookUrl",
      "graphqlEndpoint",
      "endpoint",
      "dsn",
    ])
      expect(isServiceName(n), n).toBe(true);
    for (const n of ["url", "href", "host", "homeUrl", "privacyUrl", "imageUrl", "link", "website", "label", "Site"]) expect(isServiceName(n), n).toBe(false);
    // `*_URL` alone is a service only in a settings module.
    expect(isServiceName("REPOSITORY_URL")).toBe(false);
    expect(isServiceName("REPOSITORY_URL", true)).toBe(true);
    // A leading underscore is a private constant, not a different name; `baseUrl` alone is weak outside settings.
    expect(isServiceName("_API_URL")).toBe(true);
    expect(isServiceName("_BASE_URL")).toBe(false);
    expect(isServiceName("baseUrl")).toBe(false);
    expect(isServiceName("baseUrl", true)).toBe(true);
    expect(isServiceName("apiBaseUrl")).toBe(true);
    expect(isConfigFile("app/settings.py")).toBe(true);
    expect(isConfigFile("src/env.js")).toBe(true);
    expect(isConfigFile("next.config.js")).toBe(true);
    expect(isConfigFile("src/config/app.ts")).toBe(true);
    expect(isConfigFile("src/components/Footer.tsx")).toBe(false);
    expect(isConfigFile("src/environmental/x.ts")).toBe(false);
    expect(hostExternalId("api.stripe.com")).toBe("stripe");
    expect(hostExternalId("www.stripe.com")).toBe("stripe.com");
    expect(hostExternalId("x.supabase.co")).toBe("supabase");
    expect(hostExternalId("www.w3.org")).toBeUndefined();
    expect(hostExternalId("exemple.fr")).toBeUndefined();
    expect(hostExternalId("www.google.com", "/schemas/sitemap/0.9")).toBeUndefined();
  });
});
