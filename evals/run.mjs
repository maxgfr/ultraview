#!/usr/bin/env node
// Offline evals for the built bundle (scripts/ultraview.mjs), over the fixture
// repos of tests/fixtures, each built in a temp copy (never in place).
//
//   ranking  every paraphrase in case.json `questions` goes through `lens new
//            --json`; a paraphrase is a hit when every `expect.nodes` id is
//            among the first `expect.top` candidates of the pack. The hit rate
//            of each language must reach `expect.minRecall`.
//   good     answer.good.json (a lens, a flow or a model) must pass `lens save`
//            / `flow save` and `check`, hold every `expect.nodes` id (node
//            recall 1) and cite every file of `expect.cites`.
//   bad      answer.bad.json must fail at `bad.fails` (save, check or expect)
//            with every reason of `bad.reasons` in the messages.
//
// Usage: node evals/run.mjs [--case <id>] [--verbose]. Writes nothing in the
// repository; exits 1 when any assertion fails.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "scripts", "ultraview.mjs");
const casesDir = join(root, "evals", "cases");
const args = process.argv.slice(2);
const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
const verbose = args.includes("--verbose");
const env = { ...process.env, CODEINDEX_NO_GRAMMARS_PULL: "1" };

function cli(argv) {
  try {
    return { code: 0, out: execFileSync("node", [bundle, ...argv], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const json = (r) => {
  try {
    return JSON.parse(r.out);
  } catch {
    return undefined;
  }
};

const results = [];
const recall = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, ...(ok ? {} : { detail }) });
  process.stdout.write(`${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : `\n      ${detail}`}\n`);
};

/** A built temp copy of the case's fixture, with its model when the case names one. */
function builtRepo(c, name) {
  const tmp = mkdtempSync(join(tmpdir(), `ultraview-eval-${name}-`));
  const repo = join(tmp, c.fixture);
  cpSync(join(root, "tests", "fixtures", c.fixture), repo, { recursive: true });
  if (c.model) {
    mkdirSync(join(repo, ".ultraview"), { recursive: true });
    cpSync(join(root, "tests", "fixtures-models", c.model), join(repo, ".ultraview", "model.json"));
  }
  const b = cli(["build", "--repo", repo, "--no-ast"]);
  if (b.code !== 0) throw new Error(`build failed for ${name}: ${b.out}`);
  return { tmp, repo };
}

/** Run one answer file through its gates: the stage it stopped at and every message. */
function gate(c, repo, file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  const messages = [];
  if (c.kind === "model") {
    writeFileSync(join(repo, ".ultraview", "model.json"), `${JSON.stringify(value, null, 2)}\n`);
  } else {
    const save = cli([c.kind, "save", file, "--repo", repo, "--json"]);
    const saved = json(save);
    if (save.code !== 0) {
      messages.push(...(saved?.errors ?? []).map((e) => `${e.path}: ${e.message}`), ...(saved ? [] : [save.out]));
      return { stage: "save", messages, value };
    }
  }
  const check = json(cli(["check", "--repo", repo, "--json"]));
  if (!check?.ok) {
    messages.push(...(check?.errors ?? []).map((e) => `${e.file} ${e.path}: ${e.message}`));
    return { stage: "check", messages, value };
  }
  // The gates passed; now what the case expects of the content.
  const nodes = new Set(c.kind === "model" ? [] : c.kind === "flow" ? value.steps.map((s) => s.node) : value.nodes);
  const missing = (c.expect.nodes ?? []).filter((n) => c.kind !== "model" && !nodes.has(n));
  if (missing.length) messages.push(`node recall: missing ${missing.join(", ")}`);
  const prose = c.kind === "lens" ? value.answer : c.kind === "flow" ? value.steps.map((s) => s.note).join("\n") : JSON.stringify(value);
  const cited = new Set([...prose.matchAll(/\[([^\]\s:]+):\d/g)].map((m) => m[1]));
  for (const f of c.expect.cites ?? []) if (!cited.has(f)) messages.push(`missing citation of ${f}`);
  return { stage: messages.length ? "expect" : "pass", messages, value };
}

const names = readdirSync(casesDir)
  .filter((n) => existsSync(join(casesDir, n, "case.json")) && (!only || n === only))
  .sort();
for (const name of names) {
  const dir = join(casesDir, name);
  const c = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
  const { tmp, repo } = builtRepo(c, name);
  try {
    for (const [lang, questions] of Object.entries(c.questions ?? {})) {
      let hits = 0;
      for (const q of questions) {
        const pack = json(cli(["lens", "new", q, "--repo", repo, "--json"]));
        const top = (pack?.candidates ?? []).slice(0, c.expect.top).map((x) => x.id);
        const hit = c.expect.nodes.every((n) => top.includes(n));
        if (hit) hits++;
        else if (verbose) process.stdout.write(`      miss (${lang}): ${q}\n        top: ${top.join(" | ")}\n`);
      }
      const rate = hits / questions.length;
      recall.push({ case: name, heldOut: !!c.heldOut, lang, hits, total: questions.length });
      record(
        `${name}: ${lang} pack ranks ${c.expect.nodes.join(", ")} in its top ${c.expect.top} (${hits}/${questions.length})`,
        rate >= c.expect.minRecall,
        `${hits}/${questions.length} below ${c.expect.minRecall}`,
      );
    }
    const good = join(dir, "answer.good.json");
    if (existsSync(good)) {
      const g = gate(c, repo, good);
      record(
        `${name}: good answer passes ${c.kind === "model" ? "check" : `${c.kind} save + check`} and the expectations`,
        g.stage === "pass",
        `${g.stage}: ${g.messages.join("; ")}`,
      );
    }
    const bad = join(dir, "answer.bad.json");
    if (existsSync(bad)) {
      const b = gate(c, repo, bad);
      const missing = c.bad.reasons.filter((r) => !b.messages.some((m) => m.includes(r)));
      record(
        `${name}: bad answer fails at ${c.bad.fails} on ${c.bad.reasons.map((r) => `"${r}"`).join(", ")}`,
        b.stage === c.bad.fails && missing.length === 0,
        `stopped at ${b.stage}; missing ${missing.join(", ") || "-"}; got ${b.messages.join("; ")}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Recall per language, tuned set and held-out set apart.
const sum = (rows) => rows.reduce((a, r) => ({ hits: a.hits + r.hits, total: a.total + r.total }), { hits: 0, total: 0 });
const lines = [];
for (const heldOut of [false, true]) {
  for (const lang of ["en", "fr"]) {
    const rows = recall.filter((r) => r.heldOut === heldOut && r.lang === lang);
    if (!rows.length) continue;
    const s = sum(rows);
    lines.push(`${heldOut ? "held-out" : "tuned   "}  ${lang}  ${s.hits}/${s.total} (${Math.round((100 * s.hits) / s.total)}%)`);
  }
}
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\nlens new recall (key nodes in the top candidates)\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
