import { describe, expect, it } from "vitest";
import { factsOfFiles } from "./helpers.js";

const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

function screensOf(files: Record<string, string>): string[] {
  return factsOfFiles(files).screens.map((s) => `${s.path} ${s.file}:${s.line} ${s.framework}`);
}

describe("react router", () => {
  const rr = { "package.json": pkg({ "react-router-dom": "^6" }) };

  it("object tables: createBrowserRouter, named tables, nested children, index routes, redirects skipped", () => {
    expect(
      screensOf({
        ...rr,
        "src/router.tsx": [
          'import { createBrowserRouter, Navigate } from "react-router-dom";',
          "const routes = [",
          "  {",
          '    path: "/",',
          "    element: <Layout />,",
          "    children: [",
          "      { index: true, element: <Home /> },",
          '      { path: "products/:id", Component: Product },',
          '      { path: "/absolute", lazy: () => import("./Absolute") },',
          '      { path: "old", element: <Navigate to="/" /> },',
          "    ],",
          "  },",
          '  { path: "*", element: <NotFound /> },',
          "];",
          "export const router = createBrowserRouter(routes);",
        ].join("\n"),
      }),
    ).toEqual([
      "/ src/router.tsx:3 react-router",
      "/ src/router.tsx:7 react-router",
      "/products/:id src/router.tsx:8 react-router",
      "/absolute src/router.tsx:9 react-router",
      "/* src/router.tsx:13 react-router",
    ]);
  });

  it("JSX <Route> trees, nested paths joined, pathless layouts pass through", () => {
    expect(
      screensOf({
        ...rr,
        "src/App.tsx": [
          'import { Route, Routes } from "react-router-dom";',
          "export function App() {",
          "  return (",
          "    <Routes>",
          '      <Route path="/" element={<Home />} />',
          "      <Route element={<AuthLayout />}>",
          '        <Route path="settings" element={<Settings />}>',
          '          <Route path="profile" element={<Profile title="path=\\"nope\\"" />} />',
          "          <Route index element={<SettingsHome />} />",
          "        </Route>",
          "      </Route>",
          '      <Route path={"/about"} Component={About} />',
          '      <Route path="/legacy" element={<Navigate to="/" />} />',
          "    </Routes>",
          "  );",
          "}",
        ].join("\n"),
      }),
    ).toEqual([
      "/ src/App.tsx:5 react-router",
      "/settings src/App.tsx:7 react-router",
      "/settings/profile src/App.tsx:8 react-router",
      "/settings src/App.tsx:9 react-router",
      "/about src/App.tsx:12 react-router",
    ]);
  });

  it("typed RouteObject[] tables", () => {
    expect(
      screensOf({
        ...rr,
        "src/routes.ts": 'import type { RouteObject } from "react-router-dom";\nexport const routes: RouteObject[] = [{ path: "/a", element: null }];\n',
      }),
    ).toEqual(["/a src/routes.ts:2 react-router"]);
  });

  describe("false-positive guards", () => {
    it("needs react-router declared and imported; ignores comments, strings and tests", () => {
      const table = 'createBrowserRouter([{ path: "/x", element: <X /> }]);\n<Route path="/y" element={<Y />} />;\n';
      expect(screensOf({ "package.json": pkg({ react: "^19" }), "src/a.tsx": `import { createBrowserRouter } from "react-router-dom";\n${table}` })).toEqual(
        [],
      );
      expect(screensOf({ ...rr, "src/a.tsx": table })).toEqual([]);
      expect(
        screensOf({
          ...rr,
          "src/a.tsx":
            'import { Route } from "react-router-dom";\n// <Route path="/commented" element={<C />} />\nconst s = \'<Route path="/str" element={<S />} />\';\n',
          "src/a.test.tsx": `import { createBrowserRouter } from "react-router-dom";\n${table}`,
        }),
      ).toEqual([]);
    });
  });
});

describe("vue router", () => {
  const vr = { "package.json": pkg({ vue: "^3", "vue-router": "^4" }) };

  it("createRouter({ routes }), named tables, children, param patterns, redirects skipped", () => {
    expect(
      screensOf({
        ...vr,
        "src/router/index.ts": [
          'import { createRouter, createWebHistory } from "vue-router";',
          "const routes = [",
          '  { path: "/", component: Home },',
          '  { path: "/users/:id(\\\\d+)", component: () => import("../views/User.vue"),',
          '    children: [{ path: "posts", components: { default: Posts } }] },',
          '  { path: "/home", redirect: "/" },',
          '  { path: "/:pathMatch(.*)*", component: NotFound },',
          "];",
          "export default createRouter({ history: createWebHistory(), routes });",
        ].join("\n"),
        "src/admin/routes.ts":
          'import type { RouteRecordRaw } from "vue-router";\nexport const adminRoutes: RouteRecordRaw[] = [{ path: "/admin", component: Admin }];\n',
      }),
    ).toEqual([
      "/admin src/admin/routes.ts:2 vue-router",
      "/ src/router/index.ts:3 vue-router",
      "/users/:id src/router/index.ts:4 vue-router",
      "/users/:id/posts src/router/index.ts:5 vue-router",
      "/*pathMatch src/router/index.ts:7 vue-router",
    ]);
  });

  it("needs vue-router declared and referenced", () => {
    expect(
      screensOf({
        "package.json": pkg({ vue: "^3" }),
        "src/r.ts": 'import { createRouter } from "vue-router";\ncreateRouter({ routes: [{ path: "/x", component: X }] });\n',
      }),
    ).toEqual([]);
    expect(screensOf({ ...vr, "src/r.ts": 'const routes = [{ path: "/x", component: X }];\nexport default routes;\n' })).toEqual([]);
  });
});
