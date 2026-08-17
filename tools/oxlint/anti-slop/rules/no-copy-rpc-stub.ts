import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/**
 * Reject copying a JSRPC stub's members instead of holding the stub.
 *
 * `Object.assign(view, env.UserDO.get(id))` produces an EMPTY object. A JSRPC stub is a `Proxy`
 * whose methods are synthesized by a `get` trap; they are not own enumerable properties, and
 * `Object.assign` and object spread copy exactly own enumerable properties. So the copy has no
 * methods, every call through it returns `undefined`, and nothing anywhere throws — the failure is
 * a silent no-op at the call site.
 *
 * This shipped four times. `wrangler tail` on production confirmed three of them firing:
 * `vaultView.resolveEgressInjection` and `vaultView.listEgressSecrets` (egress/outbound.ts),
 * `agentView.acceptContainerEvent` (runtime.ts). Container egress had therefore never worked. Each
 * site carried a `SAFETY: checked by construction and pinned by a test` comment, and the comment was
 * TRUE about the wrong thing: the tests asserted the METHOD NAME existed on the RPC surface, which it
 * did. Nothing asserted that `Object.assign` transfers it. That is why this rule is syntactic and
 * unconditional rather than another assertion about names.
 *
 * The matcher is the SOURCE expression, because that is what makes a value a stub: a `get` /
 * `getByName` call on a Durable Object namespace reached through an `env` binding, or agents-SDK
 * `getAgentByName`. It deliberately does NOT key on the target's name or type — the four sites all
 * used a `…View` local, and naming an offender's incidental shape produces a rule that stops firing
 * the moment someone picks a different variable name. A one-hop `const` alias is resolved through the
 * scope manager, so splitting the expression across two statements is not an escape.
 *
 * `Object.assign` over an object LITERAL stays legal and must: runtime.ts builds a namespace view
 * that way, and its members really are own enumerable properties. The rule fires on the stub source,
 * so a literal never matches.
 *
 * A stub is used, never copied. Bind it (`const vault = env.UserDO.get(id)`) and call through it;
 * pass the binding itself where a narrower contract is wanted, with a type annotation rather than a
 * structural copy.
 */
export const noCopyRpcStubRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Object.assign or object spread over a JSRPC stub, which copies no methods.",
    },
    messages: {
      copiedRpcStub:
        "`{{operation}}` over `{{source}}` copies nothing — a JSRPC stub's methods live behind a Proxy `get` trap, not as own enumerable properties, so the result is an empty object and every call through it returns `undefined` without throwing. Hold the stub in a binding and call through it instead of copying its members.",
    },
  },
  createOnce(context) {
    /** Guards the `const` alias walk against a cycle (`const a = b; const b = a;` parses).
     *  Reset per file, because `createOnce` reuses one visitor set across every file. */
    let resolving: Set<string>;

    const resolveVariable = (
      sourceCode: SourceCode,
      identifier: ESTree.IdentifierReference,
    ): Variable | null => {
      let scope: Scope | null = sourceCode.getScope(identifier);
      while (scope !== null) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined) return variable;
        scope = scope.upper;
      }
      return null;
    };

    /** Strip the wrappers that sit between the producing call and its use without changing what the
     *  value is: `await`, `x!`, `x as T`, `x satisfies T`. */
    const unwrap = (node: ESTree.Expression): ESTree.Expression => {
      let current = node;
      for (;;) {
        if (current.type === "AwaitExpression") current = current.argument;
        else if (current.type === "TSNonNullExpression") current = current.expression;
        else if (current.type === "TSAsExpression") current = current.expression;
        else if (current.type === "TSSatisfiesExpression") current = current.expression;
        else return current;
      }
    };

    /** True when a member chain is reached through an `env` binding — `env.UserDO`,
     *  `this.env.UserDO`, `this.options.env.UserDO`. That is what distinguishes a Durable Object
     *  namespace's `get` from `map.get` / `headers.get`. */
    const reachedThroughEnv = (node: ESTree.Node): boolean => {
      let current = node;
      for (;;) {
        if (current.type === "Identifier") return current.name === "env";
        if (current.type !== "MemberExpression") return false;
        if (!current.computed && current.property.type === "Identifier"
          && current.property.name === "env") {
          return true;
        }
        current = current.object;
      }
    };

    /** The type annotation workerd gives a stub. A parameter or field declared with it is a stub
     *  whose producing expression is in another file, so the annotation is the only signal. */
    const isStubAnnotation = (annotation: ESTree.Node | undefined | null): boolean => {
      if (annotation === undefined || annotation === null) return false;
      if (annotation.type !== "TSTypeAnnotation") return false;
      const reference = annotation.typeAnnotation;
      if (reference.type !== "TSTypeReference") return false;
      return reference.typeName.type === "Identifier"
        && reference.typeName.name === "DurableObjectStub";
    };

    /** How this expression makes a JSRPC stub, or null when it does not. The string is the message's
     *  `{{source}}`, so it names the mechanism rather than the variable. */
    const stubSource = (raw: ESTree.Expression): string | null => {
      const node = unwrap(raw);

      if (node.type === "CallExpression") {
        const callee = node.callee;
        if (callee.type === "Identifier" && callee.name === "getAgentByName") {
          return "getAgentByName(…)";
        }
        if (callee.type === "MemberExpression" && !callee.computed
          && callee.property.type === "Identifier"
          && (callee.property.name === "get" || callee.property.name === "getByName")
          && reachedThroughEnv(callee.object)) {
          return `a Durable Object namespace .${callee.property.name}(…)`;
        }
        return null;
      }

      if (node.type !== "Identifier") return null;
      if (resolving.has(node.name)) return null;
      const variable = resolveVariable(context.sourceCode, node);
      if (variable === null) return null;
      resolving.add(node.name);
      try {
        for (const definition of variable.defs) {
          const declarator = definition.node;
          if (declarator.type !== "VariableDeclarator") continue;
          if (declarator.id.type === "Identifier"
            && isStubAnnotation(declarator.id.typeAnnotation)) {
            return `\`${node.name}\``;
          }
          if (declarator.init === null || declarator.init === undefined) continue;
          const inner = stubSource(declarator.init);
          if (inner !== null) return inner;
        }
      } finally {
        resolving.delete(node.name);
      }
      return null;
    };

    const report = (
      node: ESTree.Node,
      operation: string,
      source: string,
    ): void => {
      context.report({ node, messageId: "copiedRpcStub", data: { operation, source } });
    };

    return {
      Program() {
        resolving = new Set();
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.object.type !== "Identifier" || callee.object.name !== "Object") return;
        if (callee.property.type !== "Identifier" || callee.property.name !== "assign") return;
        // Argument 0 is the target being mutated; a stub there is the thing being written INTO,
        // which is a different (and also wrong) shape this rule does not claim to cover.
        for (const argument of node.arguments.slice(1)) {
          if (argument.type === "SpreadElement") continue;
          const source = stubSource(argument);
          if (source !== null) report(node, "Object.assign", source);
        }
      },
      ObjectExpression(node) {
        for (const property of node.properties) {
          if (property.type !== "SpreadElement") continue;
          const source = stubSource(property.argument);
          if (source !== null) report(property, "object spread", source);
        }
      },
    };
  },
});
