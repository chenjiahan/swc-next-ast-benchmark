import { posix } from "node:path";
const { dirname, extname, resolve } = posix;

// Each version compiles the same five visitors once. Only callback and node
// construction conventions differ. No per-file prescan skips a walk.
export const names = [
  "inline-env",
  "esm-extensions",
  "strip-jsx-markers",
  "fold-numbers",
  "expand-shorthand",
];

export function compilePlugins(api, view, fileSet) {
  const wrap = (callback) =>
    view ? (ctx) => callback(ctx.node, ctx) : callback;
  const literal = (value, original) => {
    if (!view)
      return {
        type: "Literal",
        start: original.start,
        end: original.end,
        value,
        raw: JSON.stringify(value),
      };
    const ast = original.ast;
    const kind =
      typeof value === "string"
        ? api.NodeKind.StringLiteral
        : api.NodeKind.NumericLiteral;
    const node = ast.new_node(
      kind,
      ast.utf8Offset(original.start),
      ast.utf8Offset(original.end),
    );
    node.value = value;
    return node;
  };
  function inlineEnv(node, ctx) {
    if (node.computed || node.optional || node.property.name !== "NODE_ENV")
      return;
    const env = node.object;
    if (
      env.type !== "MemberExpression" ||
      env.computed ||
      env.optional ||
      env.property.name !== "env"
    )
      return;
    if (env.object.type !== "Identifier" || env.object.name !== "process")
      return;
    // Bundler-style define for reads; do not rewrite the target of an assignment.
    const parent = ctx.parent;
    if (
      parent &&
      ((ctx.key === "left" && parent.type === "AssignmentExpression") ||
        parent.type === "UpdateExpression" ||
        (parent.type === "UnaryExpression" && parent.operator === "delete"))
    )
      return;
    ctx.replace(literal("production", node));
    ctx.state.counts[0]++;
  }
  function resolveImport(node, ctx) {
    const source = node.source;
    if (
      !source ||
      source.type !== "Literal" ||
      typeof source.value !== "string"
    )
      return;
    const name = source.value;
    if ((!name.startsWith("./") && !name.startsWith("../")) || extname(name))
      return;
    const path = resolve(dirname(ctx.state.file), name);
    for (const stem of ["", "/index"]) {
      for (const extension of [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mts",
        ".mjs",
        ".cts",
        ".cjs",
      ]) {
        if (!fileSet.has(path + stem + extension)) continue;
        const outputExtension = [".mjs", ".mts"].includes(extension)
          ? ".mjs"
          : [".cjs", ".cts"].includes(extension)
            ? ".cjs"
            : ".js";
        node.source = literal(name + stem + outputExtension, source);
        ctx.state.counts[1]++;
        return;
      }
    }
  }
  const markers = new Set([
    "data-testid",
    "data-test-id",
    "data-benchmark-ready",
    "data-insights-ready",
  ]);
  function stripMarker(node, ctx) {
    if (node.name.type === "JSXIdentifier" && markers.has(node.name.name)) {
      ctx.remove();
      ctx.state.counts[2]++;
    }
  }
  function foldNumbers(node, ctx) {
    const op = node.operator;
    if (op !== "+" && op !== "-" && op !== "*") return;
    const left = node.left;
    if (left.type !== "Literal" || typeof left.value !== "number") return;
    const right = node.right;
    if (right.type !== "Literal" || typeof right.value !== "number") return;
    const result =
      op === "+"
        ? left.value + right.value
        : op === "-"
          ? left.value - right.value
          : left.value * right.value;
    if (!Number.isSafeInteger(result) || result < 0 || Object.is(result, -0))
      return;
    ctx.replace(literal(result, node));
    ctx.state.counts[3]++;
  }
  function expandShorthand(node, ctx) {
    if (
      !node.shorthand ||
      node.computed ||
      node.kind !== "init" ||
      node.key.name === "__proto__" ||
      ctx.parent.type !== "ObjectExpression"
    )
      return;
    node.shorthand = false;
    ctx.state.counts[4]++;
  }
  const from = wrap(resolveImport);
  return [
    { MemberExpression: wrap(inlineEnv) },
    {
      ImportDeclaration: from,
      ExportNamedDeclaration: from,
      ExportAllDeclaration: from,
      ImportExpression: from,
    },
    { JSXAttribute: wrap(stripMarker) },
    { BinaryExpression: { leave: wrap(foldNumbers) } },
    { Property: wrap(expandShorthand) },
  ].map((visitor) => api.createWalker(visitor));
}
