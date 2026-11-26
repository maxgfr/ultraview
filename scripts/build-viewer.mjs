#!/usr/bin/env node
// Builds the offline viewer: viewer/main.tsx → one minified IIFE + CSS
// (esbuild), inlined with the elkjs worker into viewer/index.html, written
// to skills/ultraview/assets/viewer.html. Byte-reproducible: same sources,
// same bytes (`pnpm run check:build` diffs the committed file).
//
// elkjs (EPL-2.0) ships unmodified: its worker script is deflated (fflate,
// pure JS, deterministic) and base64-encoded into a non-executed
// <script type="application/octet-stream">, preceded by its licence notice;
// the viewer inflates it and starts it as a Blob Web Worker.

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { deflateSync } from "fflate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const out = join(root, "skills/ultraview/assets/viewer.html");

const result = await build({
  entryPoints: [join(root, "viewer/main.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "chrome90", "firefox90", "safari15"],
  jsx: "automatic",
  jsxImportSource: "preact",
  legalComments: "inline",
  charset: "utf8",
  write: false,
  outdir: "out",
  absWorkingDir: root,
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
});

const pick = (ext) => {
  const f = result.outputFiles.find((o) => o.path.endsWith(ext));
  if (!f) throw new Error(`esbuild produced no ${ext} output`);
  return f.text;
};
// Text inlined into <script>/<style> must not close or comment out its element.
const js = pick(".js")
  .replace(/<\/(script)/gi, "<\\/$1")
  .replace(/<!--/g, "<\\!--");
const css = pick(".css").replace(/<\/(style)/gi, "<\\/$1");
for (const [name, text, re] of [
  ["js", js, /<\/script|<!--/i],
  ["css", css, /<\/style/i],
]) {
  if (re.test(text)) throw new Error(`inlined ${name} still holds a closing tag`);
}

const elkPkg = JSON.parse(readFileSync(require.resolve("elkjs/package.json"), "utf8"));
const elkSrc = readFileSync(require.resolve("elkjs/lib/elk-worker.min.js"));
const elkB64 = Buffer.from(deflateSync(new Uint8Array(elkSrc), { level: 9, mem: 8 })).toString("base64");
const elkBlock = [
  `<!-- elkjs ${elkPkg.version} (Eclipse Layout Kernel), Copyright (c) 2017 Kiel University and others.`,
  "     Licensed under the Eclipse Public License 2.0: https://www.eclipse.org/legal/epl-2.0 (SPDX: EPL-2.0).",
  "     Source: https://github.com/kieler/elkjs. Embedded unmodified (lib/elk-worker.min.js), deflate-compressed and base64-encoded. -->",
  `<script type="application/octet-stream" id="ultraview-elk">${elkB64}</script>`,
].join("\n");

const template = readFileSync(join(root, "viewer/index.html"), "utf8");
const marks = ["/*ULTRAVIEW:CSS*/", "/*ULTRAVIEW:JS*/", "<!--ULTRAVIEW:ELK-->"];
for (const m of marks) if (template.split(m).length !== 2) throw new Error(`viewer/index.html must hold ${m} exactly once`);
// Function replacers: `$` in the bundle must not be read as a replacement pattern.
const html = template
  .replace(marks[0], () => css.trim())
  .replace(marks[2], () => elkBlock)
  .replace(marks[1], () => js.trim());

mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp`;
writeFileSync(tmp, html);
renameSync(tmp, out);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
process.stdout.write(
  `viewer     ${kb(Buffer.byteLength(html))} → skills/ultraview/assets/viewer.html (app ${kb(Buffer.byteLength(js))}, css ${kb(Buffer.byteLength(css))}, elkjs ${kb(elkB64.length)} of ${kb(elkSrc.length)})\n`,
);
