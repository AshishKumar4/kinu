import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

/**
 * A promise enters Effect as itself, never through an `async` function that never awaits.
 *
 * `Effect.promise(async () => call())` hands Effect a wrapper whose promise adopts `call()`'s one a
 * microtask later; if `call()` rejects, workerd reports the rejection unhandled although Effect
 * handles it (measured 2026-09-28, `codemode-sandbox` and `hybrid-search-arms` under
 * vitest-pool-workers; bun never reports it). An `async` entry with no `await` either adopts late
 * or is needlessly async, so both read `() => Promise.resolve(call())`.
 *
 * Entries: `Effect.promise(fn)`, `Effect.tryPromise(fn)`, `Effect.tryPromise({ try: fn })` and
 * `attempt(input, fn)`. A function passed by name is not inspected, and an `await` inside a nested
 * function counts as awaiting; the gate prints both blind spots.
 */

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

function isFunction(node: ESTree.Node | undefined): node is FunctionNode {
  return node !== undefined && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression");
}

function entryFunction(node: ESTree.CallExpression): FunctionNode | undefined {
  const { callee } = node;

  if (callee.type === "Identifier" && callee.name === "attempt") {
    const run = node.arguments[1];

    return isFunction(run) ? run : undefined;
  }

  if (callee.type !== "MemberExpression" || callee.computed || callee.object.type !== "Identifier" || callee.object.name !== "Effect") return undefined;

  if (callee.property.type !== "Identifier" || (callee.property.name !== "promise" && callee.property.name !== "tryPromise")) return undefined;
  const first = node.arguments[0];

  if (isFunction(first)) return first;

  if (first?.type !== "ObjectExpression" || callee.property.name !== "tryPromise") return undefined;

  for (const property of first.properties) {
    if (property.type === "Property" && property.key.type === "Identifier" && property.key.name === "try" && isFunction(property.value)) {
      return property.value;
    }
  }

  return undefined;
}

/** Whether an `await` token occurs in the body; one inside a nested function counts too (a blind spot the gate prints). */
function awaitsInBody(sourceCode: SourceCode, fn: FunctionNode): boolean {
  return fn.body !== null && sourceCode.getTokens(fn.body).some((token) => token.value === "await");
}

export const effectEntryAwaitsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow an async function that never awaits as the entry of Effect.promise, Effect.tryPromise or attempt.",
    },
    messages: {
      lateAdoption:
        "This async function never awaits, so the promise it returns adopts its call's promise a microtask late and workerd reports that call's rejection unhandled. Pass the promise itself: `() => Promise.resolve(call())`.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const fn = entryFunction(node);

        if (fn !== undefined && fn.async && !awaitsInBody(context.sourceCode, fn)) context.report({ node: fn, messageId: "lateAdoption" });
      },
    };
  },
});
