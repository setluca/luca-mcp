import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterBindings } from "./lexical-type-parameters.ts";
import {
  createTypeAliasEnvironment,
  hasVisibleTypeBinding,
  visibleTypeAlias,
  type TypeAliasEnvironment as LexicalTypeAliasEnvironment,
} from "./type-alias-resolution.ts";

const BUILT_INS = new Set([
  "Record",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "PropertyKey",
  "NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set([
  "Readonly",
  "Partial",
  "Required",
  "NonNullable",
]);

type TypeSubstitutions = ReadonlyMap<ESTree.Node, ResolvedType>;
type ResolvingAliases = ReadonlySet<ESTree.TSTypeAliasDeclaration>;

type ResolvedType = {
  readonly type: ESTree.TSType;
  readonly substitutions: TypeSubstitutions;
  readonly resolvingAliases: ResolvingAliases;
};

export type UnsafeDictionary = {
  readonly kind: "unsafe-dictionary";
  readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown";
};

export type WideningTargetKind =
  | "anonymous object"
  | "generic container"
  | "object"
  | "open dictionary"
  | "unknown";

export type WideningTarget = {
  readonly kind: WideningTargetKind;
};

export type TypeEnvironment = {
  readonly interfaces: ReadonlyMap<
    string,
    readonly ESTree.TSInterfaceDeclaration[]
  >;
  readonly typeAliases: LexicalTypeAliasEnvironment;
};

function declaredStatement(statement: ESTree.Statement): ESTree.Node | null {
  return statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
    ? (statement.declaration ?? null)
    : statement;
}

export function createTypeEnvironment(
  program: ESTree.Program,
  visitorKeys: Readonly<Record<string, readonly string[]>>
): TypeEnvironment {
  const interfaces = new Map<string, ESTree.TSInterfaceDeclaration[]>();

  for (const statement of program.body) {
    const declaration = declaredStatement(statement);
    if (declaration?.type !== "TSInterfaceDeclaration") continue;
    const declarations = interfaces.get(declaration.id.name) ?? [];
    declarations.push(declaration);
    interfaces.set(declaration.id.name, declarations);
  }

  return {
    interfaces,
    typeAliases: createTypeAliasEnvironment(program, visitorKeys),
  };
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isBuiltIn(
  name: string,
  use: ESTree.Node,
  environment: TypeEnvironment
): boolean {
  return (
    BUILT_INS.has(name) &&
    !hasVisibleTypeBinding(name, use, environment.typeAliases)
  );
}

function unwrapTransparentType(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
}

function isNeverType(type: ESTree.TSType): boolean {
  return unwrapTransparentType(type).type === "TSNeverKeyword";
}

function isEffectivelyEmptyMember(member: ESTree.TSSignature): boolean {
  return (
    member.type === "TSPropertySignature" &&
    member.optional === true &&
    member.typeAnnotation !== null &&
    member.typeAnnotation !== undefined &&
    isNeverType(member.typeAnnotation.typeAnnotation)
  );
}

function isEffectivelyEmptyTypeLiteral(type: ESTree.TSTypeLiteral): boolean {
  return (
    type.members.length === 0 || type.members.every(isEffectivelyEmptyMember)
  );
}

function isEffectivelyEmptyInterface(
  declarations: readonly ESTree.TSInterfaceDeclaration[]
): boolean {
  if (declarations.length !== 1) return false;
  const [type] = declarations;
  return (
    type !== undefined &&
    type.extends.length === 0 &&
    (type.body.body.length === 0 ||
      type.body.body.every(isEffectivelyEmptyMember))
  );
}

function typeSubstitution(
  type: ESTree.TSTypeReference,
  environment: TypeEnvironment,
  substitutions: TypeSubstitutions
): ResolvedType | undefined {
  if (type.typeArguments?.params.length) return undefined;
  const name = typeReferenceName(type);
  if (name === null) return undefined;
  const parameter = lexicalTypeParameterBindings(
    type,
    environment.typeAliases.visitorKeys
  ).get(name);
  return parameter === undefined ? undefined : substitutions.get(parameter);
}

function aliasSubstitution(
  alias: ESTree.TSTypeAliasDeclaration,
  type: ESTree.TSTypeReference,
  base: TypeSubstitutions,
  resolvingAliases: ResolvingAliases
): TypeSubstitutions | null {
  const parameters = alias.typeParameters?.params ?? [];
  const arguments_ = type.typeArguments?.params ?? [];
  const next = new Map(base);
  const defaultResolving = new Set(resolvingAliases);
  defaultResolving.add(alias);
  for (const [index, parameter] of parameters.entries()) {
    const explicitArgument = arguments_[index];
    const argument = explicitArgument ?? parameter.default;
    if (argument === null || argument === undefined) return null;
    // Explicit arguments belong to the caller. Defaults can use earlier parameters.
    next.set(parameter, {
      type: argument,
      substitutions: explicitArgument === undefined ? new Map(next) : base,
      resolvingAliases:
        explicitArgument === undefined ? defaultResolving : resolvingAliases,
    });
  }
  return next;
}

function unsafeDirectValue(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeSubstitutions,
  resolvingAliases: ResolvingAliases
): UnsafeDictionary["unsafeValue"] | null {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return "unknown";
  if (unwrapped.type === "TSAnyKeyword") return "any";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  if (
    unwrapped.type === "TSTypeLiteral" &&
    isEffectivelyEmptyTypeLiteral(unwrapped)
  )
    return "empty-object";
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.some(
      (member) =>
        unsafeDirectValue(
          member,
          environment,
          substitutions,
          resolvingAliases
        ) !== null
    )
      ? "union"
      : null;
  }
  if (unwrapped.type === "TSIntersectionType") {
    const unsafeMembers = unwrapped.types.map((member) =>
      unsafeDirectValue(member, environment, substitutions, resolvingAliases)
    );
    if (unsafeMembers.includes("any")) return "any";
    return unsafeMembers.length > 0 &&
      unsafeMembers.every((member) => member !== null)
      ? unsafeMembers[0]
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  if (
    TRANSPARENT_WRAPPERS.has(name) &&
    isBuiltIn(name, unwrapped, environment)
  ) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : unsafeDirectValue(
          wrapped,
          environment,
          substitutions,
          resolvingAliases
        );
  }
  const substitution = typeSubstitution(unwrapped, environment, substitutions);
  if (substitution !== undefined) {
    return unsafeDirectValue(
      substitution.type,
      environment,
      substitution.substitutions,
      substitution.resolvingAliases
    );
  }
  const interfaceDeclarations = environment.interfaces.get(name);
  if (interfaceDeclarations !== undefined) {
    return isEffectivelyEmptyInterface(interfaceDeclarations)
      ? "empty-object"
      : null;
  }
  const alias = visibleTypeAlias(name, unwrapped, environment.typeAliases);
  if (alias === null || resolvingAliases.has(alias)) return null;
  const nextSubstitutions = aliasSubstitution(
    alias,
    unwrapped,
    substitutions,
    resolvingAliases
  );
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(alias);
  return unsafeDirectValue(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving
  );
}

function dictionaryValueTypes(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeSubstitutions,
  resolvingAliases: ResolvingAliases
): readonly ResolvedType[] {
  const unwrapped = unwrapTransparentType(type);

  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member): readonly ResolvedType[] =>
      member.type === "TSIndexSignature" && member.typeAnnotation !== null
        ? [
            {
              type: member.typeAnnotation.typeAnnotation,
              substitutions,
              resolvingAliases,
            },
          ]
        : []
    );
  }

  if (unwrapped.type === "TSMappedType") {
    return unwrapped.typeAnnotation === null
      ? []
      : [{ type: unwrapped.typeAnnotation, substitutions, resolvingAliases }];
  }

  if (unwrapped.type !== "TSTypeReference") return [];
  const name = typeReferenceName(unwrapped);
  if (name === null) return [];

  const substitution = typeSubstitution(unwrapped, environment, substitutions);
  if (substitution !== undefined) {
    return dictionaryValueTypes(
      substitution.type,
      environment,
      substitution.substitutions,
      substitution.resolvingAliases
    );
  }

  if (
    TRANSPARENT_WRAPPERS.has(name) &&
    isBuiltIn(name, unwrapped, environment)
  ) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? []
      : dictionaryValueTypes(
          wrapped,
          environment,
          substitutions,
          resolvingAliases
        );
  }

  if (name === "Record" && isBuiltIn(name, unwrapped, environment)) {
    const value = unwrapped.typeArguments?.params[1] ?? null;
    return value === null
      ? []
      : [{ type: value, substitutions, resolvingAliases }];
  }

  if (
    (name === "Pick" || name === "Omit") &&
    isBuiltIn(name, unwrapped, environment)
  ) {
    const source = unwrapped.typeArguments?.params[0];
    return source === undefined
      ? []
      : dictionaryValueTypes(
          source,
          environment,
          substitutions,
          resolvingAliases
        );
  }

  const alias = visibleTypeAlias(name, unwrapped, environment.typeAliases);
  if (alias === null || resolvingAliases.has(alias)) return [];
  const nextSubstitutions = aliasSubstitution(
    alias,
    unwrapped,
    substitutions,
    resolvingAliases
  );
  if (nextSubstitutions === null) return [];
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(alias);
  return dictionaryValueTypes(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving
  );
}

export function classifyUnsafeDictionaryValue(
  valueType: ESTree.TSType,
  environment: TypeEnvironment
): UnsafeDictionary | null {
  const unsafeValue = unsafeDirectValue(
    valueType,
    environment,
    new Map(),
    new Set()
  );
  return unsafeValue === null
    ? null
    : { kind: "unsafe-dictionary", unsafeValue };
}

export function classifyUnsafeDictionary(
  type: ESTree.TSType,
  environment: TypeEnvironment
): UnsafeDictionary | null {
  for (const valueType of dictionaryValueTypes(
    type,
    environment,
    new Map(),
    new Set()
  )) {
    const unsafeValue = unsafeDirectValue(
      valueType.type,
      environment,
      valueType.substitutions,
      valueType.resolvingAliases
    );
    if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
  }
  return null;
}

export function classifyWideningTarget(
  type: ESTree.TSType,
  environment: TypeEnvironment
): WideningTarget | null {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some(
      (member) => member.type === "TSIndexSignature"
    )
      ? { kind: "open dictionary" }
      : unwrapped.members.length > 0
        ? { kind: "anonymous object" }
        : null;
  }
  if (unwrapped.type === "TSMappedType") return { kind: "open dictionary" };
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  if (
    TRANSPARENT_WRAPPERS.has(name) &&
    isBuiltIn(name, unwrapped, environment)
  ) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyWideningTarget(wrapped, environment);
  }
  if (name === "Record" && isBuiltIn(name, unwrapped, environment)) {
    return hasBroadRecordKey(unwrapped, environment, new Map())
      ? { kind: "open dictionary" }
      : null;
  }
  const alias = visibleTypeAlias(name, unwrapped, environment.typeAliases);
  if (alias === null) return null;
  if ((alias.typeParameters?.params.length ?? 0) > 0) {
    const substitutions = aliasSubstitution(
      alias,
      unwrapped,
      new Map(),
      new Set()
    );
    const resolved =
      substitutions === null
        ? null
        : classifyAliasBroadTarget(
            alias.typeAnnotation,
            environment,
            substitutions,
            new Set([alias])
          );
    return resolved?.kind === "open dictionary"
      ? { kind: "generic container" }
      : null;
  }
  const substitutions = aliasSubstitution(
    alias,
    unwrapped,
    new Map(),
    new Set()
  );
  if (substitutions === null) return null;
  const resolved = classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    substitutions,
    new Set([alias])
  );
  return resolved;
}

function hasBroadRecordKey(
  type: ESTree.TSTypeReference,
  environment: TypeEnvironment,
  substitutions: TypeSubstitutions
): boolean {
  const key = type.typeArguments?.params[0];
  return key === undefined || isBroadMappedKey(key, environment, substitutions);
}

function isBroadMappedKey(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeSubstitutions,
  visitedAliases: ResolvingAliases = new Set()
): boolean {
  const unwrapped = unwrapTransparentType(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.some((member) =>
      isBroadMappedKey(member, environment, substitutions, visitedAliases)
    );
  }
  if (unwrapped.type !== "TSTypeReference") return false;
  const name = typeReferenceName(unwrapped);
  if (name === null) return false;
  const substitution = typeSubstitution(unwrapped, environment, substitutions);
  if (substitution !== undefined) {
    return isBroadMappedKey(
      substitution.type,
      environment,
      substitution.substitutions,
      substitution.resolvingAliases
    );
  }
  if (name === "PropertyKey" && isBuiltIn(name, unwrapped, environment))
    return true;
  const alias = visibleTypeAlias(name, unwrapped, environment.typeAliases);
  if (
    alias === null ||
    (alias.typeParameters?.params.length ?? 0) > 0 ||
    visitedAliases.has(alias)
  ) {
    return false;
  }
  const nextVisited = new Set(visitedAliases);
  nextVisited.add(alias);
  return isBroadMappedKey(
    alias.typeAnnotation,
    environment,
    substitutions,
    nextVisited
  );
}

function classifyAliasBroadTarget(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeSubstitutions,
  resolvingAliases: ResolvingAliases
): WideningTarget | null {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some(
      (member) => member.type === "TSIndexSignature"
    )
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadMappedKey(unwrapped.constraint, environment, substitutions)
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  const substitution = typeSubstitution(unwrapped, environment, substitutions);
  if (substitution !== undefined) {
    return classifyAliasBroadTarget(
      substitution.type,
      environment,
      substitution.substitutions,
      substitution.resolvingAliases
    );
  }
  if (
    TRANSPARENT_WRAPPERS.has(name) &&
    isBuiltIn(name, unwrapped, environment)
  ) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyAliasBroadTarget(
          wrapped,
          environment,
          substitutions,
          resolvingAliases
        );
  }
  if (name === "Record" && isBuiltIn(name, unwrapped, environment)) {
    return hasBroadRecordKey(unwrapped, environment, substitutions)
      ? { kind: "open dictionary" }
      : null;
  }
  const alias = visibleTypeAlias(name, unwrapped, environment.typeAliases);
  if (alias === null || resolvingAliases.has(alias)) return null;
  const nextSubstitutions = aliasSubstitution(
    alias,
    unwrapped,
    substitutions,
    resolvingAliases
  );
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(alias);
  return classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving
  );
}

export function isPopulatedObjectExpression(
  expression: ESTree.Expression
): boolean {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current.type === "ObjectExpression" && current.properties.length > 0;
}

export function isKnownEvidenceExpression(
  expression: ESTree.Expression
): boolean {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  if (current.type === "ObjectExpression") return true;
  return (
    current.type === "ArrayExpression" ||
    current.type === "ArrowFunctionExpression" ||
    current.type === "ClassExpression" ||
    current.type === "FunctionExpression" ||
    current.type === "NewExpression" ||
    current.type === "Literal" ||
    current.type === "TemplateLiteral" ||
    current.type === "UnaryExpression"
  );
}
