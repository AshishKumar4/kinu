import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { isProductSource } from "../../../../scripts/sources.ts";

const METHODS: Readonly<Record<string, true>> = { doGenerate: true, doStream: true };
const MIDDLEWARE: Readonly<Record<string, true>> = { wrapGenerate: true, wrapStream: true };

function nameOf(node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;

  return null;
}

function isFunction(node: ESTree.Node): node is ESTree.Function | ESTree.ArrowFunctionExpression {
  return node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration";
}

function suppliedCallback(node: ESTree.Node): boolean {
  const pattern = node.parent;
  const callback = pattern?.parent;
  const owner = callback?.parent;

  return pattern?.type === "ObjectPattern" && callback !== undefined && callback !== null && isFunction(callback)
    && callback.params.some((param) => param === pattern) && owner?.type === "Property" && owner.value === callback
    && MIDDLEWARE[nameOf(owner.key) ?? ""] === true;
}

function modelDelegate(node: ESTree.Node): boolean {
  let enclosing = node.parent;

  while (enclosing !== null && !isFunction(enclosing)) enclosing = enclosing.parent;
  const owner = enclosing?.parent;
  const holder = owner?.parent;

  if (owner?.type !== "Property" && owner?.type !== "MethodDefinition") return false;
  if (METHODS[nameOf(owner.key) ?? ""] !== true) return false;

  const members = holder?.type === "ObjectExpression" ? holder.properties
    : holder?.type === "ClassBody" ? holder.body : [];

  return members.some((member) => {
    if (member.type !== "Property" && member.type !== "PropertyDefinition") return false;
    if (nameOf(member.key) !== "specificationVersion") return false;

    const value = member.value?.type === "TSAsExpression" ? member.value.expression : member.value;

    return value?.type === "Literal" && typeof value.value === "string" && /^v[234]$/u.test(value.value);
  });
}

function modelScript(node: ESTree.Node, models: ReadonlySet<string>): boolean {
  const pattern = node.parent;
  const binding = pattern?.parent;

  if (pattern?.type !== "ObjectPattern" || binding?.type !== "VariableDeclarator" || binding.init?.type !== "Identifier") return false;
  const input = binding.init.name;
  let enclosing: ESTree.Node | null = binding.parent;

  while (enclosing !== null && !isFunction(enclosing)) enclosing = enclosing.parent;
  if (enclosing === null || !isFunction(enclosing)) return false;
  const result = enclosing.returnType?.typeAnnotation;

  return result?.type === "TSTypeReference" && result.typeName.type === "Identifier" && models.has(result.typeName.name)
    && enclosing.params.some((param) => param.type === "Identifier" && param.name === input);
}

/** SDK callbacks and LanguageModel implementations are already inside the recorded model boundary. */
export const modelMethodBoundaryRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require raw model methods to stay inside the SDK model boundary." },
    messages: {
      outsideBoundary: "`{{method}}` invokes a model outside its SDK boundary; use the reported invocation path.",
    },
  },
  createOnce(context) {
    let inScope = false;
    const models = new Set<string>();

    return {
      Program(node) {
        models.clear();
        const filename = context.filename.replaceAll("\\", "/");
        const at = filename.lastIndexOf("/packages/");

        inScope = at !== -1 && isProductSource(filename.slice(at + 1));

        for (const statement of node.body) {
          if (statement.type !== "ImportDeclaration" || statement.source.value !== "ai/test") continue;

          for (const specifier of statement.specifiers) {
            if (specifier.type === "ImportSpecifier" && /^MockLanguageModelV[234]$/u.test(nameOf(specifier.imported) ?? "")) models.add(specifier.local.name);
          }
        }
      },
      MemberExpression(node) {
        if (!inScope) return;
        const method = nameOf(node.property);

        if (method === null || METHODS[method] !== true || modelDelegate(node)) return;
        context.report({ node, messageId: "outsideBoundary", data: { method } });
      },
      Property(node) {
        if (!inScope || node.parent?.type !== "ObjectPattern") return;
        const method = nameOf(node.key);

        if (method === null || METHODS[method] !== true || suppliedCallback(node) || modelScript(node, models)) return;
        context.report({ node, messageId: "outsideBoundary", data: { method } });
      },
    };
  },
});
