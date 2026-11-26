#!/usr/bin/env node
// Offline evals for the built bundle (scripts/ultraview.mjs), over the fixture
// repos of tests/fixtures, each built in a temp copy (never in place).
//
//   ranking  every paraphrase in case.json `questions` goes through `lens new
//            --json`, once as asked and once with its `--terms` (case.json
//            `terms.<lang>[i]`, the English keywords an agent would pass); a
//            paraphrase is a hit when every `expect.nodes` id is among the
//            first `expect.top` candidates of the pack. Without terms, the
//            English and French hit rates of each case must reach
//            `expect.minRecall`; with terms, every language's recall over
//            all the cases must reach English's recall without terms, less
//            TERMS_MARGIN points.
//   good     answer.good.json (a lens, a flow or a model) must pass `lens save`
//            / `flow save` and `check`, hold every `expect.nodes` id (node
//            recall 1) and cite every file of `expect.cites`.
//   bad      answer.bad.json must fail at `bad.fails` (save, check or expect)
//            with every reason of `bad.reasons` in the messages.
//   chat     every multi-turn scenario in chats/<id>.json (questions per
//            language, one per turn, each turn's `expect` nodes): turn by
//            turn, `lens new --thread` over a conversation holding the
//            previous turns, simulated (each answer's nodes = that turn's
//            `expect`; the scenario's `context` on turn 1, also passed as
//            `--context`), against `lens new` alone (no digest, no context).
//            A turn is a hit when all its `expect` nodes are in the top
//            CHAT_TOP candidates. No `--terms` (the scenarios carry none).
//            Gates on the follow-up turns: all languages >= CHAT_FOLLOW_MIN,
//            each language >= CHAT_LANG_MIN, and the thread beats `lens new`
//            alone by CHAT_GAIN_MIN points; turn 1 of a scenario with a
//            context >= CHAT_CONTEXT_MIN.
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
const chatsDir = join(root, "evals", "chats");
const args = process.argv.slice(2);
const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
const verbose = args.includes("--verbose");
const env = { ...process.env, CODEINDEX_NO_GRAMMARS_PULL: "1" };
process.env.CODEINDEX_NO_GRAMMARS_PULL = "1";
/** Languages whose recall without terms is gated per case (the others need `--terms`). */
const PLAIN_GATED = ["en", "fr"];
/** With terms, a language may trail English without terms by this many points at most. */
const TERMS_MARGIN = 2;
const LANGS = ["en", "fr", "es", "de", "it", "pt", "nl", "ja", "zh", "ar", "ru"];
/** Chat scenarios: a turn hits when its nodes are in this many top candidates. */
const CHAT_TOP = 10;
/**
 * Chat gates, from the measured recall (evals/README.md): follow-ups with the
 * thread 34/40 (85%), each language 6/8 or more, against 9/40 (22%) without;
 * turn 1 with a context 10/10. Each gate sits one miss or so under it.
 */
const CHAT_FOLLOW_MIN = 0.8;
const CHAT_LANG_MIN = 0.75;
const CHAT_GAIN_MIN = 50;
const CHAT_CONTEXT_MIN = 0.9;
// `lens new` runs in this process, through the committed bundle's own `main`: 1300-odd packs, one node start.
const { main } = await import(bundle);

async function lensNew(argv) {
  let out = "";
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (out += s) });
  return { code, out };
}

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
      const terms = c.terms?.[lang];
      if (terms && terms.length !== questions.length) throw new Error(`${name}: terms.${lang} holds ${terms.length} entries for ${questions.length} questions`);
      for (const mode of terms ? ["plain", "terms"] : ["plain"]) {
        let hits = 0;
        for (const [i, q] of questions.entries()) {
          const argv = ["lens", "new", q, "--repo", repo, "--json", ...(mode === "terms" ? ["--terms", terms[i]] : [])];
          const pack = json(await lensNew(argv));
          const top = (pack?.candidates ?? []).slice(0, c.expect.top).map((x) => x.id);
          const hit = c.expect.nodes.every((n) => top.includes(n));
          if (hit) hits++;
          else if (verbose)
            process.stdout.write(
              `      miss (${lang}${mode === "terms" ? " + terms" : ""}): ${q}${mode === "terms" ? ` [${terms[i]}]` : ""}\n        top: ${top.join(" | ")}\n`,
            );
        }
        recall.push({ case: name, heldOut: !!c.heldOut, lang, mode, hits, total: questions.length });
        if (mode === "plain" && PLAIN_GATED.includes(lang))
          record(
            `${name}: ${lang} pack ranks ${c.expect.nodes.join(", ")} in its top ${c.expect.top} (${hits}/${questions.length})`,
            hits / questions.length >= c.expect.minRecall,
            `${hits}/${questions.length} below ${c.expect.minRecall}`,
          );
      }
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

// --- chat: multi-turn scenarios through `lens new --thread` ---------------------------
const chatRows = [];
const chatNames = existsSync(chatsDir)
  ? readdirSync(chatsDir)
      .filter((n) => n.endsWith(".json") && (!only || n === `${only}.json`))
      .sort()
  : [];
const builtFixtures = new Map();
try {
  for (const name of chatNames) {
    const sc = JSON.parse(readFileSync(join(chatsDir, name), "utf8"));
    if (!builtFixtures.has(sc.fixture)) builtFixtures.set(sc.fixture, builtRepo({ fixture: sc.fixture }, `chat-${sc.fixture}`));
    const { repo } = builtFixtures.get(sc.fixture);
    const convDir = join(repo, ".ultraview", "conversations");
    mkdirSync(convDir, { recursive: true });
    for (const [lang, questions] of Object.entries(sc.questions)) {
      if (questions.length !== sc.turns.length) throw new Error(`${name}: questions.${lang} holds ${questions.length} entries for ${sc.turns.length} turns`);
      const id = `${sc.id}-${lang}`;
      for (const [k, turn] of sc.turns.entries()) {
        // The thread so far: the previous turns, each answered about exactly its expected nodes.
        const previous = sc.turns.slice(0, k).map((t, j) => ({
          question: questions[j],
          lang,
          mode: "business",
          source: "agent",
          ...(j === 0 && sc.context ? { context: sc.context } : {}),
          answer: { answer: "Simulated answer. [README.md:1]", nodes: t.expect },
          followUps: ["-", "-", "-"],
          sources: {},
          at: "2026-01-01T00:00:00.000Z",
        }));
        writeFileSync(join(convDir, `${id}.json`), `${JSON.stringify({ id, title: sc.id, createdAt: "2026-01-01T00:00:00.000Z", turns: previous })}\n`);
        const context = k === 0 && sc.context ? ["--context", JSON.stringify(sc.context)] : [];
        const top = async (argv) =>
          (json(await lensNew(["lens", "new", questions[k], "--repo", repo, "--json", ...argv]))?.candidates ?? []).slice(0, CHAT_TOP).map((c) => c.id);
        const withThread = await top(["--thread", id, ...context]);
        const alone = await top([]);
        const hit = (ids) => turn.expect.every((n) => ids.includes(n));
        chatRows.push({ scenario: sc.id, lang, turn: k + 1, context: k === 0 && !!sc.context, thread: hit(withThread), alone: hit(alone) });
        if (verbose && !hit(withThread))
          process.stdout.write(
            `      miss (chat ${sc.id} ${lang} turn ${k + 1}): ${questions[k]}\n        want ${turn.expect.join(" ")}\n        top: ${withThread.join(" | ")}\n`,
          );
      }
    }
  }
} finally {
  for (const { tmp } of builtFixtures.values()) rmSync(tmp, { recursive: true, force: true });
}
if (chatRows.length) {
  const count = (rows, key) => ({ hits: rows.filter((r) => r[key]).length, total: rows.length });
  const share = (c) => (c.total ? (100 * c.hits) / c.total : Number.NaN);
  const show = (c) => (c.total ? `${c.hits}/${c.total} (${Math.round(share(c))}%)` : "-");
  const langs = [...new Set(chatRows.map((r) => r.lang))];
  const lines = [`${"lang".padEnd(5)} ${"turn 1, thread".padEnd(16)} ${"turn 1, alone".padEnd(15)} ${"follow-ups, thread".padEnd(20)} follow-ups, alone`];
  for (const lang of [...langs, "all"]) {
    const rows = chatRows.filter((r) => lang === "all" || r.lang === lang);
    const first = rows.filter((r) => r.turn === 1);
    const follow = rows.filter((r) => r.turn > 1);
    lines.push(
      `${lang.padEnd(5)} ${show(count(first, "thread")).padEnd(16)} ${show(count(first, "alone")).padEnd(15)} ${show(count(follow, "thread")).padEnd(20)} ${show(count(follow, "alone"))}`,
    );
  }
  const ctx = chatRows.filter((r) => r.context);
  lines.push(`turn 1 with a context: ${show(count(ctx, "thread"))} with --context, ${show(count(ctx, "alone"))} without`);
  process.stdout.write(
    `\nchat recall (lens new --thread vs lens new alone; key nodes in the top ${CHAT_TOP}; no --terms)\n${lines.map((l) => `  ${l}`).join("\n")}\n\n`,
  );

  const follow = chatRows.filter((r) => r.turn > 1);
  const all = count(follow, "thread");
  record(`chat follow-ups with the thread: ${show(all)} >= ${CHAT_FOLLOW_MIN * 100}%`, share(all) >= CHAT_FOLLOW_MIN * 100, `${share(all).toFixed(1)}%`);
  for (const lang of langs) {
    const c = count(
      follow.filter((r) => r.lang === lang),
      "thread",
    );
    record(`chat follow-ups with the thread, ${lang}: ${show(c)} >= ${CHAT_LANG_MIN * 100}%`, share(c) >= CHAT_LANG_MIN * 100, `${share(c).toFixed(1)}%`);
  }
  const alone = count(follow, "alone");
  record(
    `chat follow-ups: the thread (${show(all)}) beats lens new alone (${show(alone)}) by ${CHAT_GAIN_MIN} points`,
    share(all) - share(alone) >= CHAT_GAIN_MIN,
    `${(share(all) - share(alone)).toFixed(1)} points`,
  );
  if (ctx.length) {
    const c = count(ctx, "thread");
    record(`chat turn 1 with a context ranks it: ${show(c)} >= ${CHAT_CONTEXT_MIN * 100}%`, share(c) >= CHAT_CONTEXT_MIN * 100, `${share(c).toFixed(1)}%`);
  }
}

// Recall per language, without and with terms: tuned set, held-out set, all cases.
const sum = (rows) => rows.reduce((a, r) => ({ hits: a.hits + r.hits, total: a.total + r.total }), { hits: 0, total: 0 });
const pct = (s) => (s.total ? (100 * s.hits) / s.total : Number.NaN);
const cell = (s) => (s.total ? `${s.hits}/${s.total} (${Math.round(pct(s))}%)` : "-");
const sets = [
  ["tuned", (r) => !r.heldOut],
  ["held-out", (r) => r.heldOut],
  ["all", () => true],
];
const lines = [`${"set".padEnd(9)} ${"lang".padEnd(4)} ${"without terms".padEnd(15)} with terms`];
for (const [set, inSet] of sets) {
  for (const lang of LANGS) {
    const rows = recall.filter((r) => inSet(r) && r.lang === lang);
    if (!rows.length) continue;
    const plain = sum(rows.filter((r) => r.mode === "plain"));
    const terms = sum(rows.filter((r) => r.mode === "terms"));
    lines.push(`${set.padEnd(9)} ${lang.padEnd(4)} ${cell(plain).padEnd(15)} ${cell(terms)}`);
  }
}
process.stdout.write(`\nlens new recall (key nodes in the top candidates)\n${lines.map((l) => `  ${l}`).join("\n")}\n\n`);

// The bridge gate: with terms, no language trails English without terms by more than TERMS_MARGIN points (over every case run).
const english = sum(recall.filter((r) => r.lang === "en" && r.mode === "plain"));
if (english.total) {
  const floor = pct(english) - TERMS_MARGIN;
  for (const lang of LANGS) {
    const s = sum(recall.filter((r) => r.lang === lang && r.mode === "terms"));
    if (!s.total) continue;
    record(
      `${lang} with --terms: ${cell(s)} >= English without terms ${cell(english)} - ${TERMS_MARGIN} points`,
      pct(s) >= floor,
      `${pct(s).toFixed(1)}% below ${floor.toFixed(1)}%`,
    );
  }
}
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
