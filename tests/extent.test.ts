import { describe, expect, it } from "vitest";
import { blankOrCommentOnly, extentFinder, lastLine } from "../src/extract/extent.js";

const lines = (...xs: string[]) => xs.join("\n");

describe("fact extents", () => {
  it("js: a call statement up to its closing parenthesis, chain links stop before the next link", () => {
    const text = lines(
      'app.get("/a", (req, res) => {', // 1
      "  res.send(1)", // 2
      "})", // 3
      'app.post("/b", h)', // 4
      "router", // 5
      '  .route("/c")', // 6
      "  .get(h)", // 7
      "  .post((req, res) => {", // 8
      "    res.send(2)", // 9
      "  })", // 10
      "", // 11
      "// trailing comment", // 12
    );
    const end = extentFinder("src/app.ts", text);
    expect([1, 4, 5, 7, 8].map(end)).toEqual([3, 4, 10, 7, 10]);
  });

  it("js: decorators run to the decorated declaration; an enclosing closer ends the statement", () => {
    const text = lines(
      "export class C {", // 1
      '  @Get(":id")', // 2
      "  @HttpCode(200)", // 3
      "  find(@Param() id: string) {", // 4
      "    return id;", // 5
      "  }", // 6
      "", // 7
      "  @Delete()", // 8
      "  remove() {}", // 9
      "}", // 10
      "const routes = [", // 11
      '  { path: "/a", element: <A />,', // 12
      "    loader: load },", // 13
      '  { path: "/b" }', // 14
      "];", // 15
    );
    const end = extentFinder("src/c.tsx", text);
    expect([1, 2, 8, 12, 14].map(end)).toEqual([10, 6, 9, 13, 14]);
  });

  it("js: operators and arrows carry a statement to the next line", () => {
    const text = lines("export const GET = async () =>", "  fetch(url)", "    .then((r) => r.json());", "export const POST = h;");
    const end = extentFinder("src/route.ts", text);
    expect([1, 4].map(end)).toEqual([3, 4]);
  });

  it("python: decorators, the header's indented block, docstrings and trailing blanks aside", () => {
    const text = lines(
      '@router.get("/a")', // 1
      "def a(", // 2
      "    x: int,", // 3
      "):", // 4
      '    """Doc."""', // 5
      "    return x", // 6
      "", // 7
      "", // 8
      "urlpatterns = [", // 9
      '    path("a/", a),', // 10
      "]", // 11
    );
    const end = extentFinder("app/routes.py", text);
    expect([1, 9, 10].map(end)).toEqual([6, 11, 10]);
  });

  it("yaml: the line and every deeper-indented line; sql: up to `;` or a blank line", () => {
    const yaml = lines("on:", "  schedule:", '    - cron: "0 3 * * *"', "      tz: UTC", '    - cron: "0 4 * * *"', "jobs: {}");
    expect([3, 5].map(extentFinder(".github/workflows/x.yml", yaml))).toEqual([4, 5]);
    const sql = lines("CREATE TABLE a (", "  id INT -- the key; not the end", ");", "CREATE TABLE b (", "  id INT", ")", "", "SELECT 1;");
    expect([1, 4].map(extentFinder("db/init.sql", sql))).toEqual([3, 6]);
  });

  it("other files: the line itself; blank or comment-only stretches are told apart", () => {
    expect(extentFinder("README.md", "a\nb\n")(1)).toBe(1);
    expect(lastLine("a\nb\n\n")).toBe(2);
    const quiet = blankOrCommentOnly("src/a.ts", lines("x()", "", "  // note", "/* a", "   b */", 'y("// not a comment")'));
    expect([quiet(2, 5), quiet(1, 2), quiet(5, 6)]).toEqual([true, false, false]);
  });
});
