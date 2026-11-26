import { describe, expect, it } from "vitest";
import { packageJsonDeps, pyprojectDeps, requirementsDeps } from "../src/extract/context.js";
import { memoryContext } from "./helpers.js";

describe("repo context", () => {
  it("reads every package.json dependency field", () => {
    expect(packageJsonDeps('{"dependencies":{"express":"4"},"devDependencies":{"vitest":"1"},"peerDependencies":{"react":"18"}}').sort()).toEqual([
      "express",
      "react",
      "vitest",
    ]);
    expect(packageJsonDeps("not json")).toEqual([]);
  });

  it("reads requirements and pyproject dependencies, normalized", () => {
    expect(requirementsDeps("# c\nFlask==3.0\n-r base.txt\nSQLAlchemy[asyncio]>=2 # orm\nhttps://x/y.whl\n")).toEqual(["flask", "sqlalchemy"]);
    const py = [
      "[project]",
      'name = "x"',
      "dependencies = [",
      '  "fastapi>=0.110",',
      '  "Pydantic_Settings",',
      "]",
      "[project.optional-dependencies]",
      'dev = ["pytest"]',
      "[tool.poetry.dependencies]",
      'python = "^3.12"',
      'celery = "^5"',
    ].join("\n");
    expect(pyprojectDeps(py).sort()).toEqual(["celery", "fastapi", "pydantic-settings", "pytest"]);
  });

  it("resolves the nearest workspace's dependencies", () => {
    const ctx = memoryContext({
      "package.json": '{"devDependencies":{"turbo":"1"}}',
      "apps/api/package.json": '{"dependencies":{"express":"4"}}',
      "apps/api/src/server.ts": "",
      "apps/web/src/main.ts": "",
      "services/py/requirements/base.txt": "flask\n",
      "services/py/app.py": "",
    });
    expect([...ctx.depsFor("apps/api/src/server.ts")]).toEqual(["express"]);
    expect([...ctx.depsFor("apps/web/src/main.ts")]).toEqual(["turbo"]);
    expect([...ctx.depsFor("services/py/app.py")]).toEqual(["flask"]);
    expect([...ctx.deps.keys()].sort()).toEqual(["", "apps/api", "services/py"]);
  });

  it("returns an empty set with no manifest at all", () => {
    expect(memoryContext({ "a.ts": "" }).depsFor("a.ts").size).toBe(0);
  });
});
