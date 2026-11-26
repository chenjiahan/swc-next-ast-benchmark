import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compilePlugins, names } from "./plugins.mjs";

import { compileExperiment } from "./optimized.mjs";

const strategy = process.env.BENCH_STRATEGY;
const bundle =
  strategy === "pool-index"
    ? "pooled"
    : strategy === "decode-index"
      ? "indexed"
      : "index";
const [engine, mode, label] = process.argv.slice(2);
const api = await import(
  "./build/" + engine + "/npm/core/dist/" + bundle + ".js"
);
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
const fileSet = new Set([
  ...files.map((f) => f.file),
  "/demo/helper.ts",
  "/demo/中文.ts",
  '/demo/a"b.ts',
]);
const reachableSites =
  strategy === "reachable-index"
    ? (await import("./reachable.mjs")).reachableSites
    : undefined;
const plugins = strategy
  ? compileExperiment(api, engine, strategy, fileSet, reachableSites)
  : compilePlugins(api, engine === "view", fileSet);
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
  const state = {
    file: "/demo/entry.tsx",
    sourceText: source,
    counts: Array(5).fill(0),
  };
  const program = ast.program;
  for (const plug of plugins) plug.walk(program, state);
  const { code } = api.generateSync(program);
  if (strategy === "plain-io") {
    assert.deepEqual(state.counts, [0, 0, 0, 0, 0]);
    return;
  }
  assert.deepEqual(state.counts, [1, 1, 1, 1, 1]);
  assert.match(code, /helper\.js/);
  assert.match(code, /["']production["']/);
  assert.doesNotMatch(code, /data-testid/);
  assert.match(code, /name:\s*name/);
  assert.match(code, /sum:\s*5/);
}
smoke();
// Fused visitors use tree order. The ordered variants must also preserve edit
// counts when an early plugin edits a subtree that a later plugin removes.
async function verifyInteractions() {
  if (!strategy || ["fused", "plain-io"].includes(strategy)) return;
  const baseline = await import(
    "./build/" + engine + "/npm/core/dist/index.js"
  );
  const reference = compilePlugins(baseline, engine === "view", fileSet);
  const cases = [
    [
      "js",
      "const n = (1) + (2); class C { #NODE_ENV; read() { return process.env.#NODE_ENV } }",
    ],
    [
      "js",
      String.raw`const strings = ["中文", "","\uD800", "a\nb", "🦀", 'a"b'];`,
    ],
    [
      "tsx",
      '<X data-testid={{name,mode:process.env.NODE_ENV, mod:import("./helper"), n:1+2}} keep={{name,n:(1+2)*3}}/>',
    ],
    [
      "js",
      String.raw`const x = process.env.NOD\u0045_ENV; process.env.NODE_ENV = x; delete process.env.NODE_ENV; process.env?.NODE_ENV;`,
    ],
    ["js", "let x; ({x} = foo); const {x:y} = foo; const o = {x,__proto__};"],
    [
      "js",
      `import "./中文"; export * from './a"b'; export {x} from "./helper";`,
    ],
    [
      "ts",
      'declare module "outer" { export {x} from "./helper"; } import(foo); import("./helper");',
    ],
    ["ts", 'declare module "outer" { export {x} from "./helper"; }'],
    [
      "tsx",
      'const el = <X data-test-id={<Y data-testid="y"/>} other={{a}}/>; const n = (1+2)*(3-1);',
    ],
  ];
  for (const [lang, sourceText] of cases) {
    const apply = (pipeline, binding) => {
      const program = binding.parseSync(sourceText, {
        lang,
        sourceType: "module",
      }).program;
      const state = {
        file: "/demo/entry." + lang,
        sourceText,
        counts: Array(5).fill(0),
      };
      for (const plug of pipeline) plug.walk(program, state);
      return [binding.generateSync(program).code, state.counts];
    };
    assert.deepEqual(
      apply(plugins, api),
      apply(reference, baseline),
      sourceText,
    );
  }
}
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
    const state = { file: f.file, sourceText: f.source, counts };
    let phase = "parse";
    try {
      let at = performance.now();
      const ast = api.parseSync(f.source, f.options);
      const program = ast.program;
      void ast.comments;
      let t = performance.now();
      tally.ms[0] += t - at;
      at = t;
      if (strategy) {
        phase = strategy;
        for (const plug of plugins) plug.walk(program, state);
        t = performance.now();
        tally.ms[1] += t - at;
        at = t;
      } else
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
    strategy,
    byGroup,
    wallMs: performance.now() - start,
    ...(logValidation ? { records, errors } : {}),
  };
}
if (verify) {
  await verifyInteractions();
  const report = pass(true);
  writeFileSync(
    "results/verify-" + (strategy ? strategy + "-" : "") + engine + ".json",
    JSON.stringify(report),
  );
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
