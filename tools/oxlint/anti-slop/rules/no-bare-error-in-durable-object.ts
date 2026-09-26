import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { inCapScope } from "./no-output-token-cap.ts";

/** Bases whose instances are Durable Objects reached over RPC. */
const OBJECT_BASES = new Set(["Agent", "AIChatAgent", "Think", "ActorAgent", "OrchestratorAgent", "DurableObject"]);

const BUILT_IN_ERRORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError"]);

/** The UserDO's methods split into files: they throw to the same RPC callers. */
const OBJECT_MODULE_DIRECTORY = "/packages/cf-backend/src/user/";

/**
 * Reject a bare built-in error thrown from a Durable Object's module.
 *
 * Across Durable Object RPC an error keeps only `name: message` (compat 2025-12-01). A `KinuError`
 * carries its class in its name (`KinuError[unavailable]: …`), so a route answers the caller with that
 * class and the reason its thrower wrote. A bare `Error` is unclassified: the route can only answer
 * 500 with its own words, and the reason is lost. Creating a workspace whose name was still being torn
 * down answered exactly that until 2026-09-26.
 */
export const noBareErrorInDurableObjectRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow throwing a bare built-in error from a Durable Object's module; throw a KinuError.",
    },
    messages: {
      bareError:
        "`throw new {{name}}` in a Durable Object's module reaches its RPC caller unclassified, so the route answers 500 without the reason. Throw `new KinuError(code, message)`, whose class survives RPC in its name, or a named error class.",
    },
  },
  createOnce(context) {
    let inScope = false;
    let objectModule = false;
    let throws: { readonly node: ESTree.ThrowStatement; readonly name: string }[] = [];

    const enterClass = (node: ESTree.Class): void => {
      if (node.superClass?.type === "Identifier" && OBJECT_BASES.has(node.superClass.name)) objectModule = true;
    };

    return {
      Program() {
        const filename = context.filename.replaceAll("\\", "/");
        inScope = inCapScope(filename);
        objectModule = filename.includes(OBJECT_MODULE_DIRECTORY);
        throws = [];
      },
      ClassDeclaration: enterClass,
      ClassExpression: enterClass,
      ThrowStatement(node) {
        const thrown = node.argument;

        if (thrown.type !== "NewExpression" || thrown.callee.type !== "Identifier") return;

        if (BUILT_IN_ERRORS.has(thrown.callee.name)) throws.push({ node, name: thrown.callee.name });
      },
      "Program:exit"() {
        if (!inScope || !objectModule) return;

        for (const { node, name } of throws) context.report({ node, messageId: "bareError", data: { name } });
      },
    };
  },
});
