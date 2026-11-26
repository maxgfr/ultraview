import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { normalizePyUrl, pythonHttpExtractor } from "../src/extract/python-http.js";
import { memoryContext } from "./helpers.js";

function callsOf(files: Record<string, string>): string[] {
  const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
  return facts.calls.map((c) => `${c.method} ${c.url} ${c.file}:${c.line}${c.route ? ` ${c.route}` : ""}`);
}

const lines = (...l: string[]) => l.join("\n");
const DEPS = { "requirements.txt": "requests\nhttpx\n" };

describe("python http extractor", () => {
  it("reads requests module calls, request(), and Session instances", () => {
    const calls = callsOf({
      ...DEPS,
      "app/client.py": lines(
        "import os",
        "import requests",
        "API = os.environ['API_URL']",
        'requests.get("https://api.github.com/repos/o/r?per_page=1")',
        'requests.post(f"{API}/orders/{order_id}/pay", json=body)',
        'requests.request("delete", API + "/orders/" + str(order_id))',
        "s = requests.Session()",
        's.put(url=f"/users/{uid}#frag")',
        "with requests.Session() as session:",
        '    session.patch("/carts/1")',
      ),
    });
    expect(calls).toEqual([
      "GET https://api.github.com/repos/o/r app/client.py:4",
      "POST /orders/:p/pay app/client.py:5",
      "DELETE /orders/:p app/client.py:6",
      "PUT /users/:p app/client.py:8",
      "PATCH /carts/1 app/client.py:10",
    ]);
  });

  it("reads httpx calls and clients, prefixing literal base URLs and dropping config-based ones", () => {
    const calls = callsOf({
      ...DEPS,
      "app/svc.py": lines(
        "import httpx as hx",
        "from app.config import settings",
        'gh = hx.Client(base_url="https://api.github.com")',
        "internal = hx.Client(base_url=settings.INTERNAL_URL)",
        "async def f():",
        '    gh.get("/repos/o/r")',
        '    internal.post("orders")',
        '    async with hx.AsyncClient(base_url="https://api.stripe.com/v1/") as c:',
        '        await c.get(f"/charges/{cid}")',
        '    await hx.head("/ping")',
      ),
    });
    expect(calls).toEqual([
      "GET https://api.github.com/repos/o/r app/svc.py:6",
      "POST /orders app/svc.py:7",
      "GET https://api.stripe.com/v1/charges/:p app/svc.py:9",
      "HEAD /ping app/svc.py:10",
    ]);
  });

  it("normalizes URL templates", () => {
    expect(normalizePyUrl("/a/?q=1")).toBe("/a/:p");
    expect(normalizePyUrl("x/y")).toBeUndefined();
    expect(normalizePyUrl("x/y", "")).toBe("/x/y");
    expect(normalizePyUrl("/y", "https://h.io/v1/")).toBe("https://h.io/v1/y");
  });

  describe("false-positive guards", () => {
    it("ignores comments, docstrings, log strings, non-HTTP .get() and non-literal URLs", () => {
      const calls = callsOf({
        ...DEPS,
        "app/a.py": lines(
          "import requests",
          '# requests.get("/commented")',
          "def f(cfg, url):",
          '    """requests.post("/docstring")"""',
          "    log.info(\"requests.get('/logged')\")",
          '    cfg.get("/settings/key")',
          '    session.get("/unknown-session")',
          "    requests.get(url)",
          '    my.requests.get("/attribute")',
        ),
      });
      expect(calls).toEqual([]);
    });

    it("needs the library declared and imported, and skips tests and markdown", () => {
      const src = lines("import requests", 'requests.get("/x")');
      expect(pythonHttpExtractor.applies({ rel: "a.py", text: src }, memoryContext({ "requirements.txt": "flask\n", "a.py": src }))).toBe(false);
      expect(callsOf({ ...DEPS, "a.py": 'requests.get("/not-imported")' })).toEqual([]);
      expect(callsOf({ ...DEPS, "tests/test_a.py": src, "docs/a.md": src })).toEqual([]);
    });
  });
});
