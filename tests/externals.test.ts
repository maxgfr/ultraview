import { describe, expect, it } from "vitest";
import { registrableDomain, sdkForEnv, sdkForNpm, sdkForPyModule } from "../src/extract/externals.js";
import { runExtractors } from "../src/extract/index.js";
import { SDK_MAP } from "../src/extract/sdk-map.js";

function extOf(files: Record<string, string>): string[] {
  const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
  return facts.externals.map((e) => `${e.id} ${e.via} ${e.file}:${e.line}`);
}
const lines = (...l: string[]) => l.join("\n");

describe("externals extractor", () => {
  it("reads JS SDK imports of declared packages (scoped, subpaths, require, dynamic import)", () => {
    expect(
      extOf({
        "package.json": '{"dependencies":{"stripe":"1","@aws-sdk/client-s3":"3","firebase":"10","ioredis":"5","@sentry/node":"8"}}',
        "src/a.ts": lines(
          'import Stripe from "stripe";',
          'import { S3Client } from "@aws-sdk/client-s3";',
          'import { initializeApp } from "firebase/app";',
          'const Redis = require("ioredis");',
          'const Sentry = await import("@sentry/node");',
        ),
      }),
    ).toEqual(["stripe sdk src/a.ts:1", "aws sdk src/a.ts:2", "firebase sdk src/a.ts:3", "redis sdk src/a.ts:4", "sentry sdk src/a.ts:5"]);
  });

  it("reads Python SDK imports of declared distributions", () => {
    expect(
      extOf({
        "requirements.txt": "stripe\nboto3\ngoogle-cloud-storage\nsentry-sdk\npsycopg2-binary\nPyGithub\n",
        "app/a.py": lines(
          "import stripe",
          "import boto3, json",
          "from google.cloud import storage",
          "import sentry_sdk as sentry",
          "import psycopg2.extras",
          "from github import Github",
        ),
      }),
    ).toEqual([
      "stripe sdk app/a.py:1",
      "aws sdk app/a.py:2",
      "google-cloud sdk app/a.py:3",
      "sentry sdk app/a.py:4",
      "postgres sdk app/a.py:5",
      "github sdk app/a.py:6",
    ]);
  });

  it("reads absolute URL hosts as registrable domains", () => {
    expect(
      extOf({
        "src/a.ts": lines(
          'fetch("https://api.stripe.com/v1/charges");',
          "const u = `https://hooks.slack.com/services/${id}`;",
          'const shop = "https://www.shop.co.uk/feed";',
        ),
        "app/b.py": 'URL = f"https://api.openai.com/v1/{path}"',
      }),
    ).toEqual(["openai.com host app/b.py:1", "stripe.com host src/a.ts:1", "slack.com host src/a.ts:2", "shop.co.uk host src/a.ts:3"]);
  });

  it("reads env vars by SDK prefix (framework public prefixes stripped)", () => {
    expect(
      extOf({
        "src/a.ts": lines(
          "const k = process.env.STRIPE_SECRET_KEY;",
          'const u = process.env["NEXT_PUBLIC_SUPABASE_URL"];',
          "const t = import.meta.env.VITE_SENTRY_DSN;",
          "const g = process.env.GOOGLE_CLOUD_PROJECT;",
        ),
        "app/b.py": lines("import os", 'os.environ["OPENAI_API_KEY"]', 'os.environ.get("AWS_REGION")', 'os.getenv("TWILIO_TOKEN")'),
      }),
    ).toEqual([
      "openai env app/b.py:2",
      "aws env app/b.py:3",
      "twilio env app/b.py:4",
      "stripe env src/a.ts:1",
      "supabase env src/a.ts:2",
      "sentry env src/a.ts:3",
      "google-cloud env src/a.ts:4",
    ]);
  });

  it("maps names through the data module", () => {
    expect(sdkForNpm("@slack/web-api")?.id).toBe("slack");
    expect(sdkForNpm("@octokit/rest")?.id).toBe("github");
    expect(sdkForPyModule("slack_sdk.web")?.id).toBe("slack");
    expect(sdkForEnv("STRIPEY")).toBeUndefined();
    expect(sdkForEnv("GOOGLE_CLOUD_X")?.id).toBe("google-cloud");
    expect(new Set(SDK_MAP.map((e) => e.id)).size).toBe(SDK_MAP.length);
    expect(registrableDomain("api.stripe.com")).toBe("stripe.com");
    expect(registrableDomain("localhost")).toBeUndefined();
    expect(registrableDomain("db.internal")).toBeUndefined();
    expect(registrableDomain("10.0.0.1")).toBeUndefined();
  });

  describe("false-positive guards", () => {
    it("ignores undeclared SDKs, relative imports and local modules", () => {
      expect(
        extOf({
          "package.json": '{"dependencies":{"express":"4"}}',
          "src/a.ts": lines('import Stripe from "stripe";', 'import { x } from "./stripe";'),
          "requirements.txt": "flask\n",
          "app/a.py": lines("import stripe", "from .openai import client"),
        }),
      ).toEqual([]);
    });

    it("ignores comments, docstrings, local and schema hosts, and URLs outside strings", () => {
      expect(
        extOf({
          "src/a.ts": lines(
            "// see https://stripe.com/docs",
            "/* https://api.github.com */",
            'fetch("http://localhost:3000/x");',
            'fetch("http://127.0.0.1/x");',
            'const ns = "http://www.w3.org/2000/svg";',
            'const ex = "https://example.com/a";',
            'const api = "https://api.internal/x";',
          ),
          "app/a.py": lines('"""Docs: https://docs.python.org/3/"""', "# https://pypi.org/project/x", 'x = "http://schemas.xmlsoap.org/soap/"'),
        }),
      ).toEqual([]);
    });

    it("ignores env vars of unknown services, env reads in strings and comments, and skips tests and markdown", () => {
      expect(
        extOf({
          "src/a.ts": lines("const p = process.env.PORT;", "// process.env.STRIPE_KEY", 'log("process.env.OPENAI_KEY");', "const x = env.STRIPE_KEY;"),
          "app/a.py": lines("import os", 'config.environ["STRIPE_KEY"]', 'os.getenv("DATABASE_URL")', "print(\"os.getenv('OPENAI_KEY')\")"),
          "app/b.py": 'environ["STRIPE_KEY"]',
          "src/a.test.ts": 'fetch("https://api.stripe.com"); process.env.STRIPE_KEY;',
          "docs/setup.md": "Set STRIPE_KEY and call https://api.stripe.com",
        }),
      ).toEqual([]);
    });
  });
});
