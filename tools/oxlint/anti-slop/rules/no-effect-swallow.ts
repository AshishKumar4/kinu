import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

/**
 * The no-swallow rules, for the Effect error channel.
 *
 * `Effect.ignore`, `ignoreCause`, `orElseSucceed` and `option` drop every failure by construction:
 * the Effect spelling of `catch {}` and of `catch { return null }`. A catch-all handler
 * (`catch`, `catchCause`, `catchDefect`) that never reads what it caught is the spelling of a
 * handler that computes a fallback and drops the error, the shape no-unaccounted-catch rejects.
 *
 * Allowed, because the failure they tolerate is named: `catchTag`, `catchTags`, `catchIf`,
 * `catchFilter`, `catchReason`, `catchReasons` (the `tolerate(op, expected)` of the channel), and
 * any handler that reads its argument. A handler passed by name is not inspected; the gate prints
 * that blind spot.
 */

const DROPS_EVERY_FAILURE: Readonly<Record<string, true>> = {
  ignore: true,
  ignoreCause: true,
  orElseSucceed: true,
  option: true,
};

const CATCH_ALL: Readonly<Record<string, true>> = {
  catch: true,
  catchCause: true,
  catchDefect: true,
};

function isFunction(node: ESTree.Node): node is ESTree.ArrowFunctionExpression | ESTree.Function {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";
}

/** Whether the handler reads the value it was handed: its first parameter, by name, in its body. */
function readsWhatItCaught(sourceCode: SourceCode, handler: ESTree.ArrowFunctionExpression | ESTree.Function): boolean {
  const first = handler.params[0];

  if (first === undefined || first.type !== "Identifier" || handler.body === null || handler.body === undefined) return false;

  return sourceCode.getTokens(handler.body).some((token) => token.type === "Identifier" && token.value === first.name);
}

export const noEffectSwallowRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect operators and catch-all handlers that drop the failure they received.",
    },
    messages: {
      dropsEveryFailure:
        "`Effect.{{name}}` drops every failure of the effect, the channel's `catch {}`. Name the failure you tolerate (`catchTag`, `catchIf`) and let the rest fail, or handle it and record it.",
      handlerDropsFailure:
        "This `Effect.{{name}}` handler never reads what it caught, so the failure is replaced by a value and lost. Read it (record it, rethrow it with `cause`), or tolerate only a named failure with `catchTag` / `catchIf`.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (node.computed || node.object.type !== "Identifier" || node.object.name !== "Effect") return;

        if (node.property.type === "Identifier" && Object.hasOwn(DROPS_EVERY_FAILURE, node.property.name)) {
          context.report({ node, messageId: "dropsEveryFailure", data: { name: node.property.name } });
        }
      },
      CallExpression(node) {
        const { callee } = node;

        if (callee.type !== "MemberExpression" || callee.computed || callee.object.type !== "Identifier") return;

        if (callee.object.name !== "Effect" || callee.property.type !== "Identifier" || !Object.hasOwn(CATCH_ALL, callee.property.name)) return;
        const handler = node.arguments.at(-1);

        if (handler === undefined || !isFunction(handler)) return;

        if (!readsWhatItCaught(context.sourceCode, handler)) {
          context.report({ node: handler, messageId: "handlerDropsFailure", data: { name: callee.property.name } });
        }
      },
    };
  },
});
