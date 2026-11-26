import { describe, expect, it } from "vitest";
import { bracketSegment, flatRoutePath, routeMatchKey, stripParamPatterns } from "../src/extract/routing.js";
import { factsOfFiles } from "./helpers.js";

const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

function routesOf(files: Record<string, string>): string[] {
  return factsOfFiles(files).routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line} ${r.framework}${r.handler ? ` ${r.handler}` : ""}`);
}

function screensOf(files: Record<string, string>): string[] {
  return factsOfFiles(files).screens.map((s) => `${s.path} ${s.file}:${s.line} ${s.framework}`);
}

describe("path helpers", () => {
  it("maps bracket segments", () => {
    expect(["(shop)", "@modal", "[id]", "[[id]]", "[...slug]", "[[...slug]]", "[id=integer]", "[a]-[b]", "plain"].map(bracketSegment)).toEqual([
      "",
      "",
      ":id",
      ":id",
      "*slug",
      "*slug",
      ":id",
      ":a-:b",
      "plain",
    ]);
  });

  it("maps Remix flat-route names", () => {
    expect(
      ["_index", "about", "users.$id", "users_.$id.edit", "_auth.login", "files.$", "($lang).docs", "sitemap[.]xml", "app.(opt).x", "concerts._index"].map(
        flatRoutePath,
      ),
    ).toEqual(["/", "/about", "/users/:id", "/users/:id/edit", "/login", "/files/*", "/:lang/docs", "/sitemap.xml", "/app/opt/x", "/concerts"]);
  });

  it("strips inline param patterns", () => {
    expect(stripParamPatterns("/u/:id{[0-9]+}/:slug(\\d+)?/:rest(.*)*")).toBe("/u/:id/:slug?/*rest");
  });

  it("matches call URLs to route patterns, most specific key first", () => {
    expect(routeMatchKey("/users/:p", "/users/:id")).toEqual([0, 1]);
    expect(routeMatchKey("/users/me", "/users/me")).toEqual([0, 0]);
    expect(routeMatchKey("/users/me", "/users/:id")).toEqual([0, 1]);
    expect(routeMatchKey("/users/:p", "/users/me")).toBeUndefined();
    expect(routeMatchKey("/docs/a/b", "/docs/*slug")).toEqual([1, 0]);
    expect(routeMatchKey("/docs", "/docs/*slug")).toEqual([1, 0]);
    expect(routeMatchKey("/users", "/users/:id")).toBeUndefined();
    expect(routeMatchKey("/users/1/x", "/users/:id")).toBeUndefined();
  });
});

describe("next.js app router", () => {
  const next = { "package.json": pkg({ next: "^15" }) };

  it("route handlers: every export form, dynamic segments, groups and slots", () => {
    expect(
      routesOf({
        ...next,
        "app/route.ts": "export function GET() {}\n",
        "app/(api)/v1/items/[id]/route.ts": "export async function GET() {}\nexport const DELETE = async () => {};\nexport const revalidate = 60;\n",
        "src/app/x/route.js": "const h = () => {};\nexport { h as POST, h as PUT };\n",
        "app/auth/[...all]/route.ts": 'import { handlers } from "@/auth";\nexport const { GET, POST } = handlers;\n',
        "app/@slot/s/route.ts": "export function HEAD() {}\nexport function OPTIONS() {}\nexport function PATCH() {}\n",
      }),
    ).toEqual([
      "GET /v1/items/:id app/(api)/v1/items/[id]/route.ts:1 next-app GET",
      "DELETE /v1/items/:id app/(api)/v1/items/[id]/route.ts:2 next-app DELETE",
      "HEAD /s app/@slot/s/route.ts:1 next-app HEAD",
      "OPTIONS /s app/@slot/s/route.ts:2 next-app OPTIONS",
      "PATCH /s app/@slot/s/route.ts:3 next-app PATCH",
      "GET /auth/*all app/auth/[...all]/route.ts:2 next-app GET",
      "POST /auth/*all app/auth/[...all]/route.ts:2 next-app POST",
      "GET / app/route.ts:1 next-app GET",
      "POST /x src/app/x/route.js:2 next-app h",
      "PUT /x src/app/x/route.js:2 next-app h",
    ]);
  });

  it("pages, in a monorepo workspace", () => {
    expect(
      screensOf({
        "package.json": pkg({}),
        "apps/web/package.json": pkg({ next: "^15" }),
        "apps/web/app/page.tsx": "// home\nexport default function Home() {}\n",
        "apps/web/app/blog/[slug]/page.mdx": "# Post\n",
        "apps/web/src/app/settings/page.tsx": "export default function X() {}\n",
      }),
    ).toEqual([
      "/blog/:slug apps/web/app/blog/[slug]/page.mdx:1 next-app",
      "/ apps/web/app/page.tsx:2 next-app",
      "/settings apps/web/src/app/settings/page.tsx:1 next-app",
    ]);
  });

  describe("false-positive guards", () => {
    it("skips private folders, intercepting routes, non-route files, commented exports and non-method exports", () => {
      const files = {
        ...next,
        "app/_lib/route.ts": "export function GET() {}\n",
        "app/feed/(..)photo/[id]/page.tsx": "export default function P() {}\n",
        "app/feed/layout.tsx": "export default function L() {}\n",
        "app/feed/loading.tsx": "export default function L() {}\n",
        "app/api/a/route.ts": "// export function GET() {}\nexport const dynamic = 'force-static';\nexport function get() {}\n",
      };
      expect(routesOf(files)).toEqual([]);
      expect(screensOf(files)).toEqual([]);
    });

    it("needs next declared, and never reads tests or docs", () => {
      expect(routesOf({ "package.json": pkg({ react: "^19" }), "app/api/x/route.ts": "export function GET() {}\n" })).toEqual([]);
      expect(
        routesOf({
          ...next,
          "app/api/x/route.test.ts": "export function GET() {}\n",
          "app/api/x/README.md": "export function GET() {}\n",
          "app/api/x/route.d.ts": "export declare function GET(): void;\n",
        }),
      ).toEqual([]);
    });
  });
});

describe("next.js pages router", () => {
  const next = { "package.json": pkg({ next: "^14" }) };

  it("API routes: methods from req.method checks, else ALL", () => {
    expect(
      routesOf({
        ...next,
        "pages/api/users/[id].ts": [
          "export default async function handler(req, res) {",
          "  switch (req.method) {",
          '    case "GET": return res.json({});',
          "    case 'PUT': return res.end();",
          "  }",
          "}",
        ].join("\n"),
        "pages/api/login.js": 'export default function login(req, res) {\n  if ("POST" !== req.method) return res.status(405).end();\n}\n',
        "pages/api/multi.ts": 'const h = (req, res) => { if (!["GET", "DELETE"].includes(req.method)) res.end(); };\nexport default h;\n',
        "pages/api/index.ts": "export default (req, res) => res.end();\n",
        "src/pages/api/hook.ts": "export default function hook(req, res) { if (req.method === 'post') {} }\n",
      }),
    ).toEqual([
      "ALL /api pages/api/index.ts:1 next-pages",
      "POST /api/login pages/api/login.js:1 next-pages login",
      "DELETE /api/multi pages/api/multi.ts:2 next-pages h",
      "GET /api/multi pages/api/multi.ts:2 next-pages h",
      "GET /api/users/:id pages/api/users/[id].ts:1 next-pages handler",
      "PUT /api/users/:id pages/api/users/[id].ts:1 next-pages handler",
      "POST /api/hook src/pages/api/hook.ts:1 next-pages hook",
    ]);
  });

  it("pages are screens; _app, _document and _error are not", () => {
    expect(
      screensOf({
        ...next,
        "pages/index.tsx": "export default function Home() {}\n",
        "pages/posts/[...slug].tsx": "export default function Post() {}\n",
        "pages/_app.tsx": "export default function App() {}\n",
        "pages/_document.tsx": "export default function Doc() {}\n",
        "pages/_error.tsx": "export default function Err() {}\n",
        "pages/api/x.ts": "export default function x() {}\n",
      }),
    ).toEqual(["/ pages/index.tsx:1 next-pages", "/posts/*slug pages/posts/[...slug].tsx:1 next-pages"]);
  });

  it("a method name in a log string is not a check", () => {
    expect(routesOf({ ...next, "pages/api/x.ts": "export default function x(req, res) {\n  console.log(\"req.method === 'DELETE'\");\n}\n" })).toEqual([
      "ALL /api/x pages/api/x.ts:1 next-pages x",
    ]);
  });
});

describe("nuxt", () => {
  const nuxt = { "package.json": pkg({ nuxt: "^3" }) };

  it("server routes: api prefix, routes dir, method suffixes, params", () => {
    expect(
      routesOf({
        ...nuxt,
        "server/api/hello.ts": "export default defineEventHandler(() => 'hi');\n",
        "server/api/users/[id].put.ts": "\nexport default defineEventHandler(() => {});\n",
        "server/api/files/[...path].get.js": "export default eventHandler(() => {});\n",
        "server/routes/sitemap.xml.ts": "export default defineEventHandler(() => '');\n",
        "server/middleware/auth.ts": "export default defineEventHandler(() => {});\n",
      }),
    ).toEqual([
      "GET /api/files/*path server/api/files/[...path].get.js:1 nuxt",
      "ALL /api/hello server/api/hello.ts:1 nuxt",
      "PUT /api/users/:id server/api/users/[id].put.ts:2 nuxt",
      "ALL /sitemap.xml server/routes/sitemap.xml.ts:1 nuxt",
    ]);
  });

  it("pages: .vue files, optional params, Nuxt 4 app/ dir", () => {
    expect(
      screensOf({
        ...nuxt,
        "app/pages/index.vue": "<template><div/></template>\n",
        "app/pages/[[lang]]/about.vue": "<template><div/></template>\n",
        "pages/users/[id]/index.vue": "<template><div/></template>\n",
        "components/Card.vue": "<template><div/></template>\n",
      }),
    ).toEqual(["/:lang/about app/pages/[[lang]]/about.vue:1 nuxt", "/ app/pages/index.vue:1 nuxt", "/users/:id pages/users/[id]/index.vue:1 nuxt"]);
  });

  it("needs nuxt (or nitro) declared", () => {
    const files = { "package.json": pkg({ vue: "^3" }), "server/api/x.ts": "export default () => 1;\n", "pages/a.vue": "<template/>\n" };
    expect(routesOf(files)).toEqual([]);
    expect(screensOf(files)).toEqual([]);
    expect(routesOf({ "package.json": pkg({ nitropack: "^2" }), "server/routes/x.get.ts": "export default () => 1;\n" })).toEqual([
      "GET /x server/routes/x.get.ts:1 nuxt",
    ]);
  });
});

describe("sveltekit", () => {
  const kit = { "package.json": pkg({ "@sveltejs/kit": "^2" }) };

  it("+server handlers and +page.svelte screens, groups and matchers", () => {
    const files = {
      ...kit,
      "src/routes/+page.svelte": "<h1>Home</h1>\n",
      "src/routes/(app)/items/[id=integer]/+page.svelte": "<h1>Item</h1>\n",
      "src/routes/(app)/items/[id=integer]/+page.server.ts": "export const load = async () => ({});\n",
      "src/routes/api/items/+server.ts":
        "export const GET = async () => new Response();\nexport async function POST() {}\nexport const fallback = () => new Response();\n",
      "src/routes/api/[...rest]/+server.js": "export function DELETE() {}\n",
    };
    expect(routesOf(files)).toEqual([
      "DELETE /api/*rest src/routes/api/[...rest]/+server.js:1 sveltekit DELETE",
      "GET /api/items src/routes/api/items/+server.ts:1 sveltekit GET",
      "POST /api/items src/routes/api/items/+server.ts:2 sveltekit POST",
      "ALL /api/items src/routes/api/items/+server.ts:3 sveltekit fallback",
    ]);
    expect(screensOf(files)).toEqual(["/items/:id src/routes/(app)/items/[id=integer]/+page.svelte:1 sveltekit", "/ src/routes/+page.svelte:1 sveltekit"]);
  });

  it("needs @sveltejs/kit, and ignores commented handlers and non-route files", () => {
    expect(routesOf({ "package.json": pkg({ svelte: "^5" }), "src/routes/api/+server.ts": "export const GET = () => {};\n" })).toEqual([]);
    expect(
      routesOf({ ...kit, "src/routes/api/+server.ts": "/* export const GET = () => {}; */\n", "src/routes/api/helpers.ts": "export const GET = () => {};\n" }),
    ).toEqual([]);
  });
});

describe("remix / react router v7 flat routes", () => {
  const remix = { "package.json": pkg({ "@remix-run/react": "^2", "@remix-run/node": "^2" }) };

  it("loader → GET, action → POST, default export → screen", () => {
    const files = {
      ...remix,
      "app/routes/_index.tsx": "export default function Index() {}\n",
      "app/routes/users.$id.tsx": "export async function loader() {}\nexport const action = async () => {};\nexport default function User() {}\n",
      "app/routes/api.health.ts": "export const loader = () => new Response('ok');\n",
      "app/routes/_auth.login/route.tsx": "export default function Login() {}\n",
      "app/routes/_auth.login/form.tsx": "export default function Form() {}\n",
      "app/root.tsx": "export default function Root() {}\n",
    };
    expect(routesOf(files)).toEqual([
      "GET /api/health app/routes/api.health.ts:1 remix loader",
      "GET /users/:id app/routes/users.$id.tsx:1 remix loader",
      "POST /users/:id app/routes/users.$id.tsx:2 remix action",
    ]);
    expect(screensOf(files)).toEqual([
      "/login app/routes/_auth.login/route.tsx:1 remix",
      "/ app/routes/_index.tsx:1 remix",
      "/users/:id app/routes/users.$id.tsx:3 remix",
    ]);
  });

  it("react router v7 fs-routes counts; plain react-router does not, nor commented exports", () => {
    expect(screensOf({ "package.json": pkg({ "@react-router/fs-routes": "^7" }), "app/routes/about.tsx": "export default function A() {}\n" })).toEqual([
      "/about app/routes/about.tsx:1 remix",
    ]);
    expect(screensOf({ "package.json": pkg({ "react-router": "^7" }), "app/routes/about.tsx": "export default function A() {}\n" })).toEqual([]);
    expect(routesOf({ ...remix, "app/routes/x.tsx": "// export async function loader() {}\nconst s = 'export const action = 1';\n" })).toEqual([]);
  });
});
