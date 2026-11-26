// Deployable units declared in infrastructure files.
//
//   docker-compose  `services:` keys of docker-compose*.yml / compose*.yaml
//                   → { id: <service>, kind: "compose-service" }
//   Dockerfile      `Dockerfile`, `Dockerfile.<variant>` (dev, prod…) → id =
//                   the directory's name ("root" at the repo root);
//                   `<name>.Dockerfile` → id = <name> (several units often
//                   share one docker/ directory); kind "dockerfile", at the
//                   first FROM
//   Kubernetes      YAML documents with `apiVersion` and a `kind` of
//                   Deployment / StatefulSet / DaemonSet / Service / CronJob
//                   → { id: metadata.name, kind: "k8s" }, at the `kind` line;
//                   templated names (`{{ … }}`) are skipped.

import { lineIndex, maskSource } from "./mask.js";
import type { ExtractInput, ExtractOutput, Extractor, InfraFact } from "./types.js";
import { yamlChild, yamlDocuments } from "./yaml.js";

function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

const COMPOSE = /^(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i;

function isYaml(rel: string): boolean {
  return /\.ya?ml$/i.test(rel);
}

function extractCompose(input: ExtractInput): ExtractOutput {
  const infra: InfraFact[] = [];
  for (const doc of yamlDocuments(input.text)) {
    for (const svc of yamlChild(doc, "services")?.children ?? []) {
      if (svc.key && !svc.item) infra.push({ id: svc.key, kind: "compose-service", file: input.rel, line: svc.line });
    }
  }
  return infra.length ? { infra } : {};
}

export const composeExtractor: Extractor = {
  id: "docker-compose",
  applies: (input: ExtractInput) => COMPOSE.test(baseOf(input.rel)),
  extract: extractCompose,
};

/** Suffixes that make `Dockerfile.<x>` a document or a source file, not a build variant. */
const NOT_A_VARIANT = /^(?:md|markdown|txt|rst|json|ya?ml|toml|[cm]?[jt]sx?|py|sh|lock|bak|orig|swp|tmpl|j2|dockerignore)$/i;

/** The unit a Dockerfile builds: `<name>` of `<name>.Dockerfile`, else its directory's name. */
export function dockerfileId(rel: string): string | undefined {
  const base = baseOf(rel);
  const named = /^([\w.-]+)\.Dockerfile$/i.exec(base);
  if (named) return named[1] as string;
  const plain = /^(?:Dockerfile|Containerfile|dockerfile)$/.test(base);
  const variant = /^(?:Dockerfile|Containerfile)\.([\w-]+)$/.exec(base);
  if (!plain && !(variant && !NOT_A_VARIANT.test(variant[1] as string))) return undefined;
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  return dir ? baseOf(dir) : "root";
}

function extractDockerfile(input: ExtractInput): ExtractOutput {
  const id = dockerfileId(input.rel);
  if (!id) return {};
  const text = maskSource(input.rel, input.text);
  const from = /^[ \t]*FROM[ \t]+\S/im.exec(text);
  if (!from) return {};
  return { infra: [{ id, kind: "dockerfile", file: input.rel, line: lineIndex(text)(from.index) }] };
}

export const dockerfileExtractor: Extractor = {
  id: "dockerfile",
  applies: (input: ExtractInput) => dockerfileId(input.rel) !== undefined,
  extract: extractDockerfile,
};

const K8S_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Service", "CronJob"]);

function extractK8s(input: ExtractInput): ExtractOutput {
  const infra: InfraFact[] = [];
  for (const doc of yamlDocuments(input.text)) {
    const kind = yamlChild(doc, "kind");
    if (!kind?.value || !K8S_KINDS.has(kind.value) || !yamlChild(doc, "apiVersion")?.value) continue;
    const name = yamlChild(yamlChild(doc, "metadata")?.children, "name")?.value;
    if (!name || name.includes("{{")) continue;
    infra.push({ id: name, kind: "k8s", file: input.rel, line: kind.line });
  }
  return infra.length ? { infra } : {};
}

export const k8sExtractor: Extractor = {
  id: "k8s",
  applies: (input: ExtractInput) =>
    isYaml(input.rel) &&
    !COMPOSE.test(baseOf(input.rel)) &&
    !input.rel.startsWith(".github/") &&
    /^kind:/m.test(input.text) &&
    /^apiVersion:/m.test(input.text),
  extract: extractK8s,
};
