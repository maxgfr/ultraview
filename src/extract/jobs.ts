// Scheduled and queued work.
//
//   BullMQ          new Queue("emails") → queue `emails`; new Worker("emails", …) → worker `emails`
//   node-cron       cron.schedule("0 * * * *", sendReceipts) → cron `cron:sendReceipts`
//                   (an inline callback: `cron:<file>`, `#2`, `#3`… for later ones)
//   Celery          @app.task / @shared_task def send_receipt → worker `send_receipt`;
//                   beat_schedule entries → cron `cron:<entry name>` (schedule when literal)
//   vercel.json     crons[{ path, schedule }] → cron `cron:<path>`
//   GitHub Actions  on.schedule[].cron → cron `cron:<workflow file>`
//
// Library-based jobs are gated on the declared dependency; vercel.json and
// workflows are recognized by their path.

import { identifierPath, importsModule, isJsLike, readArgs, stringLiteral } from "./js.js";
import { lineIndex, maskSource } from "./mask.js";
import { decoratedName, importsPyModule, isPython, kwarg, positional, pyImports, pyLiteral } from "./py.js";
import type { ExtractInput, ExtractOutput, Extractor, JobFact, RepoContext } from "./types.js";
import { yamlChild, yamlDocuments } from "./yaml.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- BullMQ

function extractBullmq(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text);
  if (!importsModule(text, "bullmq")) return {};
  const skeleton = maskSource(input.rel, input.text, { strings: true });
  const lineOf = lineIndex(text);
  const jobs: JobFact[] = [];
  for (const m of skeleton.matchAll(/\bnew\s+(Queue|Worker)\s*(?:<[^>()]*>)?\s*\(/g)) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    const name = call?.args[0] ? stringLiteral(call.args[0].raw) : undefined;
    if (!name) continue;
    jobs.push({ id: name, kind: m[1] === "Queue" ? "queue" : "worker", file: input.rel, line: lineOf(m.index as number) });
  }
  return jobs.length ? { jobs } : {};
}

export const bullmqExtractor: Extractor = {
  id: "bullmq",
  applies: (input: ExtractInput, ctx: RepoContext) => isJsLike(input.rel) && ctx.depsFor(input.rel).has("bullmq"),
  extract: extractBullmq,
};

// ---------------------------------------------------------------- node-cron

function extractNodeCron(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text);
  const skeleton = maskSource(input.rel, input.text, { strings: true });
  const lineOf = lineIndex(text);
  // `import cron from "node-cron"`, `import * as cron …`, `const cron = require("node-cron")`, `import { schedule } …`.
  const receivers = new Set<string>();
  for (const m of text.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+["']node-cron["']/g)) receivers.add(`${m[1]}.schedule`);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']node-cron["']\s*\)/g)) receivers.add(`${m[1]}.schedule`);
  for (const m of text.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s+["']node-cron["']/g)) {
    for (const part of (m[1] as string).split(",")) {
      const [name, local] = part.trim().split(/\s+as\s+/);
      if (name === "schedule") receivers.add(local ?? name);
    }
  }
  if (!receivers.size) return {};
  const alts = [...receivers].map((r) => esc(r).replace(/\\\./g, "\\s*\\.\\s*")).join("|");
  const jobs: JobFact[] = [];
  let inline = 0;
  for (const m of skeleton.matchAll(new RegExp(`(?<![\\w$.])(?:${alts})\\s*\\(`, "g"))) {
    const call = readArgs(text, (m.index as number) + m[0].length - 1);
    const schedule = call?.args[0] ? stringLiteral(call.args[0].raw) : undefined;
    if (!call || !schedule || call.args.length < 2) continue;
    const handler = identifierPath((call.args[1] as { raw: string }).raw);
    const id = handler ? `cron:${handler}` : `cron:${input.rel}${inline++ ? `#${inline}` : ""}`;
    jobs.push({ id, kind: "cron", schedule, file: input.rel, line: lineOf(m.index as number) });
  }
  return jobs.length ? { jobs } : {};
}

export const nodeCronExtractor: Extractor = {
  id: "node-cron",
  applies: (input: ExtractInput, ctx: RepoContext) => isJsLike(input.rel) && ctx.depsFor(input.rel).has("node-cron"),
  extract: extractNodeCron,
};

// ---------------------------------------------------------------- Celery

/** A literal number or string argument's text (`"0"`, `30`), else undefined. */
function scalar(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw.trim())) return raw.trim();
  return pyLiteral(raw);
}

/**
 * A Celery beat schedule as text, when literal: `crontab(minute=0, hour="*\/3")`
 * → `0 *\/3 * * *` (minute hour day-of-month month day-of-week); `30.0` →
 * `every 30s`; `timedelta(minutes=5)` → `every 5m`.
 */
export function celerySchedule(raw: string): string | undefined {
  const v = raw.trim();
  const n = /^(\d+(?:\.\d+)?)$/.exec(v);
  if (n) return `every ${Number(n[1])}s`;
  const call = /^(?:[\w.]+\.)?(crontab|timedelta)\s*\(/.exec(v);
  if (!call) return undefined;
  const args = readArgs(v, call[0].length - 1)?.args;
  if (!args) return undefined;
  if (call[1] === "timedelta") {
    const UNITS: Record<string, string> = { seconds: "s", minutes: "m", hours: "h", days: "d", weeks: "w" };
    if (args.length !== 1) return undefined;
    const kv = /^(\w+)\s*=\s*(\d+(?:\.\d+)?)$/.exec((args[0] as { raw: string }).raw);
    const unit = kv ? UNITS[kv[1] as string] : undefined;
    return kv && unit ? `every ${Number(kv[2])}${unit}` : undefined;
  }
  // Celery's positional order: minute, hour, day_of_week, day_of_month, month_of_year.
  const ORDER = ["minute", "hour", "day_of_week", "day_of_month", "month_of_year"];
  const fields: Record<string, string> = {};
  const pos = positional(args);
  for (let i = 0; i < pos.length; i++) {
    const s = scalar((pos[i] as { raw: string }).raw);
    if (s === undefined || i >= ORDER.length) return undefined;
    fields[ORDER[i] as string] = s;
  }
  for (const key of ORDER) {
    const a = kwarg(args, key);
    if (!a) continue;
    const s = scalar(a.raw);
    if (s === undefined) return undefined;
    fields[key] = s;
  }
  if (args.length > pos.length + ORDER.filter((k) => kwarg(args, k)).length) return undefined;
  const f = (k: string) => fields[k] ?? "*";
  return `${f("minute")} ${f("hour")} ${f("day_of_month")} ${f("month_of_year")} ${f("day_of_week")}`;
}

function extractCelery(input: ExtractInput): ExtractOutput {
  const text = maskSource(input.rel, input.text);
  const skeleton = maskSource(input.rel, input.text, { strings: true });
  const lineOf = lineIndex(text);
  const imports = pyImports(text);
  const jobs: JobFact[] = [];

  // Celery apps: assigned `Celery(…)` here, or imported from a module named like one (`from proj.celery import app`).
  const apps = new Set<string>();
  for (const m of skeleton.matchAll(/^([A-Za-z_]\w*)\s*=\s*(?:celery\s*\.\s*)?Celery\s*\(/gm)) apps.add(m[1] as string);
  for (const [local, imp] of imports) {
    if (
      imp.name !== undefined &&
      /(?:^|\.)(?:celery|celery_app|worker|tasks)$/.test(imp.module.replace(/^\.+/, "")) &&
      /^(?:app|celery|celery_app)$/.test(imp.name)
    )
      apps.add(local);
  }
  const celeryImported = importsPyModule(text, "celery");
  if (!apps.size && celeryImported) {
    apps.add("app");
    apps.add("celery");
  }
  const shared = [...imports.entries()].filter(([, imp]) => imp.module === "celery" && imp.name === "shared_task").map(([local]) => local);
  if (celeryImported) shared.push("celery.shared_task");
  const decorators = [...[...apps].map((a) => `${esc(a)}\\s*\\.\\s*task`), ...shared.map((s) => esc(s).replace(/\\\./g, "\\s*\\.\\s*"))];
  if (decorators.length) {
    const DECO = new RegExp(`^[ \\t]*@[ \\t]*(?:${decorators.join("|")})\\b(\\s*\\()?`, "gm");
    for (const m of skeleton.matchAll(DECO)) {
      let end = (m.index as number) + m[0].length;
      if (m[1]) end = readArgs(text, end - 1)?.end ?? end;
      const fn = decoratedName(skeleton, end);
      if (fn) jobs.push({ id: fn.name, kind: "worker", file: input.rel, line: lineOf(skeleton.indexOf("@", m.index as number)) });
    }
  }

  // beat_schedule = {"name": {"task": …, "schedule": …}} (also CELERY_BEAT_SCHEDULE, conf.update(beat_schedule={…})).
  for (const m of text.matchAll(/\b(?:beat_schedule|CELERY_BEAT_SCHEDULE)["']?\s*[=:]\s*\{/g)) {
    const dict = readArgs(text, (m.index as number) + m[0].length - 1);
    if (!dict) continue;
    for (const entry of dict.args) {
      const kv = /^((["'])[^"']+\2)\s*:\s*([\s\S]+)$/.exec(entry.raw);
      const name = kv ? pyLiteral(kv[1] as string) : undefined;
      if (!kv || !name) continue;
      const job: JobFact = { id: `cron:${name}`, kind: "cron", file: input.rel, line: lineOf(entry.start) };
      const body = (kv[3] as string).trim();
      if (body.startsWith("{")) {
        const inner = readArgs(body, 0);
        for (const item of inner?.args ?? []) {
          const sk = /^(["'])schedule\1\s*:\s*([\s\S]+)$/.exec(item.raw);
          const schedule = sk ? celerySchedule(sk[2] as string) : undefined;
          if (schedule) job.schedule = schedule;
        }
      }
      jobs.push(job);
    }
  }
  return jobs.length ? { jobs } : {};
}

export const celeryExtractor: Extractor = {
  id: "celery",
  applies: (input: ExtractInput, ctx: RepoContext) => isPython(input.rel) && ctx.depsFor(input.rel).has("celery"),
  extract: extractCelery,
};

// ---------------------------------------------------------------- vercel.json

function extractVercel(input: ExtractInput): ExtractOutput {
  let config: unknown;
  try {
    config = JSON.parse(input.text);
  } catch {
    return {};
  }
  const crons = (config as { crons?: unknown })?.crons;
  if (!Array.isArray(crons)) return {};
  const lineOf = lineIndex(input.text);
  const jobs: JobFact[] = [];
  for (const c of crons) {
    const path = (c as { path?: unknown })?.path;
    const schedule = (c as { schedule?: unknown })?.schedule;
    if (typeof path !== "string") continue;
    const at = new RegExp(`"path"\\s*:\\s*${esc(JSON.stringify(path))}`).exec(input.text)?.index ?? 0;
    const job: JobFact = { id: `cron:${path}`, kind: "cron", file: input.rel, line: lineOf(at) };
    if (typeof schedule === "string") job.schedule = schedule;
    jobs.push(job);
  }
  return jobs.length ? { jobs } : {};
}

export const vercelCronExtractor: Extractor = {
  id: "vercel-crons",
  applies: (input: ExtractInput) => input.rel === "vercel.json" || input.rel.endsWith("/vercel.json"),
  extract: extractVercel,
};

// ---------------------------------------------------------------- GitHub Actions

function extractWorkflow(input: ExtractInput): ExtractOutput {
  const jobs: JobFact[] = [];
  for (const doc of yamlDocuments(input.text)) {
    const on = yamlChild(doc, "on") ?? yamlChild(doc, "true");
    for (const item of yamlChild(on?.children, "schedule")?.children ?? []) {
      const cron = item.item ? yamlChild(item.children, "cron") : undefined;
      if (cron?.value) jobs.push({ id: `cron:${input.rel}`, kind: "cron", schedule: cron.value, file: input.rel, line: cron.line });
    }
  }
  return jobs.length ? { jobs } : {};
}

export const githubScheduleExtractor: Extractor = {
  id: "github-actions-schedule",
  applies: (input: ExtractInput) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(input.rel),
  extract: extractWorkflow,
};
