/**
 * Node/Bun crafted-tool executor. Failure attribution is deliberately absent:
 * core's `buildCraftedTools` already wraps every crafted execute with
 * `craftInvocationError`, and stamping twice makes `craftFailureBlame` count one failure as several.
 */

import { decodeJsonValue, requireBuild } from '@kinu.run/core';
import { runInThisContext } from 'node:vm';
import type { CraftedToolExecute, CraftedToolExecuteFn, JsonValue } from '@kinu.run/core';
import * as v from 'valibot';

export function createNodeCraftedExecute(): CraftedToolExecute {
  return (tool) => {
    let compiled: ((arg: JsonValue) => Promise<JsonValue | undefined>) | null = null;
    let compiledFor = '';

    const ensure = () => {
      if (compiled && compiledFor === tool.code) return compiled;
      // An expression evaluating to an async function; upsertCraftedTool compiled it once already.
      const fn = v.parse(v.function_(), runInThisContext('(' + tool.code + ')'));
      compiled = async (arg) => {
        const result = await fn(arg);

        return result === undefined ? undefined : decodeJsonValue({ value: result });
      };

      compiledFor = tool.code;

      return compiled;
    };

    const execute: CraftedToolExecuteFn = async (arg) => {
      requireBuild('Native crafted code without a constrained runtime');
      const fn = ensure();

      return fn(arg);
    };

    return execute;
  };
}
