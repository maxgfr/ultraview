import { describe, expect, it } from "vitest";
import { matchCallRoute, normalizeUrl } from "../src/extract/http-calls.js";
import { joinBaseUrl } from "../src/extract/urls.js";
import type { RouteFact } from "../src/extract/types.js";
import { factsOfFiles } from "./helpers.js";

const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

function callsOf(files: Record<string, string>): string[] {
  return factsOfFiles(files).calls.map((c) => `${c.method} ${c.url} ${c.file}:${c.line}${c.route ? ` -> ${c.route}` : ""}`);
}

describe("URL normalisation", () => {
  it("templates, concatenation, bases, hosts, query and hash", () => {
    const consts = new Map([["BASE", "/api/v1"]]);
    expect(normalizeUrl("'/api/users'")).toBe("/api/users");
    expect(normalizeUrl("`/api/users/${id}/orders/${orderId}`")).toBe("/api/users/:p/orders/:p");
    expect(normalizeUrl("`/files/${name}.json`")).toBe("/files/:p");
    expect(normalizeUrl("'/api/users/' + id + '/avatar'")).toBe("/api/users/:p/avatar");
    expect(normalizeUrl("`${process.env.NEXT_PUBLIC_API_URL}/api/users`")).toBe("/api/users");
    expect(normalizeUrl("`${import.meta.env.VITE_API}/items?page=${p}`")).toBe("/items");
    expect(normalizeUrl("`${BASE}/users/`", consts)).toBe("/api/v1/users");
    expect(normalizeUrl("BASE + '/x'", consts)).toBe("/api/v1/x");
    expect(normalizeUrl("'http://localhost:3000/api/x#top'")).toBe("/api/x");
    expect(normalizeUrl("`${proto}://${host}/api/x`")).toBe("/api/x");
    expect(normalizeUrl("'https://API.Example.com/v1/charges/'")).toBe("https://api.example.com/v1/charges");
    expect(normalizeUrl("() => `/api/p/${route.params.id}`")).toBe("/api/p/:p");
    expect(normalizeUrl("'/'")).toBe("/");
    expect(normalizeUrl("'users'")).toBe("users");
    expect(normalizeUrl("url")).toBeUndefined();
    expect(normalizeUrl("`${url}`")).toBeUndefined();
  });

  it("joins client bases like axios / ky / ofetch", () => {
    expect(joinBaseUrl("/api", "/users")).toBe("/api/users");
    expect(joinBaseUrl("/api", "users")).toBe("/api/users");
    // No base: a relative URL means nothing. A dropped (non-literal) base "": the URL is a path of the app.
    expect(joinBaseUrl(undefined, "/users")).toBe("/users");
    expect(joinBaseUrl(undefined, "users")).toBeUndefined();
    expect(joinBaseUrl("", "users")).toBe("/users");
    expect(joinBaseUrl("https://api.github.com", "/repos/:p")).toBe("https://api.github.com/repos/:p");
    expect(joinBaseUrl("/api", "https://other.dev/x")).toBe("https://other.dev/x");
  });
});

describe("call sites", () => {
  it("fetch: method from init, default GET, window./globalThis. forms", () => {
    expect(
      callsOf({
        "package.json": pkg({ react: "^19" }),
        "src/api.ts": [
          "export async function load(id: string) {",
          "  await fetch(`/api/items/${id}`);",
          '  await window.fetch("/api/items", { method: "post", body });',
          "  await globalThis.fetch('/api/items/' + id, { method: 'DELETE' });",
          "  await fetch(new Request('/x'));",
          "  await fetch(url);",
          "}",
        ].join("\n"),
      }),
    ).toEqual(["GET /api/items/:p src/api.ts:2", "POST /api/items src/api.ts:3", "DELETE /api/items/:p src/api.ts:4"]);
  });

  it("axios: verbs, config calls, request(), same-file instances with a baseURL", () => {
    expect(
      callsOf({
        "package.json": pkg({ axios: "^1" }),
        "src/client.ts": [
          'import axios from "axios";',
          'const api = axios.create({ baseURL: "/api/v2", timeout: 1000 });',
          'const gh = axios.create({ baseURL: "https://api.github.com" });',
          "axios.get<User[]>('/api/users');",
          "axios.post(`/api/users/${id}/ban`, {});",
          "axios({ url: '/api/reports', method: 'put' });",
          "axios.request({ method: 'PATCH', url: '/api/flags' });",
          "api.delete(`/orders/${id}`);",
          "api('/ping');",
          'gh.get("/repos/o/r");',
        ].join("\n"),
      }),
    ).toEqual([
      "GET /api/users src/client.ts:4",
      "POST /api/users/:p/ban src/client.ts:5",
      "PUT /api/reports src/client.ts:6",
      "PATCH /api/flags src/client.ts:7",
      "DELETE /api/v2/orders/:p src/client.ts:8",
      "GET /api/v2/ping src/client.ts:9",
      "GET https://api.github.com/repos/o/r src/client.ts:10",
    ]);
  });

  it("instances exported from another module, imported by path or alias, through the linker", () => {
    expect(
      callsOf({
        "package.json": pkg({ axios: "^1", ky: "^1" }),
        "src/lib/http.ts": 'import axios from "axios";\nexport const http = axios.create({ baseURL: `${process.env.API_URL}/api` });\n',
        "src/lib/kyc.ts": 'import ky from "ky";\nconst client = ky.create({ prefixUrl: "/backend" });\nexport default client;\n',
        "src/lib/other.ts": "export const notHttp = { get: (k: string) => k };\n",
        "src/pages/users.ts": [
          'import { http } from "@/lib/http";',
          'import client from "../lib/kyc";',
          'import { notHttp } from "./../lib/other";',
          "http.get(`/users/${id}`);",
          'client.post("orders");',
          'notHttp.get("/not-a-call");',
        ].join("\n"),
      }),
    ).toEqual(["GET /api/users/:p src/pages/users.ts:4", "POST /backend/orders src/pages/users.ts:5"]);
  });

  it("ky, ofetch and Nuxt's $fetch / useFetch", () => {
    expect(
      callsOf({
        "package.json": pkg({ ky: "^1", ofetch: "^1" }),
        "src/a.ts":
          'import ky from "ky";\nimport { ofetch } from "ofetch";\nky.get("/api/a");\nky("/api/b", { method: "DELETE" });\nofetch("/api/c", { method: "POST" });\nconst o = ofetch.create({ baseURL: "/svc" });\no("/d");\n',
      }),
    ).toEqual(["GET /api/a src/a.ts:3", "DELETE /api/b src/a.ts:4", "POST /api/c src/a.ts:5", "GET /svc/d src/a.ts:7"]);
    expect(
      callsOf({
        "package.json": pkg({ nuxt: "^3" }),
        "pages/x.vue":
          '<script setup>\nconst { data } = await useFetch(`/api/x/${id}`, { method: "GET" });\nawait $fetch("/api/y", { method: "PUT" });\nconst z = await useLazyFetch("/api/z");\n</script>\n<template><p @click="$fetch(\'/api/template\')">Don\'t</p></template>\n',
      }),
    ).toEqual(["GET /api/x/:p pages/x.vue:2", "PUT /api/y pages/x.vue:3", "GET /api/z pages/x.vue:4"]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, strings, logs, markdown, tests, and fetch-named methods on other objects", () => {
      expect(
        callsOf({
          "package.json": pkg({ axios: "^1" }),
          "src/a.ts": [
            '// fetch("/api/commented");',
            '/* axios.get("/api/blocked") */',
            "console.log(\"fetch('/api/in-log')\");",
            'cache.fetch("/api/cache-method");',
            'router.get("/api/express-route", h);',
            "const worker = { async fetch(request) { return new Response(); } };",
            "function fetch(x) { return x; }",
            'fetch("relative/path");',
          ].join("\n"),
          "src/a.test.ts": 'fetch("/api/test-only");',
          "docs/usage.md": 'fetch("/api/docs-only")',
        }),
      ).toEqual([]);
    });

    it("library calls need the library declared", () => {
      expect(
        callsOf({
          "package.json": pkg({}),
          "src/a.ts": 'import axios from "axios";\naxios.get("/api/x");\nky.get("/api/y");\n$fetch("/api/z");\nuseFetch("/api/w");\n',
        }),
      ).toEqual([]);
    });
  });
});

describe("http-calls linker", () => {
  const route = (method: string, path: string): RouteFact => ({ method, path, file: "r.ts", line: 1, framework: "express" });

  it("matches by method and pattern, most specific route first, ALL as a fallback", () => {
    const routes = [
      route("GET", "/users/:id"),
      route("GET", "/users/me"),
      route("ALL", "/users/:id"),
      route("GET", "/files/*path"),
      route("POST", "/files/upload"),
    ];
    expect(matchCallRoute({ method: "GET", url: "/users/me" }, routes)?.path).toBe("/users/me");
    expect(matchCallRoute({ method: "GET", url: "/users/:p" }, routes)?.path).toBe("/users/:id");
    expect(matchCallRoute({ method: "DELETE", url: "/users/:p" }, routes)).toMatchObject({ method: "ALL", path: "/users/:id" });
    expect(matchCallRoute({ method: "GET", url: "/files/a/b" }, routes)?.path).toBe("/files/*path");
    expect(matchCallRoute({ method: "POST", url: "/files/upload" }, routes)?.path).toBe("/files/upload");
    expect(matchCallRoute({ method: "PUT", url: "/files/upload" }, routes)).toBeUndefined();
    expect(matchCallRoute({ method: "GET", url: "https://api.example.com/users/me" }, routes)).toBeUndefined();
  });

  it("links calls across workspaces, and leaves unmatched calls alone", () => {
    expect(
      callsOf({
        "apps/api/package.json": pkg({ express: "^4" }),
        "apps/api/src/server.ts": 'import express from "express";\nconst app = express();\napp.get("/api/orders/:id", show);\n',
        "apps/web/package.json": pkg({ react: "^19" }),
        "apps/web/src/order.ts": "fetch(`/api/orders/${id}`);\nfetch('/api/unknown');\n",
      }),
    ).toEqual(["GET /api/orders/:p apps/web/src/order.ts:1 -> route:GET /api/orders/:id", "GET /api/unknown apps/web/src/order.ts:2"]);
  });

  it("links Python requests / httpx calls (and JS calls) to FastAPI routes", () => {
    expect(
      callsOf({
        "api/pyproject.toml": '[project]\nname = "api"\ndependencies = ["fastapi", "requests", "httpx"]\n',
        "api/app/main.py": [
          "from fastapi import APIRouter, FastAPI",
          "app = FastAPI()",
          'router = APIRouter(prefix="/api/orders")',
          '@router.get("/{order_id}")',
          "def show(order_id: int): ...",
          '@router.post("")',
          "def create(): ...",
          "app.include_router(router)",
        ].join("\n"),
        "api/app/worker.py": [
          "import httpx",
          "import requests",
          "def sync(order_id):",
          '    requests.get(f"http://localhost:8000/api/orders/{order_id}")',
          '    httpx.post("/api/orders", json={})',
          '    requests.get("/api/elsewhere")',
        ].join("\n"),
        "web/package.json": pkg({ react: "^19" }),
        "web/src/order.ts": "fetch(`/api/orders/${id}`);\n",
      }),
    ).toEqual([
      "GET /api/orders/:p api/app/worker.py:4 -> route:GET /api/orders/:order_id",
      "POST /api/orders api/app/worker.py:5 -> route:POST /api/orders",
      "GET /api/elsewhere api/app/worker.py:6",
      "GET /api/orders/:p web/src/order.ts:1 -> route:GET /api/orders/:order_id",
    ]);
  });
});
