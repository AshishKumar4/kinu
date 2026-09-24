import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { inCapScope } from "./no-output-token-cap.ts";

/** Bases whose inherited members reach storage over RPC: the agents SDK `Agent`, and Kinu's actor base. */
const RPC_EXPOSED_BASES = ["Agent", "ActorAgent"];

const SEAL = "sealRpcSurface";

/** Whether the constructor's own statements call `sealRpcSurface(this, …)`. */
function constructorSeals(cls: ESTree.Class): boolean {
  for (const member of cls.body.body) {
    if (member.type !== "MethodDefinition" || member.kind !== "constructor") continue;

    for (const statement of member.value.body?.body ?? []) {
      if (statement.type !== "ExpressionStatement") continue;
      const call = statement.expression;

      if (call.type === "CallExpression" && call.callee.type === "Identifier" && call.callee.name === SEAL
        && call.arguments[0]?.type === "ThisExpression") return true;
    }
  }

  return false;
}

/**
 * A Durable Object built on the agents SDK exposes every prototype member over RPC, `sql` and
 * `setState` included, until `sealRpcSurface` shadows what its surface does not list. A class
 * that forgets the call is open to any stub-holder, so each one must seal in its own constructor.
 */
export const requireRpcSealRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require a non-abstract class over an RPC-exposed agent base to call sealRpcSurface(this, …) in its constructor.",
    },
    messages: {
      unsealed:
        "`{{name}}` extends `{{base}}`, whose inherited members answer any stub-holder. Call `sealRpcSurface(this, SURFACE)` as its constructor's last statement.",
    },
  },
  createOnce(context) {
    let inScope = false;

    const check = (node: ESTree.Class) => {
      const base = node.superClass?.type === "Identifier" ? node.superClass.name : undefined;

      if (!inScope || node.abstract || base === undefined || !RPC_EXPOSED_BASES.includes(base)) return;

      if (!constructorSeals(node)) {
        context.report({ node, messageId: "unsealed", data: { name: node.id?.name ?? "(anonymous)", base } });
      }
    };

    return {
      Program() {
        inScope = inCapScope(context.filename);
      },
      ClassDeclaration: check,
      ClassExpression: check,
    };
  },
});
