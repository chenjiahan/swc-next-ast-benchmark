import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { gunzipSync } from "node:zlib";

const variants = [
  ["estree", "original"],
  ["view", "original"],
  ["estree", "fused"],
  ["view", "fused"],
  ["estree", "object-index"],
  ["view", "flat-index"],
  ["estree", "decode-index"],
  ["view", "range-index"],
  ["estree", "pool-index"],
  ["view", "reachable-index"],
  ["estree", "plain-io"],
  ["view", "plain-io"],
];
const rounds = Number(process.env.BENCH_ROUNDS ?? variants.length);
assert(Number.isSafeInteger(rounds) && rounds >= 2);
const corpus = gunzipSync(readFileSync("results/corpus.json.gz"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const corpusId = hash(corpus);
const fileCount = JSON.parse(corpus).length;
const host = {
  os: platform(),
  release: release(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  node: process.version,
};
const runs = variants.map(([engine, strategy]) => ({
  engine,
  strategy,
  samples: [],
}));
const refs = new Map();
function worker({ engine, strategy }, mode, round = "") {
  const label = strategy + "-" + round;
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", "run.mjs", engine, mode, label],
    { stdio: "inherit", env: { ...process.env, BENCH_STRATEGY: strategy } },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, engine + " " + strategy + " " + mode);
  const path = mode === "verify" ? "verify-" + strategy : "run-" + label;
  return JSON.parse(readFileSync("results/" + path + "-" + engine + ".json"));
}
console.log(host, "Corpus", corpusId, fileCount);
for (const variant of runs) {
  const referenceKey =
    variant.strategy === "plain-io" ? "plain" : "transformed";
  const r = worker(variant, "verify");
  assert.deepEqual(r.errors, []);
  assert.equal(r.records.length, fileCount);
  if (!refs.has(referenceKey)) refs.set(referenceKey, r);
  const expected = refs.get(referenceKey);
  for (let i = 0; i < fileCount; i++)
    assert.deepEqual(
      r.records[i],
      expected.records[i],
      variant.strategy + " " + r.records[i][0],
    );
  variant.counts = Object.values(r.byGroup).map((g) => g.counts);
  variant.chars = Object.values(r.byGroup).map((g) => g.chars);
}
// Williams design: each variant occupies each position and follows every other
// variant once per complete set of rounds. Workers always run sequentially.
const n = variants.length;
const order = Array.from({ length: n }, (_, i) =>
  i % 2 ? (i + 1) / 2 : (n - i / 2) % n,
);
for (let round = 0; round < rounds; round++) {
  for (const offset of order) {
    const variant = runs[(round + offset) % n];
    const r = worker(variant, "measure", round + 1);
    const groups = Object.values(r.byGroup);
    assert.equal(
      groups.reduce((a, b) => a + b.files, 0),
      fileCount,
    );
    assert.deepEqual(
      groups.map((g) => g.counts),
      variant.counts,
    );
    assert.deepEqual(
      groups.map((g) => g.chars),
      variant.chars,
    );
    variant.samples.push(r);
  }
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    (sorted[Math.floor((sorted.length - 1) / 2)] +
      sorted[Math.floor(sorted.length / 2)]) /
    2
  );
}
function metric(run, key) {
  if (key === "wall") return run.wallMs;
  const stage = { parse: 0, transform: 1, print: 6 }[key];
  return run.byGroup.app.ms[stage] + run.byGroup.deps.ms[stage];
}
const outputIds = Object.fromEntries(
  [...refs].map(([name, r]) => [name, hash(JSON.stringify(r.records))]),
);
const lines = [
  "## Optimized plugin pipelines · " +
    host.os +
    " " +
    host.arch +
    " · " +
    host.cpu,
  "",
  fileCount +
    " files, " +
    rounds +
    " independent samples per row. Full-corpus medians in milliseconds.",
  "",
  "| AST | Strategy | Parse | Transform | Print | Wall | Wall min–max |",
  "|---|---|---:|---:|---:|---:|---:|",
];
for (const v of runs) {
  const values = (key) => v.samples.map((r) => metric(r, key));
  v.medians = Object.fromEntries(
    ["parse", "transform", "print", "wall"].map((key) => [
      key,
      median(values(key)),
    ]),
  );
  lines.push(
    "| " +
      [
        v.engine,
        v.strategy,
        ...Object.values(v.medians).map((n) => n.toFixed(1)),
        Math.min(...values("wall")).toFixed(1) +
          "–" +
          Math.max(...values("wall")).toFixed(1),
      ].join(" | ") +
      " |",
  );
}
lines.push(
  "",
  "All transformed variants matched the original per-file output SHA-256 and all five edit counts. Both no-plugin controls matched each other. All outputs reparsed with Babel.",
  "",
  "Corpus SHA-256: " + corpusId,
  "",
  "Transformed output and edit SHA-256: " + outputIds.transformed,
  "",
);
const summary = lines.join("\n");
console.log(summary);
writeFileSync("results/optimization.md", summary);
writeFileSync(
  "results/optimization.json",
  JSON.stringify({ host, corpusId, outputIds, rounds, runs }, null, 2),
);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + summary);
