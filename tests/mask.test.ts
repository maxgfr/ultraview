import { describe, expect, it } from "vitest";
import { commentSyntaxFor, maskComments } from "../src/extract/mask.js";

const keepsShape = (a: string, b: string) => {
  expect(b.length).toBe(a.length);
  expect(b.split("\n").length).toBe(a.split("\n").length);
};

describe("maskComments", () => {
  it("blanks JS line and block comments, keeping offsets and lines", () => {
    const src = 'a(); // app.get("/x")\n/* router.post("/y")\n */ b("// not a comment");\n';
    const out = maskComments(src, "js");
    keepsShape(src, out);
    expect(out).not.toContain("app.get");
    expect(out).not.toContain("router.post");
    expect(out).toContain('b("// not a comment")');
    expect(out.indexOf("b(")).toBe(src.indexOf("b("));
  });

  it("keeps comment markers that sit inside strings, templates and regexes", () => {
    const src = "const u = 'http://x'; const t = `a ${f('//')} /* b */`; const r = /\\/\\//g; c(); // gone\n";
    const out = maskComments(src, "js");
    keepsShape(src, out);
    expect(out).toContain("'http://x'");
    expect(out).toContain("`a ${f('//')} /* b */`");
    expect(out).toContain("/\\/\\//g; c();");
    expect(out).not.toContain("gone");
  });

  it("blanks string contents on request, keeping quotes and template code", () => {
    const src = 'log("app.get(\'/x\')"); const t = `GET ${route("/y")} done`;';
    const out = maskComments(src, "js", { strings: true });
    keepsShape(src, out);
    expect(out).not.toContain("app.get");
    expect(out).toContain('route("  ")');
    expect(out).not.toContain("done");
  });

  it("does not let JSX text apostrophes swallow the rest of the file", () => {
    const src = "const a = <p>Don't panic</p>;\n// app.get('/gone')\nconst b = 1;\n";
    const out = maskComments(src, "js");
    expect(out).not.toContain("/gone");
    expect(out).toContain("const b = 1;");
  });

  it("masks Python comments and statement docstrings, keeps value strings", () => {
    const src = 'def f():\n    """Example: @app.get("/doc")"""\n    sql = """SELECT 1"""  # @app.post("/c")\n    return "#not"\n';
    const out = maskComments(src, "python");
    keepsShape(src, out);
    expect(out).not.toContain("/doc");
    expect(out).not.toContain("/c");
    expect(out).toContain('"""SELECT 1"""');
    expect(out).toContain('"#not"');
  });

  it("masks hash comments only at line start or after whitespace", () => {
    const src = "url: http://x/#frag # a comment\n# whole line\n";
    const out = maskComments(src, "hash");
    expect(out).toContain("http://x/#frag");
    expect(out).not.toContain("a comment");
    expect(out).not.toContain("whole line");
  });

  it("maps paths to syntaxes", () => {
    expect(commentSyntaxFor("src/a.tsx")).toBe("js");
    expect(commentSyntaxFor("prisma/schema.prisma")).toBe("c");
    expect(commentSyntaxFor("app/main.py")).toBe("python");
    expect(commentSyntaxFor("docker-compose.yml")).toBe("hash");
    expect(commentSyntaxFor("Dockerfile")).toBe("hash");
    expect(commentSyntaxFor("docs/a.md")).toBeUndefined();
    expect(maskComments("// x", undefined)).toBe("// x");
  });

  it("blanks SQL -- and /* */ comments; single-quoted text is the only string", () => {
    const src = "-- CREATE TABLE a (id int);\nCREATE TABLE \"b\" (x text DEFAULT '-- not a comment', y text); /* gone */\n";
    const out = maskComments(src, "sql");
    keepsShape(src, out);
    expect(out).not.toContain("TABLE a");
    expect(out).not.toContain("gone");
    expect(out).toContain("'-- not a comment'");
    const sk = maskComments(src, "sql", { strings: true });
    expect(sk).toContain('CREATE TABLE "b"');
    expect(sk).not.toContain("not a comment");
    expect(commentSyntaxFor("db/migrations/001_init.sql")).toBe("sql");
  });
});
