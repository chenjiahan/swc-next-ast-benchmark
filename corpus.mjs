import { createRequire } from "node:module";
import { join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const root = realpathSync(process.argv[2]);
const output = resolve(import.meta.dirname, "results");
mkdirSync(output, { recursive: true });
process.chdir(root);
process.env.NODE_ENV = "production";
process.env.CASE = "react-dashboard";
const require = createRequire(join(root, "package.json"));
const { rspack } = require("@rspack/core");
const { default: config } = await import(
  pathToFileURL(join(root, "rspack.config.mjs"))
);
const { default: shared } = await import(
  pathToFileURL(resolve(root, config.extends))
);
const { extends: ignored, ...overrides } = config;
const graph = new Set();
const js = /\.(?:[cm]?[jt]sx?)$/i;
const src = join(root, "src");
const compiler = rspack({
  ...shared,
  ...overrides,
  context: root,
  mode: "production",
  cache: false,
  module: { ...shared.module, ...overrides.module },
  output: {
    ...overrides.output,
    path: join(output, "unused-build-output"),
    clean: false,
  },
  plugins: [
    ...overrides.plugins,
    {
      apply(c) {
        c.hooks.compilation.tap("SourceManifest", (compilation) => {
          compilation.hooks.finishModules.tap("SourceManifest", (modules) => {
            for (const m of modules) {
              const file = m.resource?.split("?")[0];
              if (file && js.test(file)) graph.add(realpathSync(file));
            }
          });
        });
        c.hooks.shouldEmit.tap("SourceManifest", () => false);
      },
    },
  ],
});
const stats = await new Promise((ok, fail) =>
  compiler.run((err, v) => (err ? fail(err) : ok(v))),
);
await new Promise((ok, fail) =>
  compiler.close((err) => (err ? fail(err) : ok())),
);
if (stats.hasErrors())
  throw Error(stats.toString({ all: false, errors: true, errorDetails: true }));
const source = readdirSync(src, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && js.test(e.name))
  .map((e) => realpathSync(join(e.parentPath, e.name)));
const workspaceRoot = resolve(root, "../..");
const rows = [...new Set([...source, ...graph])]
  .map((file) => {
    const data = readFileSync(file, "utf8");
    const id = "/" + relative(workspaceRoot, file).split(sep).join("/");
    return {
      file: id,
      group: file.startsWith(src + sep) ? "app" : "deps",
      inGraph: graph.has(file),
      source: data,
    };
  })
  .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
const payload = JSON.stringify(rows);
const sha = createHash("sha256").update(payload).digest("hex");
writeFileSync(join(output, "corpus.json.gz"), gzipSync(payload));
console.log("Corpus SHA-256", sha);
console.log(
  rows.reduce((m, r) => {
    const k = r.group + (r.inGraph ? "Graph" : "Extra");
    const item = (m[k] ??= { files: 0, bytes: 0 });
    item.files++;
    item.bytes += Buffer.byteLength(r.source);
    return m;
  }, {}),
);
