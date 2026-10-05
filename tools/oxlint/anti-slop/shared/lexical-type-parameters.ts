import type { ESTree } from "@oxlint/plugins";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

function isNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function collectInferTypeParameters(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  bindings: Map<string, ESTree.Node>
): void {
  if (
    node.type === "TSInferType" &&
    !bindings.has(node.typeParameter.name.name)
  ) {
    bindings.set(node.typeParameter.name.name, node.typeParameter);
  }
  // SAFETY: Oxlint's visitor keys name ESTree child fields; values are checked before traversal.
  const record = node as unknown as Readonly<Record<string, unknown>>;
  for (const key of visitorKeys[node.type] ?? []) {
    const value = record[key];
    if (isNode(value)) {
      collectInferTypeParameters(value, visitorKeys, bindings);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const child of value) {
      if (isNode(child))
        collectInferTypeParameters(child, visitorKeys, bindings);
    }
  }
}

/** Resolve the nearest type binder for each name, including mapped and inferred parameters. */
export function lexicalTypeParameterBindings(
  node: ESTree.Node,
  visitorKeys: VisitorKeys
): ReadonlyMap<string, ESTree.Node> {
  const bindings = new Map<string, ESTree.Node>();
  let descendant: ESTree.Node = node;
  let current: ESTree.Node | null = node;
  while (current !== null && current.type !== "Program") {
    if ("typeParameters" in current) {
      for (const parameter of current.typeParameters?.params ?? []) {
        if (!bindings.has(parameter.name.name)) {
          bindings.set(parameter.name.name, parameter);
        }
      }
    }
    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation)
    ) {
      if (!bindings.has(current.key.name)) {
        bindings.set(current.key.name, current.key);
      }
    }
    if (
      current.type === "TSConditionalType" &&
      descendant === current.trueType
    ) {
      collectInferTypeParameters(current.extendsType, visitorKeys, bindings);
    }
    descendant = current;
    current = current.parent;
  }
  return bindings;
}

/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function lexicalTypeParameterNames(
  node: ESTree.Node,
  visitorKeys: VisitorKeys
): ReadonlySet<string> {
  return new Set(lexicalTypeParameterBindings(node, visitorKeys).keys());
}
