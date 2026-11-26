import { describe, expect, it } from "vitest";
import { actionPath, hasDirective, procedureMethod } from "../src/extract/rpc.js";
import { factsOfFiles } from "./helpers.js";

const lines = (...l: string[]) => l.join("\n");
const pkg = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });
const TRPC = pkg({ next: "15", "@trpc/server": "11", "@trpc/react-query": "11", "@trpc/client": "11" });

function rpcOf(files: Record<string, string>) {
  const facts = factsOfFiles(files);
  return {
    routes: facts.routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line} ${r.framework}`),
    calls: facts.calls.map((c) => `${c.method} ${c.url} ${c.file}:${c.line} -> ${c.route ?? "-"}`),
  };
}

const TRPC_INIT = lines(
  'import { initTRPC } from "@trpc/server";',
  "const t = initTRPC.create();",
  "export const createTRPCRouter = t.router;",
  "export const publicProcedure = t.procedure;",
  "export const protectedProcedure = t.procedure.use(auth);",
);

describe("tRPC routers", () => {
  it("composes routers by key across files into dotted procedure paths with their method", () => {
    const { routes } = rpcOf({
      "package.json": TRPC,
      "src/server/api/trpc.ts": TRPC_INIT,
      "src/server/api/routers/user.ts": lines(
        'import { z } from "zod";',
        'import { createTRPCRouter, protectedProcedure, publicProcedure } from "~/server/api/trpc";',
        "",
        "export const userRouter = createTRPCRouter({",
        "  byId: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {",
        "    return ctx.db.query.users.findFirst();",
        "  }),",
        "  update: protectedProcedure",
        "    .input(z.object({ name: z.string() }))",
        "    .mutation(async ({ ctx }) => ctx.db.update(users)),",
        "  onChange: publicProcedure.subscription(() => observable(() => {})),",
        "  settings: createTRPCRouter({",
        "    get: protectedProcedure.query(() => null),",
        "  }),",
        "});",
      ),
      "src/server/api/routers/post.ts": lines(
        'import { router, publicProcedure } from "../trpc";',
        "const comments = router({ list: publicProcedure.query(() => []) });",
        "export const postRouter = router({",
        "  all: publicProcedure.query(() => []),",
        "  comments,",
        "});",
      ),
      "src/server/api/root.ts": lines(
        'import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";',
        'import { userRouter } from "~/server/api/routers/user";',
        'import { postRouter as posts } from "./routers/post";',
        "export const appRouter = createTRPCRouter({",
        "  health: publicProcedure.query(() => 'ok'),",
        "  user: userRouter,",
        "  post: posts,",
        "});",
        "export type AppRouter = typeof appRouter;",
      ),
    });
    expect(routes).toEqual([
      "QUERY health src/server/api/root.ts:5 trpc",
      "QUERY post.comments.list src/server/api/routers/post.ts:2 trpc",
      "QUERY post.all src/server/api/routers/post.ts:4 trpc",
      "QUERY user.byId src/server/api/routers/user.ts:5 trpc",
      "MUTATION user.update src/server/api/routers/user.ts:8 trpc",
      "SUBSCRIPTION user.onChange src/server/api/routers/user.ts:11 trpc",
      "QUERY user.settings.get src/server/api/routers/user.ts:13 trpc",
    ]);
  });

  it("merges routers with mergeRouters and serves a default-exported router under its key", () => {
    const { routes } = rpcOf({
      "package.json": TRPC,
      "server/a.ts": lines('import { t } from "./t";', "export default t.router({ ping: t.procedure.query(() => 1) });"),
      "server/b.ts": lines('import { t } from "./t";', "export const b = t.router({ save: t.procedure.input(x).mutation(() => 1) });"),
      "server/t.ts": lines('import { initTRPC } from "@trpc/server";', "export const t = initTRPC.create();"),
      "server/root.ts": lines(
        'import { t } from "./t";',
        'import a from "./a";',
        'import { b } from "./b";',
        "const inner = t.mergeRouters(a, b);",
        "export const appRouter = t.router({ v1: inner });",
      ),
    });
    expect(routes).toEqual(["QUERY v1.ping server/a.ts:2 trpc", "MUTATION v1.save server/b.ts:2 trpc"]);
  });

  it("reads a procedure's method from its builder chain", () => {
    expect(procedureMethod("publicProcedure.input(z.object({ q: z.string().query() })).query(() => 1)")).toBe("QUERY");
    expect(procedureMethod("t.procedure.mutation(() => 1)")).toBe("MUTATION");
    expect(procedureMethod("authed.use(mw).subscription(() => 1)")).toBe("SUBSCRIPTION");
    expect(procedureMethod("db.query(sql)")).toBeUndefined();
    expect(procedureMethod("something.else()")).toBeUndefined();
  });

  describe("false-positive guards", () => {
    it("no routes without an @trpc dependency, from non-procedure values, comments or tests", () => {
      const router = lines(
        'import { router, publicProcedure } from "./trpc";',
        "export const appRouter = router({",
        "  // old: publicProcedure.query(() => 1),",
        "  limit: 10,",
        "  name: 'x',",
        "  fetcher: db.query(sql),",
        "  ok: publicProcedure.query(() => 1),",
        "});",
      );
      expect(rpcOf({ "package.json": pkg({ next: "15" }), "src/server/root.ts": router }).routes).toEqual([]);
      expect(rpcOf({ "package.json": TRPC, "src/server/root.ts": router, "src/server/root.test.ts": router }).routes).toEqual([
        "QUERY ok src/server/root.ts:7 trpc",
      ]);
      // A vue-router-like table in a tRPC workspace yields nothing.
      expect(rpcOf({ "package.json": TRPC, "src/router.ts": "export const r = createRouter({ history: createWebHistory(), routes });" }).routes).toEqual([]);
    });
  });
});

describe("tRPC calls", () => {
  const server = {
    "package.json": TRPC,
    "src/server/api/trpc.ts": TRPC_INIT,
    "src/server/api/root.ts": lines(
      'import { createTRPCRouter, publicProcedure, protectedProcedure } from "./trpc";',
      "export const appRouter = createTRPCRouter({",
      "  user: createTRPCRouter({",
      "    byId: publicProcedure.query(() => null),",
      "    update: protectedProcedure.mutation(() => null),",
      "  }),",
      "  company: createTRPCRouter({ get: publicProcedure.query(() => null) }),",
      "});",
    ),
  };

  it("hooks, vanilla calls, options helpers and server-side callers; matched to routes by exact path", () => {
    const { calls } = rpcOf({
      ...server,
      "src/app/profile/Profile.tsx": lines(
        '"use client";',
        'import { api } from "~/trpc/react";',
        "export function Profile({ id }) {",
        "  const user = api.user.byId.useQuery({ id });",
        "  const update = api.user.update.useMutation();",
        "  const utils = api.useUtils();",
        "  void utils.user.byId.invalidate();",
        "  void api.user.byId.invalidate;",
        "  return null;",
        "}",
      ),
      "src/app/page.tsx": lines(
        'import { api } from "~/trpc/server";',
        "export default async function Page() {",
        "  const company = await api.company.get();",
        "  const missing = await api.nothing.here();",
        "  void api.user.byId.prefetch({ id: 1 });",
        "  return null;",
        "}",
      ),
      "src/lib/vanilla.ts": lines(
        'import { createTRPCClient } from "@trpc/client";',
        "const client = createTRPCClient({ links: [] });",
        "export const save = () => client.user.update.mutate({ name: 'x' });",
        "export const nope = () => client.user.nope.query();",
      ),
      "src/trpc/react.tsx": lines('import { createTRPCReact } from "@trpc/react-query";', "export const api = createTRPCReact();"),
    });
    expect(calls).toEqual([
      "QUERY company.get src/app/page.tsx:3 -> route:QUERY company.get",
      "QUERY user.byId src/app/page.tsx:5 -> route:QUERY user.byId",
      "QUERY user.byId src/app/profile/Profile.tsx:4 -> route:QUERY user.byId",
      "MUTATION user.update src/app/profile/Profile.tsx:5 -> route:MUTATION user.update",
      "MUTATION user.update src/lib/vanilla.ts:3 -> route:MUTATION user.update",
      "QUERY user.nope src/lib/vanilla.ts:4 -> -",
    ]);
  });

  describe("false-positive guards", () => {
    it("ignores `api` objects not imported from a local module, cache helpers, comments and HTTP-style calls", () => {
      const { calls } = rpcOf({
        ...server,
        "src/app/a.tsx": lines('import api from "some-sdk";', "api.user.byId.useQuery();", "api.company.get();"),
        "src/app/b.tsx": lines(
          'import { api } from "~/trpc/react";',
          "// api.user.byId.useQuery()",
          "const s = 'api.user.update.useMutation()';",
          "api.user.byId.setData(undefined, null);",
          'api.get("/x");',
        ),
      });
      expect(calls).toEqual([]);
    });
  });
});

describe("Next server actions", () => {
  const NEXT = pkg({ next: "15", react: "19" });

  it("routes every export of a 'use server' module and inline 'use server' functions; calls from forms, hooks and handlers", () => {
    const { routes, calls } = rpcOf({
      "package.json": NEXT,
      "src/app/actions.ts": lines(
        "// Server actions for the profile page.",
        '"use server";',
        'import { db } from "@/db";',
        "export async function save(form: FormData) {",
        "  await db.insert(form);",
        "}",
        "export const remove = async (id: string) => db.delete(id);",
        "async function internal() {}",
        "export { internal as archive };",
        "export type State = { ok: boolean };",
      ),
      "src/app/profile/Form.tsx": lines(
        "'use client';",
        'import { useActionState } from "react";',
        'import { save, remove, archive } from "../actions";',
        'import { format } from "@/lib/format";',
        "export function Form() {",
        "  const [state, run] = useActionState(save, null);",
        "  return (",
        "    <form action={save}>",
        "      <button formAction={remove.bind(null, '1')}>x</button>",
        "      <button onClick={() => archive()}>a</button>",
        "      {format(state)}",
        "    </form>",
        "  );",
        "}",
      ),
      "src/lib/format.ts": "export function format(x) { return String(x); }",
      "src/app/inline/page.tsx": lines(
        "export default function Page() {",
        "  async function subscribe(data: FormData) {",
        '    "use server";',
        "    await db.insert(data);",
        "  }",
        "  const later = async () => {",
        "    'use server';",
        "  };",
        "  return <form action={subscribe} />;",
        "}",
      ),
    });
    expect(routes).toEqual([
      "ACTION src/app/actions#save src/app/actions.ts:4 next-action",
      "ACTION src/app/actions#remove src/app/actions.ts:7 next-action",
      "ACTION src/app/actions#archive src/app/actions.ts:9 next-action",
      "ACTION src/app/inline/page#subscribe src/app/inline/page.tsx:2 next-action",
      "ACTION src/app/inline/page#later src/app/inline/page.tsx:6 next-action",
    ]);
    expect(calls).toEqual([
      "ACTION src/app/inline/page#subscribe src/app/inline/page.tsx:9 -> route:ACTION src/app/inline/page#subscribe",
      "ACTION src/app/actions#save src/app/profile/Form.tsx:6 -> route:ACTION src/app/actions#save",
      "ACTION src/app/actions#save src/app/profile/Form.tsx:8 -> route:ACTION src/app/actions#save",
      "ACTION src/app/actions#remove src/app/profile/Form.tsx:9 -> route:ACTION src/app/actions#remove",
      "ACTION src/app/actions#archive src/app/profile/Form.tsx:10 -> route:ACTION src/app/actions#archive",
    ]);
  });

  it("resolves default and namespace imports through the @/ alias", () => {
    const { calls } = rpcOf({
      "package.json": NEXT,
      "src/actions/login.ts": lines("'use server'", "export default async function login(form) {}"),
      "src/actions/user.ts": lines('"use server";', "export async function rename(id, name) {}"),
      "src/components/Login.tsx": lines(
        'import login from "@/actions/login";',
        'import * as user from "@/actions/user";',
        "export const Login = () => <form action={login} onSubmit={() => user.rename(1, 'x')} />;",
      ),
    });
    expect(calls).toEqual([
      "ACTION src/actions/login#default src/components/Login.tsx:3 -> route:ACTION src/actions/login#default",
      "ACTION src/actions/user#rename src/components/Login.tsx:3 -> route:ACTION src/actions/user#rename",
    ]);
  });

  it("reads directives and action paths", () => {
    expect(hasDirective('\n  \n"use server";\nexport async function a() {}', "use server")).toBe(true);
    expect(hasDirective("'use strict';\n'use server'\n", "use server")).toBe(true);
    expect(hasDirective('import x from "y";\n"use server";', "use server")).toBe(false);
    expect(actionPath("app/actions.ts", "save")).toBe("app/actions#save");
  });

  it("server-only modules call actions in-process: only their forms count", () => {
    const { calls } = rpcOf({
      "package.json": NEXT,
      "src/app/actions.ts": lines('"use server";', "export async function load() {}", "export async function save() {}"),
      "src/app/page.tsx": lines(
        'import { load, save } from "./actions";',
        "export default async function Page() {",
        "  const data = await load();",
        "  return <form action={save}>{String(data)}</form>;",
        "}",
      ),
      "src/app/Stats.tsx": lines('import { load } from "./actions";', "export const Stats = async () => <p>{await load()}</p>;"),
      "src/app/only.ts": lines('import "server-only";', 'import { load } from "./actions";', "export const get = () => load();"),
      "src/app/Client.tsx": lines('"use client";', 'import { load } from "./actions";', "export default async function C() { await load(); }"),
    });
    expect(calls).toEqual([
      "ACTION src/app/actions#load src/app/Client.tsx:3 -> route:ACTION src/app/actions#load",
      "ACTION src/app/actions#save src/app/page.tsx:4 -> route:ACTION src/app/actions#save",
    ]);
  });

  describe("false-positive guards", () => {
    it("no actions without next, from a directive that is not first, a string mentioning it, or calls between server modules", () => {
      const actions = lines('"use server";', "export async function save() {}");
      expect(rpcOf({ "package.json": pkg({ react: "19" }), "src/actions.ts": actions }).routes).toEqual([]);
      const { routes, calls } = rpcOf({
        "package.json": NEXT,
        "src/actions.ts": actions,
        "src/late.ts": lines('import "x";', '"use server";', "export async function nope() {}"),
        "src/log.ts": lines('export function log() { console.log("use server"); }', "export const s = { a: 'use server' };"),
        "src/other-actions.ts": lines('"use server";', 'import { save } from "./actions";', "export async function both() { await save(); }"),
        "src/client.tsx": lines('import { save } from "./actions";', "// save()", "const label = 'save()';", "function save2() {}"),
      });
      expect(routes).toEqual(["ACTION src/actions#save src/actions.ts:2 next-action", "ACTION src/other-actions#both src/other-actions.ts:3 next-action"]);
      expect(calls).toEqual([]);
    });
  });
});
