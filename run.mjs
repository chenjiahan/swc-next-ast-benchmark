import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compilePlugins, names } from "./plugins.mjs";

const [engine, mode, label] = process.argv.slice(2);
const api = await import("./build/" + engine + "/npm/core/dist/index.js");
const babel = createRequire(resolve("build/estree/npm/core/package.json"))(
  "@babel/parser",
);
const rows = JSON.parse(gunzipSync(readFileSync("results/corpus.json.gz")));
const files = rows.map((row) => ({
  ...row,
  options: {
    lang: api.langFromPath(row.file),
    sourceType: api.sourceTypeFromPath(row.file),
    comments: "all",
  },
}));
const plugins = compilePlugins(
  api,
  engine === "view",
  new Set([...files.map((f) => f.file), "/demo/helper.ts"]),
);
function reparse(source, file) {
  const lang = file.options.lang;
  const plugins = [];
  if (["tsx", "ts", "dts"].includes(lang))
    plugins.push(["typescript", { dts: lang === "dts" }]);
  if (["jsx", "tsx"].includes(lang)) plugins.push("jsx");
  return babel.parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins,
  });
}
function smoke() {
  const source =
    'import { k } from "./helper"; const name = process.env.NODE_ENV; const el = <p data-testid="p" title={name}/>; export const obj = {name, sum: 2 + 3};';
  const ast = api.parseSync(source, { lang: "tsx" });
  const state = { file: "/demo/entry.tsx", counts: Array(5).fill(0) };
  const program = ast.program;
  for (const plug of plugins) plug.walk(program, state);
  const { code } = api.generateSync(program);
  assert.deepEqual(state.counts, [1, 1, 1, 1, 1]);
  assert.match(code, /helper\.js/);
  assert.match(code, /["']production["']/);
  assert.doesNotMatch(code, /data-testid/);
  assert.match(code, /name:\s*name/);
  assert.match(code, /sum:\s*5/);
}
smoke();
const verify = mode === "verify";
const empty = () => ({
  ms: Array(7).fill(0),
  counts: Array(5).fill(0),
  hits: Array(5).fill(0),
  files: 0,
  chars: 0,
});
function pass(logValidation) {
  const byGroup = { app: empty(), deps: empty() };
  const records = [],
    errors = [];
  const start = performance.now();
  for (const f of files) {
    const tally = byGroup[f.group];
    const counts = Array(5).fill(0);
    const state = { file: f.file, counts };
    let phase = "parse";
    try {
      let at = performance.now();
      const ast = api.parseSync(f.source, f.options);
      const program = ast.program;
      void ast.comments;
      let t = performance.now();
      tally.ms[0] += t - at;
      at = t;
      for (let n = 0; n < 5; n++) {
        phase = names[n];
        plugins[n].walk(program, state);
        t = performance.now();
        tally.ms[n + 1] += t - at;
        at = t;
      }
      phase = "print";
      const code = api.generateSync(program).code;
      t = performance.now();
      tally.ms[6] += t - at;
      tally.files++;
      tally.chars += code.length;
      for (let n = 0; n < 5; n++) {
        tally.counts[n] += counts[n];
        tally.hits[n] += Number(counts[n] > 0);
      }
      if (logValidation) {
        records.push([
          f.file,
          createHash("sha256").update(code).digest("hex"),
          ...counts,
        ]);
        phase = "independent-reparse";
        reparse(code, f);
      }
    } catch (e) {
      if (!logValidation)
        throw Error(f.file + " during " + phase, { cause: e });
      errors.push({
        file: f.file,
        phase,
        message: String(e?.message ?? e),
        stack: e?.stack?.split("\n").slice(0, 4).join("\n"),
      });
    }
  }
  return {
    engine,
    byGroup,
    wallMs: performance.now() - start,
    ...(logValidation ? { records, errors } : {}),
  };
}
if (verify) {
  const report = pass(true);
  writeFileSync("results/verify-" + engine + ".json", JSON.stringify(report));
  console.log(
    engine,
    report.byGroup,
    "errors",
    report.errors.length,
    report.errors.slice(0, 3),
  );
} else {
  pass(false);
  global.gc();
  const report = pass(false);
  writeFileSync(
    "results/run-" + label + "-" + engine + ".json",
    JSON.stringify(report),
  );
  console.log(label, engine, report.wallMs.toFixed(1));
}
