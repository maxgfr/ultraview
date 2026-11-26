import { describe, expect, it } from "vitest";
import { runExtractors } from "../src/extract/index.js";
import { composeExtractor, dockerfileId, k8sExtractor } from "../src/extract/infra.js";
import { yamlChild, yamlDocuments } from "../src/extract/yaml.js";
import { memoryContext } from "./helpers.js";

function infraOf(files: Record<string, string>): string[] {
  const facts = runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]);
  return facts.infra.map((i) => `${i.kind} ${i.id} ${i.file}:${i.line}`);
}
const lines = (...l: string[]) => l.join("\n");

describe("yaml outline reader", () => {
  it("reads nested mappings, sequences of mappings, quotes, block scalars and documents", () => {
    const docs = yamlDocuments(
      lines(
        "a:",
        "  b: 'x' # comment",
        "  list:",
        "    - k: 1",
        "      v: two",
        "    - plain",
        "  script: |",
        "    not: a key",
        "  c: http://h:1/x",
        "---",
        "kind: Service",
      ),
    );
    expect(docs).toHaveLength(2);
    const a = yamlChild(docs[0], "a");
    expect(yamlChild(a?.children, "b")?.value).toBe("x");
    const list = yamlChild(a?.children, "list")?.children ?? [];
    expect(list.map((i) => [i.item, i.line, i.value, i.children.map((c) => `${c.key}=${c.value}`)])).toEqual([
      [true, 4, undefined, ["k=1", "v=two"]],
      [true, 6, "plain", []],
    ]);
    expect(yamlChild(a?.children, "not")).toBeUndefined();
    expect(yamlChild(a?.children, "c")?.value).toBe("http://h:1/x");
    expect(yamlChild(docs[1], "kind")?.line).toBe(11);
  });
});

describe("docker-compose extractor", () => {
  it("reads services keys with their lines", () => {
    expect(
      infraOf({
        "docker-compose.yml": lines(
          "version: '3.9'",
          "services:",
          "  api:",
          "    build: .",
          "  # worker:",
          "  db:",
          "    image: postgres:16",
          "volumes:",
          "  data: {}",
        ),
        "deploy/compose.prod.yaml": lines("services:", "  web:", "    image: nginx"),
      }),
    ).toEqual(["compose-service web deploy/compose.prod.yaml:2", "compose-service api docker-compose.yml:3", "compose-service db docker-compose.yml:6"]);
  });

  it("guards: other YAML files are not compose files", () => {
    expect(composeExtractor.applies({ rel: "config/services.yml", text: "" }, memoryContext({}))).toBe(false);
    expect(infraOf({ "config/services.yml": lines("services:", "  mailer: {}") })).toEqual([]);
  });
});

describe("dockerfile extractor", () => {
  it("names the unit by directory, or by <name>.Dockerfile, at the first FROM", () => {
    expect(
      infraOf({
        Dockerfile: lines("# FROM ghost", "FROM node:20 AS build", "FROM nginx"),
        "services/api/Dockerfile.prod": "FROM python:3.12",
        "docker/worker.Dockerfile": "from alpine",
      }),
    ).toEqual(["dockerfile root Dockerfile:2", "dockerfile worker docker/worker.Dockerfile:1", "dockerfile api services/api/Dockerfile.prod:1"]);
  });

  it("guards: no FROM, docs, and other files named like Dockerfiles", () => {
    expect(infraOf({ "a/Dockerfile": "# FROM commented\nRUN x", "docs/Dockerfile.md": "FROM x" })).toEqual([]);
    expect(dockerfileId("src/dockerfile.ts")).toBeUndefined();
  });
});

describe("k8s extractor", () => {
  it("reads Deployment / Service / CronJob names across documents", () => {
    expect(
      infraOf({
        "k8s/api.yaml": lines(
          "apiVersion: apps/v1",
          "kind: Deployment",
          "metadata:",
          "  name: api",
          "  labels: { app: api }",
          "spec:",
          "  template:",
          "    metadata:",
          "      name: not-this",
          "---",
          "apiVersion: v1",
          "kind: Service",
          "metadata:",
          '  name: "api"',
          "---",
          "apiVersion: batch/v1",
          "kind: CronJob",
          "metadata:",
          "  name: report",
        ),
      }),
      // The Deployment and the Service of one unit are one infra fact (first location).
    ).toEqual(["k8s api k8s/api.yaml:2", "k8s report k8s/api.yaml:17"]);
  });

  describe("false-positive guards", () => {
    it("ignores other kinds, commented manifests, templated names, nested kinds and workflows", () => {
      expect(
        infraOf({
          "k8s/cm.yaml": lines("apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: cfg"),
          "k8s/old.yaml": lines("# apiVersion: apps/v1", "# kind: Deployment", "# metadata:", "#   name: ghost"),
          "chart/templates/d.yaml": lines("apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: {{ .Release.Name }}"),
          "conf/x.yaml": lines("apiVersion: 1", "items:", "  - kind: Deployment", "    metadata:", "      name: nested"),
        }),
      ).toEqual([]);
      expect(k8sExtractor.applies({ rel: ".github/workflows/x.yml", text: "apiVersion: v1\nkind: Service\n" }, memoryContext({}))).toBe(false);
    });
  });
});

describe("infra-overlays linker", () => {
  const deployment = (name: string) => lines("apiVersion: apps/v1", "kind: Deployment", "metadata:", `  name: ${name}`);
  const facts = (files: Record<string, string>) => runExtractors("/repo", Object.keys(files), (abs) => files[abs.slice("/repo/".length)]).infra;

  it("keeps one fact per id + kind across env overlays: first location by path, every declaring file listed", () => {
    expect(
      facts({
        ".kontinuous/env/prod/templates/mailpit.yaml": deployment("mailpit"),
        ".kontinuous/env/dev/templates/mailpit.yaml": deployment("mailpit"),
        ".kontinuous/env/preprod/templates/mailpit.yaml": deployment("mailpit"),
        "k8s/overlays/staging/api.yaml": deployment("api"),
        "k8s/base/api.yaml": deployment("api"),
        "docker-compose.yml": lines("services:", "  db:", "    image: postgres"),
        "docker-compose.prod.yml": lines("services:", "  db:", "    image: postgres:16"),
      }),
    ).toEqual([
      {
        id: "mailpit",
        kind: "k8s",
        file: ".kontinuous/env/dev/templates/mailpit.yaml",
        line: 2,
        overlays: [
          ".kontinuous/env/dev/templates/mailpit.yaml",
          ".kontinuous/env/preprod/templates/mailpit.yaml",
          ".kontinuous/env/prod/templates/mailpit.yaml",
        ],
      },
      { id: "db", kind: "compose-service", file: "docker-compose.prod.yml", line: 2, overlays: ["docker-compose.prod.yml", "docker-compose.yml"] },
      { id: "api", kind: "k8s", file: "k8s/base/api.yaml", line: 2, overlays: ["k8s/base/api.yaml", "k8s/overlays/staging/api.yaml"] },
    ]);
  });

  it("false-positive guards: different kinds or ids stay apart, a single file gets no overlays", () => {
    expect(
      facts({
        "api/Dockerfile": "FROM node:20",
        "k8s/api.yaml": deployment("api"),
        "k8s/web.yaml": deployment("web"),
      }),
    ).toEqual([
      { id: "api", kind: "dockerfile", file: "api/Dockerfile", line: 1 },
      { id: "api", kind: "k8s", file: "k8s/api.yaml", line: 2 },
      { id: "web", kind: "k8s", file: "k8s/web.yaml", line: 2 },
    ]);
  });
});
