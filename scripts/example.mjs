#!/usr/bin/env node
// Rebuilds assets/example/index.html: the shop fixture (tests/fixtures/
// shop-express-prisma) mapped with its test model, flow and lens
// (tests/fixtures-models), rendered by the committed bundle. The page is
// self-contained and offline; the machine-local repo path the viewer keeps for
// open-in-editor links is blanked, so nothing of this machine is committed.
//
//   node scripts/example.mjs [--keep]   (--keep leaves the built temp repo and prints its path)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "scripts", "ultraview.mjs");
const models = join(root, "tests", "fixtures-models");
const keep = process.argv.includes("--keep");
const env = { ...process.env, CODEINDEX_NO_GRAMMARS_PULL: "1" };
const run = (...args) => execFileSync("node", [bundle, ...args], { encoding: "utf8", env });

const tmp = mkdtempSync(join(tmpdir(), "ultraview-example-"));
const repo = join(tmp, "shop");
cpSync(join(root, "tests", "fixtures", "shop-express-prisma"), repo, { recursive: true });
mkdirSync(join(repo, ".ultraview"), { recursive: true });
cpSync(join(models, "shop.model.json"), join(repo, ".ultraview", "model.json"));
run("build", "--repo", repo, "--no-ast");
run("lens", "save", join(models, "shop.lens.json"), "--repo", repo);
run("flow", "save", join(models, "shop.flow.json"), "--repo", repo);
run("check", "--repo", repo);
run("render", "--repo", repo);

const html = readFileSync(join(repo, ".ultraview", "index.html"), "utf8")
  .split(JSON.stringify(repo))
  .join('""');
if (html.includes(tmp)) throw new Error("the page still holds the temp path");
const out = join(root, "assets", "example", "index.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
process.stdout.write(`wrote ${out} (${Buffer.byteLength(html)} bytes)\n`);
if (keep) process.stdout.write(`kept ${repo}\n`);
else rmSync(tmp, { recursive: true, force: true });
