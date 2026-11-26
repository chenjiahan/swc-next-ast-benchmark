import { createPluginHooks, resolveIndexedModule } from "./plugins.mjs";

const markers = new Set([
  "data-testid",
  "data-test-id",
  "data-benchmark-ready",
  "data-insights-ready",
]);
const indexKey = Symbol.for("bench.candidates");
const NONE = 0xffffffff;

// A public-API-only alternative to collecting candidates in the ESTree decoder.
function indexObjects(keys) {
  const inspect = {
    MemberExpression(node, p) {
      if (!node.computed && node.property.name === "NODE_ENV") p.env = true;
    },
    BinaryExpression(node, p) {
      if (
        typeof node.left.value === "number" &&
        typeof node.right.value === "number"
      )
        p.fold = true;
    },
    JSXAttribute(node, p) {
      if (node.name.type === "JSXIdentifier" && markers.has(node.name.name))
        p.jsx = true;
    },
    Property(node, p, parent) {
      if (
        parent.type === "ObjectExpression" &&
        node.shorthand &&
        !node.computed &&
        node.kind === "init" &&
        node.key.name !== "__proto__"
      )
        p.shorthand.push(node);
    },
  };
  for (const type of [
    "ImportDeclaration",
    "ImportExpression",
    "ExportNamedDeclaration",
    "ExportAllDeclaration",
  ]) {
    inspect[type] = (node, p) => {
      if (
        node.source?.type === "Literal" &&
        typeof node.source.value === "string"
      )
        p.sources.push(node.source);
    };
  }
  function visit(node, p, parent) {
    inspect[node.type]?.(node, p, parent);
    for (const key of keys[node.type]) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item) visit(item, p, node);
      } else if (child) visit(child, p, node);
    }
  }
  return (root) => {
    const p = {
      sources: [],
      shorthand: [],
      fold: false,
      env: false,
      jsx: false,
    };
    visit(root, p, null);
    return p;
  };
}

function editLiteral(literal, state, fileSet, view) {
  const next = resolveIndexedModule(literal.value, state, fileSet);
  if (next === undefined) return;
  literal.value = next;
  if (!view) literal.raw = JSON.stringify(next);
  state.counts[1]++;
}

// The base kind column and payload sizes below are private to the pinned PR ABI.
// Inspect fresh parser output before edits. Detached rows can only add fallback work.
// A folded parent always has a foldable literal pair somewhere below it initially.
function couldProjectNumber(kind, k) {
  return kind === k.NumericLiteral || kind === k.ParenthesizedExpression;
}

function indexView(root, state, k) {
  const ast = root.ast,
    bytes = ast._bytes,
    data = ast._view,
    kinds = ast._kinds;
  const mayEscape = state.sourceText.includes("\\");
  const mayEnv = mayEscape || state.sourceText.includes("NODE_ENV");
  const mayJsx = mayEscape || state.sourceText.includes("data-");
  let env = false,
    jsx = false,
    fold = false,
    shorthand = false,
    staticCount = 0,
    dynamic = false;
  for (let id = 0; id < ast.nodeCount; id++) {
    const kind = bytes[kinds + id];
    const p = ast._payloads + id * 16;
    switch (kind) {
      case k.MemberExpression:
        if (mayEnv && !env && !bytes[p + 8] && !bytes[p + 9]) {
          const prop = data.getUint32(p + 4, true);
          if (ast.node(prop).name === "NODE_ENV") env = true;
        }
        break;
      case k.JsxAttribute:
        if (mayJsx && !jsx) {
          const name = data.getUint32(p, true);
          if (
            bytes[kinds + name] === k.JsxIdentifier &&
            markers.has(ast.node(name).name)
          )
            jsx = true;
        }
        break;
      case k.BinaryExpression:
        if (
          !fold &&
          couldProjectNumber(bytes[kinds + data.getUint32(p, true)], k) &&
          couldProjectNumber(bytes[kinds + data.getUint32(p + 4, true)], k)
        )
          fold = true;
        break;
      case k.ObjectProperty:
        if (bytes[p + 10]) shorthand = true;
        break;
      case k.ImportExpression:
        dynamic = true;
        break;
      case k.ImportDeclaration:
      case k.ExportAllDeclaration:
      case k.ExportNamedDeclaration:
        staticCount++;
        break;
    }
  }
  return { env, jsx, fold, shorthand, staticCount, dynamic };
}

function editStringRange(ast, id, state, fileSet) {
  const offset = ast._payloads + id * 16;
  const next = resolveIndexedModule(
    ast.stringAt(offset, false),
    state,
    fileSet,
  );
  if (next === undefined) return;
  const raw = JSON.stringify(next);
  ast._writeStringAt(id, 8, false, raw);
  if (raw.length === next.length + 2) {
    // The cooked value is the UTF-8 byte range between the two ASCII quotes.
    const data = ast._view;
    data.setUint32(offset, data.getUint32(offset + 8, true) + 1, true);
    data.setUint32(offset + 4, data.getUint32(offset + 12, true) - 1, true);
  } else {
    ast._writeStringAt(id, 0, false, next);
  }
  state.counts[1]++;
}

function rewriteViewImports(
  root,
  p,
  state,
  fileSet,
  k,
  fullWalk,
  shareStrings,
  sites,
) {
  if (p.dynamic) {
    if (!sites) fullWalk.walk(root, state);
    else
      for (const id of sites.moduleNodes) {
        const literal = root.ast.node(id).source;
        if (literal?.type === "Literal" && typeof literal.value === "string")
          editLiteral(literal, state, fileSet, true);
      }
    return;
  }
  if (!p.staticCount) return;
  const ast = root.ast,
    list = root.body,
    length = list.length,
    ids = [];
  const bytes = ast._bytes,
    data = ast._view;
  let found = 0;
  for (let i = 0; i < length; i++) {
    const id = list.nodeId(i),
      kind = bytes[ast._kinds + id],
      offset = ast._payloads + id * 16;
    let sourceId;
    if (kind === k.ImportDeclaration) {
      const extra = data.getUint32(offset + 12, true);
      sourceId = data.getUint32(ast._extra + extra * 4, true);
    } else if (
      kind === k.ExportNamedDeclaration ||
      kind === k.ExportAllDeclaration
    ) {
      sourceId = data.getUint32(offset + 4, true);
    } else continue;
    found++;
    if (sourceId !== NONE) ids.push(sourceId);
  }
  // Namespace declarations and unreachable parser rows may raise the count.
  // Use the canonical traversal before performing any edits if coverage is uncertain.
  if (found !== p.staticCount) {
    fullWalk.walk(root, state);
    return;
  }
  for (const id of ids) {
    if (shareStrings) editStringRange(ast, id, state, fileSet);
    else editLiteral(ast.node(id), state, fileSet, true);
  }
}

export function compileExperiment(api, engine, mode, fileSet, reachableSites) {
  const view = engine === "view";
  const hooks = createPluginHooks(api, view, fileSet);
  if (mode === "original") return hooks.map((h) => api.createWalker(h));
  if (mode === "plain-io") return [];
  if (mode === "fused") {
    const merged = Object.assign({}, ...hooks);
    if (Object.keys(merged).length !== hooks.flatMap(Object.keys).length)
      throw Error("Overlapping visitor keys");
    return [api.createWalker(merged)];
  }
  const walkers = hooks.map((h) => api.createWalker(h));
  const collect =
    mode === "object-index"
      ? indexObjects(api.visitorKeys)
      : (root) => root[indexKey];
  return [
    {
      walk(root, state) {
        const p = view ? indexView(root, state, api.NodeKind) : collect(root);
        const sites =
          reachableSites && (p.dynamic || (p.shorthand && !p.jsx))
            ? reachableSites(root, p, api.NodeKind)
            : null;
        if (p.env) walkers[0].walk(root, state);
        if (view)
          rewriteViewImports(
            root,
            p,
            state,
            fileSet,
            api.NodeKind,
            walkers[1],
            mode === "range-index" || mode === "reachable-index",
            sites,
          );
        else
          for (const literal of p.sources)
            editLiteral(literal, state, fileSet, false);
        if (p.jsx) walkers[2].walk(root, state);
        if (p.fold) walkers[3].walk(root, state);
        if (view) {
          if (p.shorthand && (!sites || p.jsx)) walkers[4].walk(root, state);
          else if (sites)
            for (const id of sites.properties) {
              const offset = root.ast._payloads + id * 16 + 10;
              if (root.ast._bytes[offset]) {
                root.ast._writeBoolAt(id, 10, false);
                state.counts[4]++;
              }
            }
        } else if (p.shorthand.length) {
          if (p.jsx) walkers[4].walk(root, state);
          else
            for (const node of p.shorthand) {
              node.shorthand = false;
              state.counts[4]++;
            }
        }
      },
    },
  ];
}
