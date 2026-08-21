/**
 * Node/Bun crafted-tool executor.
 *
 * V8 on Node/Bun permits `new Function()` codegen, so the CLI adapter compiles
 * stored crafted-tool code directly in-process. The code convention is an
 * expression that evaluates to an async function (arrow or function
 * expression) — the same convention the CF LOADER path uses, and the one the
 * craft admission gate (core craft/conflict.ts) enforces at the write.
 *
 * The factory is idempotent: each call to craftedToolExecute(tool) returns a
 * fresh closure. The crafted set is resolved once per `execute_tools` call, so
 * this runs once per tool per call; the returned function caches the compiled
 * fn via a closure variable, so a tool called repeatedly inside one block
 * compiles once.
 *
 * Errors are re-thrown — codemode's ToolDispatcher wraps them into a
 * JSON-serializable error the sandbox converts into a thrown Error in
 * user code. That is the same path the CF LOADER executor produces.
 */

import { decodeJsonValue } from '@kinu.run/core';
import type { CraftedToolExecute, CraftedToolExecuteFn, JsonValue } from '@kinu.run/core';
import * as v from 'valibot';

export function createNodeCraftedExecute(): CraftedToolExecute {
  return (tool) => {
    let compiled: ((arg: JsonValue) => Promise<JsonValue | undefined>) | null = null;
    let compiledFor = '';

    const ensure = () => {
      if (compiled && compiledFor === tool.code) return compiled;
      // `tool.code` is expected to be an expression form like
      //   async (x) => x * 2
      //   async function(x) { return x * 2 }
      // upsertCraftedTool runs this exact compilation before storing, so a tool
      // that reaches here has already produced a callable once.
      const factory = new Function('return (' + tool.code + ')');
      const fn = v.parse(v.function_(), factory());
      compiled = async (arg) => {
        const result = await fn(arg);
        return result === undefined ? undefined : decodeJsonValue({ value: result });
      };
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
