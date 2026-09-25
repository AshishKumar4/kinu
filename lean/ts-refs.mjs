// The TypeScript side of a traceability `tsRef`, read by oxc: what a file
// declares at its top level, and what each declaration declares one level in.
// A separate module so its self-test can plant sources; the checker runs under
// raw Node, which loads oxc-parser's native binding directly.

import { parseSync } from "oxc-parser";

const WRAPPERS = {
  TSAsExpression: true, TSSatisfiesExpression: true, TSTypeAssertion: true, TSNonNullExpression: true, ParenthesizedExpression: true,
};

/** A string literal, told by its own spelling: numbers, regexes and bigints are Literals too. */
const isStringLiteral = (node) => node.type === "Literal" && (node.raw?.[0] === "\"" || node.raw?.[0] === "'");

function keyName(member) {
  const { key, computed } = member;

  if (key === undefined || key === null) return undefined;

  if (!computed && (key.type === "Identifier" || key.type === "PrivateIdentifier")) return key.name;

  return isStringLiteral(key) ? key.value : undefined;
}

function elementsOf(owner) {
  switch (owner?.type) {
    case "ClassDeclaration":
    case "ClassExpression":
    case "TSInterfaceDeclaration":
      return owner.body.body;
    case "TSTypeAliasDeclaration":
      return owner.typeAnnotation.type === "TSTypeLiteral" ? owner.typeAnnotation.members : [];
    case "TSEnumDeclaration":
      return owner.body.members.map((member) => ({ ...member, key: member.id }));
    case "ObjectExpression":
      return owner.properties;
    default:
      return [];
  }
}

/** The members a declaration owns: class elements, interface and type-literal
 *  signatures, enum members, and the properties of a const object. A function
 *  owns none, so a local inside it never answers for a member. */
function membersOf(node) {
  let owner = node.type === "VariableDeclarator" ? node.init : node;

  while (owner !== null && owner !== undefined && Object.hasOwn(WRAPPERS, owner.type)) owner = owner.expression;

  const members = new Map();

  for (const element of elementsOf(owner)) {
    const name = keyName(element);

    if (name !== undefined && !members.has(name)) members.set(name, element);
  }

  return members;
}

/**
 * Every top-level declaration of one file by name, exported or not, each with
 * its members. A file that does not parse throws: no citation into it resolves.
 */
export function tsDeclarations(path, source) {
  const { program, errors } = parseSync(path, source, { lang: path.endsWith(".tsx") ? "tsx" : "ts" });

  if (errors.length > 0) throw new SyntaxError(`${path} does not parse: ${errors.map((e) => e.message).join("; ")}`);
  const declarations = new Map();

  const add = (name, node) => {
    if (!declarations.has(name)) declarations.set(name, { node, members: membersOf(node) });
  };

  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;

    if (declaration === null || declaration === undefined) continue;

    if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier") add(declarator.id.name, declarator);
      }
    } else if (declaration.id?.type === "Identifier") {
      add(declaration.id.name, declaration);
    }
  }

  return declarations;
}

/** Every string literal inside a node, in source order: the values a mirrored
 *  union, array or record spells. */
export function stringValues(node) {
  const values = [];

  JSON.stringify(node ?? null, (key, value) => {
    if (value?.type === "Literal" && isStringLiteral(value)) values.push(value.value);

    return value;
  });

  return values;
}
