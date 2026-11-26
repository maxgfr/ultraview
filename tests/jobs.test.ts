import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { bullmqExtractor, celeryExtractor, celerySchedule, githubScheduleExtractor, nodeCronExtractor, vercelCronExtractor } from "../src/extract/jobs.js";
import { memoryContext } from "./helpers.js";

function jobsOf(files: Record<string, string>): string[] {
  const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
  return facts.jobs.map((j) => `${j.kind} ${j.id}${j.schedule ? ` [${j.schedule}]` : ""} ${j.file}:${j.line}`);
}
const lines = (...l: string[]) => l.join("\n");

describe("bullmq extractor", () => {
  const PKG = { "package.json": '{"dependencies":{"bullmq":"^5"}}' };

  it("reads queues and workers by name", () => {
    expect(
      jobsOf({
        ...PKG,
        "src/queues.ts": lines(
          'import { Queue, Worker } from "bullmq";',
          'export const emails = new Queue("emails", { connection });',
          "new Worker<Job>('emails', async (job) => send(job), { connection });",
        ),
      }),
    ).toEqual(["queue emails src/queues.ts:2", "worker emails src/queues.ts:3"]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, strings, non-literal names, and files that do not import bullmq", () => {
      expect(
        jobsOf({
          ...PKG,
          "src/a.ts": lines('import { Queue } from "bullmq";', '// new Queue("commented")', "log(\"new Queue('logged')\");", "new Queue(name);"),
          "src/b.ts": lines('import { Queue } from "./my-queue";', 'new Queue("local-class");'),
        }),
      ).toEqual([]);
    });

    it("needs bullmq declared, and skips tests", () => {
      const src = 'import { Queue } from "bullmq";\nnew Queue("q");';
      expect(bullmqExtractor.applies({ rel: "a.ts", text: src }, memoryContext({ "package.json": '{"dependencies":{"bull":"4"}}', "a.ts": "" }))).toBe(false);
      expect(jobsOf({ ...PKG, "src/q.test.ts": src })).toEqual([]);
    });
  });
});

describe("node-cron extractor", () => {
  const PKG = { "package.json": '{"dependencies":{"node-cron":"^3"}}' };

  it("reads schedules; ids from the handler name, else the file", () => {
    expect(
      jobsOf({
        ...PKG,
        "src/cron.js": lines(
          'const cron = require("node-cron");',
          'cron.schedule("0 * * * *", sendReceipts);',
          "cron.schedule('*/5 * * * *', () => ping());",
          'cron.schedule("0 0 * * 0", async () => {});',
        ),
        "src/esm.ts": lines('import { schedule as every } from "node-cron";', 'every("0 3 * * *", jobs.nightly);'),
      }),
    ).toEqual([
      "cron cron:sendReceipts [0 * * * *] src/cron.js:2",
      "cron cron:src/cron.js [*/5 * * * *] src/cron.js:3",
      "cron cron:src/cron.js#2 [0 0 * * 0] src/cron.js:4",
      "cron cron:jobs.nightly [0 3 * * *] src/esm.ts:2",
    ]);
  });

  describe("false-positive guards", () => {
    it("ignores comments, strings, other schedulers' .schedule, and needs node-cron declared", () => {
      expect(
        jobsOf({
          ...PKG,
          "src/a.ts": lines(
            'import cron from "node-cron";',
            '// cron.schedule("* * * * *", a);',
            "log(\"cron.schedule('* * * * *', b)\");",
            'agenda.schedule("* * * * *", c);',
          ),
        }),
      ).toEqual([]);
      expect(nodeCronExtractor.applies({ rel: "a.ts", text: "" }, memoryContext({ "package.json": '{"dependencies":{"cron":"3"}}', "a.ts": "" }))).toBe(false);
    });
  });
});

describe("celery extractor", () => {
  const DEPS = { "requirements.txt": "celery[redis]\n" };

  it("reads tasks on Celery apps and shared_task, and literal beat schedules", () => {
    expect(
      jobsOf({
        ...DEPS,
        "proj/celery.py": lines(
          "from celery import Celery, shared_task",
          "from celery.schedules import crontab",
          "from datetime import timedelta",
          "app = Celery('proj')",
          "@app.task",
          "def add(x, y): ...",
          "@app.task(bind=True,",
          "          max_retries=3)",
          "def retry_me(self): ...",
          "@shared_task",
          "async def cleanup(): ...",
          "app.conf.beat_schedule = {",
          "    'add-every-30s': {'task': 'proj.add', 'schedule': 30.0},",
          "    'nightly': {'task': 'proj.cleanup', 'schedule': crontab(hour=3, minute='30', day_of_week='mon-fri')},",
          "    'hourly': {'task': 'proj.cleanup', 'schedule': timedelta(hours=1)},",
          "    'dynamic': {'task': 'proj.cleanup', 'schedule': settings.EVERY},",
          "}",
        ),
        "proj/tasks.py": lines("from .celery import app", "@app.task", "def send_email(to): ..."),
      }),
    ).toEqual([
      "worker add proj/celery.py:5",
      "worker retry_me proj/celery.py:7",
      "worker cleanup proj/celery.py:10",
      "cron cron:add-every-30s [every 30s] proj/celery.py:13",
      "cron cron:nightly [30 3 * * mon-fri] proj/celery.py:14",
      "cron cron:hourly [every 1h] proj/celery.py:15",
      "cron cron:dynamic proj/celery.py:16",
      "worker send_email proj/tasks.py:2",
    ]);
  });

  it("converts schedules", () => {
    expect(celerySchedule("crontab()")).toBe("* * * * *");
    expect(celerySchedule("crontab(0, 0, day_of_month='1')")).toBe("0 0 1 * *");
    expect(celerySchedule("crontab(minute=x)")).toBeUndefined();
    expect(celerySchedule("solar('sunset', 1, 2)")).toBeUndefined();
  });

  describe("false-positive guards", () => {
    it("ignores comments, docstrings, strings and .task on non-Celery objects", () => {
      expect(
        jobsOf({
          ...DEPS,
          "proj/a.py": lines(
            "from celery import Celery",
            "app = Celery('p')",
            "# @app.task",
            "# def ghost(): ...",
            "def f():",
            '    """@app.task def doc(): ..."""',
            "    print('@app.task')",
            "@scheduler.task",
            "def other(): ...",
          ),
        }),
      ).toEqual([]);
    });

    it("needs celery declared, and skips tests", () => {
      const src = lines("from celery import shared_task", "@shared_task", "def t(): ...");
      expect(celeryExtractor.applies({ rel: "t.py", text: src }, memoryContext({ "requirements.txt": "rq\n", "t.py": "" }))).toBe(false);
      expect(jobsOf({ ...DEPS, "tests/test_tasks.py": src })).toEqual([]);
    });
  });
});

describe("vercel.json crons", () => {
  it("reads crons with path ids, schedules and lines", () => {
    const json = lines("{", '  "crons": [', '    { "path": "/api/cron/daily", "schedule": "0 5 * * *" },', '    { "path": "/api/cron/sync" }', "  ]", "}");
    expect(jobsOf({ "vercel.json": json, "apps/web/vercel.json": json })).toEqual([
      "cron cron:/api/cron/daily [0 5 * * *] apps/web/vercel.json:3",
      "cron cron:/api/cron/sync apps/web/vercel.json:4",
      "cron cron:/api/cron/daily [0 5 * * *] vercel.json:3",
      "cron cron:/api/cron/sync vercel.json:4",
    ]);
  });

  it("guards: other JSON files, invalid JSON, no crons", () => {
    expect(vercelCronExtractor.applies({ rel: "config/crons.json", text: "" }, memoryContext({}))).toBe(false);
    expect(jobsOf({ "vercel.json": "{ not json" })).toEqual([]);
    expect(jobsOf({ "vercel.json": '{"rewrites": [{"source": "/a", "destination": "/b"}]}' })).toEqual([]);
  });
});

describe("github actions schedule", () => {
  it("reads on.schedule[].cron entries of workflows", () => {
    expect(
      jobsOf({
        ".github/workflows/nightly.yml": lines(
          "name: nightly",
          '"on":',
          "  schedule:",
          "    - cron: '0 3 * * *'",
          '    - cron: "30 4 * * 1"',
          "  push:",
          "    branches: [main]",
          "jobs: {}",
        ),
      }),
    ).toEqual([
      "cron cron:.github/workflows/nightly.yml [0 3 * * *] .github/workflows/nightly.yml:4",
      "cron cron:.github/workflows/nightly.yml [30 4 * * 1] .github/workflows/nightly.yml:5",
    ]);
  });

  describe("false-positive guards", () => {
    it("ignores commented crons, a schedule key outside `on`, and non-workflow YAML", () => {
      expect(
        jobsOf({
          ".github/workflows/ci.yml": lines(
            "on:",
            "  push: {}",
            "  # schedule:",
            "  #   - cron: '0 0 * * *'",
            "jobs:",
            "  build:",
            "    schedule:",
            "      - cron: '1 1 * * *'",
            "    steps:",
            "      - run: echo 'cron: 2 2 * * *'",
          ),
        }),
      ).toEqual([]);
      expect(githubScheduleExtractor.applies({ rel: "deploy/workflows/x.yml", text: "" }, memoryContext({}))).toBe(false);
      expect(githubScheduleExtractor.applies({ rel: ".github/dependabot.yml", text: "" }, memoryContext({}))).toBe(false);
    });
  });
});
