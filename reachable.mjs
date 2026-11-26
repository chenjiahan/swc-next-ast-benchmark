// Traverse the native schema on fresh parse output. Only the dynamic-module and
// shorthand cases need this index; the common static-module path stays shallow.
import { layouts } from "./build/view/packages/ast/dist/schema.js";

const edges = layouts.map((layout) =>
  Object.values(layout.fields).filter(
    (descriptor) =>
      Array.isArray(descriptor) && ["node", "list"].includes(descriptor[2]),
  ),
);
const NONE = 0xffffffff;

export function reachableSites(root, flags, k) {
  const ast = root.ast,
    data = ast._view,
    bytes = ast._bytes;
  const properties = [],
    moduleNodes = [];
  function visit(id, parentKind) {
    if (id === NONE) return;
    const kind = bytes[ast._kinds + id],
      payload = ast._payloads + id * 16;
    if (
      flags.shorthand &&
      parentKind === k.ObjectExpression &&
      kind === k.ObjectProperty &&
      bytes[payload + 10] &&
      !bytes[payload + 11] &&
      !bytes[payload + 8]
    ) {
      const key = data.getUint32(payload, true);
      if (ast.node(key).name !== "__proto__") properties.push(id);
    }
    if (
      flags.dynamic &&
      (kind === k.ImportExpression ||
        kind === k.ImportDeclaration ||
        kind === k.ExportNamedDeclaration ||
        kind === k.ExportAllDeclaration)
    )
      moduleNodes.push(id);
    for (const [isExtra, offset, type] of edges[kind]) {
      const at = isExtra
        ? ast._extra +
          (data.getUint32(payload + layouts[kind].extra, true) + offset) * 4
        : payload + offset;
      const first = data.getUint32(at, true);
      if (type === "node") visit(first, kind);
      else {
        const end = data.getUint32(at + 4, true);
        for (let i = first; i < end; i++)
          visit(data.getUint32(ast._extra + i * 4, true), kind);
      }
    }
  }
  visit(ast.rootId, -1);
  return { properties, moduleNodes };
}
