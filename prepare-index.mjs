import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

// Instrument only the private benchmark build. Keep the original parse/generate bundle.
const root = resolve("build/estree");
const overlay = join(root, "local/bench-index");
const source = join(root, "packages/protocol/ast");
mkdirSync(overlay, { recursive: true });
for (const name of ["decode.js", "decode-result.js"])
  copyFileSync(join(source, name), join(overlay, name));
const emit = new Map([
  [
    0,
    'Object.defineProperty(result, Symbol.for("bench.candidates"), { value: candidates });',
  ],
  [
    21,
    'if (typeof result.left.value === "number" && typeof result.right.value === "number") candidates.fold = true;',
  ],
  [
    64,
    'if (result.shorthand && !result.computed && result.kind === "init" && result.key.name !== "__proto__") candidates.shorthand.push(result);',
  ],
  [
    68,
    'if (!result.computed && result.property.name === "NODE_ENV") candidates.env = true;',
  ],
  [
    170,
    'if (result.name.type === "JSXIdentifier" && markers.has(result.name.name)) candidates.jsx = true;',
  ],
  ...[76, 77, 82, 84].map((id) => [
    id,
    'if (result.source?.type === "Literal" && typeof result.source.value === "string") candidates.sources.push(result.source);',
  ]),
]);
for (const name of ["decode-js.js", "decode-ts.js"]) {
  let code = readFileSync(join(source, name), "utf8");
  const marker = "const NULL = -1;";
  assert(code.includes(marker));
  code = code.replace(
    marker,
    marker +
      '\nconst markers = new Set(["data-testid","data-test-id","data-benchmark-ready","data-insights-ready"]);\nconst plan = () => ({sources:[],shorthand:[],env:false,jsx:false,fold:false});',
  );
  const first = "const spans = HEADER_SIZE;";
  assert(code.includes(first));
  code = code.replace(first, "let candidates = plan();\n  " + first);
  const seen = new Set();
  code = code.replace(
    /(      case (\d+): \{[^]*?)(        break;\n      \})/g,
    (whole, body, kind, end) => {
      const op = emit.get(Number(kind));
      if (!op) return whole;
      seen.add(Number(kind));
      return body + "        " + op + "\n" + end;
    },
  );
  assert.deepEqual([...seen].sort(), [...emit.keys()].sort());
  // A failed hot decoder may already have recorded children before retrying.
  code = code.replace(
    "node = nodeAll;\n      return nodeAll(programIndex);",
    "node = nodeAll;\n      candidates = plan();\n      return nodeAll(programIndex);",
  );
  writeFileSync(join(overlay, name), code);
}
copyFileSync(join(source, "encode.js"), join(overlay, "encode.js"));
for (const name of ["encode-js.js", "encode-ts.js"]) {
  let code = readFileSync(join(source, name), "utf8");
  const original =
    "  encStr(v_0, payload, index * 16 + 0, true);\n  encStr(v_1, payload, index * 16 + 8);";
  assert.equal(code.split(original).length, 2);
  const fast = `  if (typeof v_0 === "string" && typeof v_1 === "string" &&
      v_1.length === v_0.length + 2 && (v_1[0] === '"' || v_1[0] === "'") &&
      v_1.at(-1) === v_1[0] && v_1.startsWith(v_0, 1) && isWellFormed(v_0)) {
    // Store the quoted spelling once and point the value inside its UTF-8 range.
    const start = poolLength;
    encStr(v_1, payload, index * 16 + 8);
    payload.setUint32(index * 16, start+1, true);
    payload.setUint32(index * 16+4, poolLength-1, true);
    return index;
  }
`;
  writeFileSync(join(overlay, name), code.replace(original, fast + original));
}
for (const [name, shareStrings] of [
  ["indexed", false],
  ["pooled", true],
]) {
  const encodeAlias = shareStrings
    ? ',"@swc-next/protocol/ast/encode$":path.join(import.meta.dirname,"encode.js")'
    : "";
  const config = `import base from "../../rslib.config.js";
import path from "node:path";
const core = base.lib.find(lib => lib.id === "core");
export default { lib: [{...core, resolve: {alias: {"@swc-next/protocol/ast/decode$":path.join(import.meta.dirname,"decode.js")${encodeAlias}}}, output: {...core.output,distPath:{root:path.join(import.meta.dirname,"out")}}}] };`;
  writeFileSync(join(overlay, "rslib.config.mjs"), config);
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/@rslib/core/bin/rslib.js"),
      "build",
      "--config",
      join(overlay, "rslib.config.mjs"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  copyFileSync(
    join(overlay, "out/index.js"),
    join(root, "npm/core/dist/" + name + ".js"),
  );
}
