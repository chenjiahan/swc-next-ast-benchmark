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

## Optimization experiment

After the original benchmark, run `node prepare-index.mjs` and `node optimize.mjs`. The experiment uses the same native releases, inputs, five rules and checked printer. Each of the twelve variants gets twelve samples by default. Their positions and immediate predecessors rotate between rounds. Set `BENCH_ROUNDS` for shorter local runs.

| Strategy                | What happens inside the timed pipeline                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original                | Run all five visitors in five ordered passes.                                                                                                        |
| Fused                   | Merge the five visitors into one tree traversal. This measures a scheduling change. Overlapping plugins can observe a different order.               |
| ESTree object index     | Build a candidate index by walking the decoded objects, then apply the rules in order.                                                               |
| ESTree decode index     | Record candidates while decoding ordinary ESTree objects. Candidate discovery is included in parse time.                                             |
| ESTree pool index       | Add a printer fast path to the decode index. Eligible string literals store the quoted spelling once and reference its UTF-8 interior for the value. |
| AstView flat index      | Scan the binary kind and payload columns. Handle top-level static imports directly, with walker fallbacks for nested or dynamic forms.               |
| AstView range index     | Also share eligible raw and cooked string ranges when editing static imports.                                                                        |
| AstView reachable index | Also follow native child IDs for dynamic modules and shorthand properties. This removes additional wrapper allocations and full visitor passes.      |
| Plain I/O               | Parse and print the original program with zero plugins. This control generates different output from the transformed runs.                           |

The indexed strategies specialize in these five rules. Both engines use the same shortcut for normalized relative paths. Indexing, module resolution and edits are timed for every file, including the measured pass after warmup. There is no result cache across files or runs. The AstView prototypes use the pinned private binary layout. The ESTree codec prototypes build into separate bundles. The original bundles and the checked native printer are used as correctness references.

The harness compares the output hash and all five edit counts for each file, and reparses all outputs with Babel. Additional fixtures test ordered plugins with edits inside deleted JSX attributes, assignment patterns, escaped identifiers, quoted and Unicode module names, nested modules and dynamic imports. The controls are compared to each other. CI logs and artifacts report stage medians, whole-pipeline wall times, and the raw samples for each runner.
