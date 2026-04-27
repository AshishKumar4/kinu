/**
 * Node/Bun crafted-tool executor.
 *
 * V8 on Node/Bun permits `new Function()` codegen, so the CLI adapter compiles
 * stored crafted-tool code directly in-process. The code convention is an
 * expression that evaluates to an async function (arrow or function
 * expression) — the same convention the CF LOADER path uses, and the same
 * convention the store-time normalizer enforces.
 *
 * The factory is idempotent: each call to craftedToolExecute(tool) returns a
 * fresh closure. buildBuiltinTools calls it once per tool per turn. The
 * returned function caches the compiled fn via a closure variable so
 * per-call overhead is a single reference check.
 *
 * Errors are re-thrown — codemode's ToolDispatcher wraps them into a
 * JSON-serializable error the sandbox converts into a thrown Error in
 * user code. That is the same path the CF LOADER executor produces.
 */

import type { CraftedToolExecute, CraftedToolExecuteFn } from '@proteus/core';

export function createNodeCraftedExecute(): CraftedToolExecute {
  return (tool) => {
    let compiled: ((arg: unknown) => Promise<unknown>) | null = null;
    let compiledFor = '';

    const ensure = () => {
      if (compiled && compiledFor === tool.code) return compiled;
      // `tool.code` is expected to be an expression form like
      //   async (x) => x * 2
      //   async function(x) { return x * 2 }
      // The store-time normalizer guarantees one of these forms.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const factory = new Function('return (' + tool.code + ')');
      const fn = factory();
      if (typeof fn !== 'function') {
        throw new Error(
          `Crafted tool "${tool.name}" did not evaluate to a function (got ${typeof fn}).`,
        );
      }
      compiled = fn as (arg: unknown) => Promise<unknown>;
      compiledFor = tool.code;
      return compiled;
    };

    const execute: CraftedToolExecuteFn = async (arg) => {
      const fn = ensure();
      return fn(arg);
    };
    return execute;
  };
}
