# SWC Next AST benchmark

Compare the ESTree object API at the common ancestor `250fe5438` with the AstView API at `999405a00` from [SWC Next #1487](https://github.com/swc-project/swc-next/pull/1487). Each file goes through one public parse, five JavaScript plugin passes on the same AST, and one public, checked `generateSync` call.

## Inputs

The corpus generator reads the original JS, JSX, TS, TSX and declaration files under [react-dashboard](https://github.com/rspack-contrib/build-tools-performance/tree/2ab170cfb8e9376a301d691ea05d01851e72f2d7/cases/react-dashboard), plus the JS-family files loaded by its Rspack production compilation before tree shaking. This includes lazy routes, production dependency entry points and transitive dependencies. Each physical source is included once. All runners download the same compressed UTF-8 corpus, ordered by portable file ID.

## Plugins

| Plugin             | Edit                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Inline environment | Replace direct reads of `process.env.NODE_ENV` with a production string, using a bundler-style global define.                      |
| ESM extensions     | Resolve extensionless relative imports, exports and literal dynamic imports inside the corpus and emit their JS output extensions. |
| Strip JSX markers  | Remove JSX attributes used for test IDs and dashboard readiness checks.                                                            |
| Fold numbers       | Fold literal addition, subtraction and multiplication that produce nonnegative safe integers.                                      |
| Expand shorthand   | Expand object-literal shorthand properties, preserving destructuring and the special `__proto__` key.                              |

These are focused, Babel-style transforms implemented with the native visitor convention of each API. Every plugin walks every file. The suite counts actual edits and files matched.

## Run

Run **AST benchmark** from [GitHub Actions](https://github.com/chenjiahan/swc-next-ast-benchmark/actions/workflows/benchmark.yml), or push to `main`. The workflow pins the fixture, both compiler revisions and Node.js, and builds both native bindings in release mode on each operating system.

For local runs, follow the checkout and build steps in [.github/workflows/benchmark.yml](.github/workflows/benchmark.yml). Run `node corpus.mjs /path/to/cases/react-dashboard` with the dashboard's locked dependencies installed, then `node compare.mjs` from this repository.

## Measurements

Both engines parse with comments enabled and access the program and comments during the parse phase. Each run preloads the source, builds its walkers once, warms the whole corpus once, collects garbage and measures one more complete pass. Each pair uses fresh, sequential Node processes and the order alternates between pairs. The default is six pairs; set `BENCH_PAIRS` to a positive even number of at least two to change it.

The log and job summary report median times for parsing, each transform, all five transforms, printing and the pipeline. Per-sample stage sums and wall times are recorded separately. The latter includes per-file bookkeeping. Startup, file I/O, corpus decompression, warmup and correctness checks run outside the measurement.

Before timing, the suite verifies a representative edit from each plugin, reparses every printed file with Babel, and compares output hashes and per-plugin edit counts across engines for every file. Artifacts include a machine-readable sample report and Markdown summary. Compare ratios within each runner; hosted runner hardware varies.
