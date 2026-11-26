import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpus, platform, arch, release } from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { names } from "./plugins.mjs";

const repeats = Number(process.env.BENCH_PAIRS ?? 6);
assert(Number.isSafeInteger(repeats) && repeats >= 2 && repeats % 2 === 0);
const environments = ["estree", "view"];
const read = (file) => JSON.parse(readFileSync("results/" + file));
function worker(engine, mode, label = "") {
  const r = spawnSync(
    process.execPath,
    ["--expose-gc", "run.mjs", engine, mode, label],
    { stdio: "inherit" },
  );
  if (r.error) throw r.error;
  assert.equal(
    r.status,
    0,
    engine + " " + mode + " " + label + " " + (r.signal ?? ""),
  );
}
const corpus = gunzipSync(readFileSync("results/corpus.json.gz"));
const corpusId = createHash("sha256").update(corpus).digest("hex");
const fileCount = JSON.parse(corpus).length;
const host = {
  os: platform(),
  release: release(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  node: process.version,
  v8: process.versions.v8,
};
console.log(host, "corpus sha256", corpusId, "files", fileCount);
for (const engine of environments) worker(engine, "verify");
const [left, right] = environments.map((e) => read("verify-" + e + ".json"));
for (const report of [left, right]) {
  assert.equal(
    report.errors.length,
    0,
    JSON.stringify(report.errors.slice(0, 6)),
  );
  assert.equal(report.records.length, fileCount);
}
for (let i = 0; i < fileCount; i++)
  assert.deepEqual(left.records[i], right.records[i], left.records[i][0]);
const outputId = createHash("sha256")
  .update(JSON.stringify(left.records))
  .digest("hex");
console.log(
  "Verified identical output hashes and edit counts for all files; independent Babel reparse passed.",
  outputId,
);
const samples = { estree: [], view: [] };
for (let pair = 0; pair < repeats; pair++) {
  const order = pair % 2 ? [...environments].reverse() : environments;
  for (const e of order) {
    worker(e, "measure", String(pair + 1));
    const r = read("run-" + (pair + 1) + "-" + e + ".json");
    for (const group of ["app", "deps"]) {
      assert.deepEqual(r.byGroup[group].counts, left.byGroup[group].counts);
      assert.equal(r.byGroup[group].files, left.byGroup[group].files);
      assert.equal(r.byGroup[group].chars, left.byGroup[group].chars);
    }
    samples[e].push(r);
  }
}
function median(a) {
  const sorted = [...a].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const lines = [];
const txt = (s) => lines.push(s);
function row(name, fn) {
  const data = environments.map((e) => samples[e].map(fn));
  const [a, b] = data.map(median);
  txt(
    "| " +
      name +
      " | " +
      a.toFixed(1) +
      " | " +
      b.toFixed(1) +
      " | " +
      (b / a).toFixed(3) +
      " |",
  );
}
txt(
  "## " + host.os + " " + host.arch + " · " + host.cpu + " · Node " + host.node,
);
txt("");
txt(
  fileCount +
    " files, " +
    repeats +
    " samples per implementation. Times are medians in milliseconds.",
);
txt("");
for (const [title, groups] of [
  ["All files", ["app", "deps"]],
  ["Application", ["app"]],
  ["Dependencies", ["deps"]],
]) {
  txt("### " + title);
  txt("");
  txt("| Phase | ESTree ms | AstView ms | AstView / ESTree |");
  txt("|---|---:|---:|---:|");
  const sum = (r, indices) =>
    groups.reduce(
      (n, g) => n + indices.reduce((v, i) => v + r.byGroup[g].ms[i], 0),
      0,
    );
  row("Parse", (r) => sum(r, [0]));
  names.forEach((name, i) => row(name, (r) => sum(r, [i + 1])));
  row("Five transforms", (r) => sum(r, [1, 2, 3, 4, 5]));
  row("Public print", (r) => sum(r, [6]));
  row("Pipeline (phase sum)", (r) => sum(r, [0, 1, 2, 3, 4, 5, 6]));
  if (groups.length === 2) row("Whole corpus (wall)", (r) => r.wallMs);
  txt("");
}
txt("### Edits and matching files");
txt("");
txt("| Plugin | App edits / files | Dependency edits / files |");
txt("|---|---:|---:|");
names.forEach((n, i) => {
  const cell = (g) =>
    left.byGroup[g].counts[i] + " / " + left.byGroup[g].hits[i];
  txt("| " + n + " | " + cell("app") + " | " + cell("deps") + " |");
});
txt("");
txt("Corpus SHA-256: " + corpusId);
txt("");
txt("Verified output and edit SHA-256: " + outputId);
txt("");
const summary = lines.join("\n");
console.log(summary);
writeFileSync("results/summary.md", summary);
writeFileSync(
  "results/samples.json",
  JSON.stringify({ host, corpusId, outputId, samples }, null, 2),
);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
