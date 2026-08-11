/**
 * Platform-correct crafted-tool execution.
 *
 * Crafted tools are stored as JavaScript source text in the `crafted_tools`
 * table. To invoke one, that text must become a callable function. V8 isolates
 * used by Cloudflare Durable Objects disallow all runtime string-compilation
 * primitives with the error "Code generation from strings disallowed for this
 * context".
 *
 * The CF adapter satisfies this by spawning a per-tool child Worker via
 * `env.LOADER.get(name, factory)` — modules are compiled by the workerd loader,
 * not by V8 codegen. The CLI adapter compiles stored source directly in-
 * process because Node/Bun allows codegen.
 *
 * Both adapters expose the same `CraftedToolExecute` shape so
 * `buildBuiltinTools` in core is platform-agnostic.
 */

import type { CraftedTool } from '../types/craft.js';

/**
 * Input shape the executor needs from a crafted tool. Not a full CraftedTool
 * — we deliberately accept only the fields needed so test harnesses can mock
 * with a literal.
 */
export interface CraftedToolSource {
  name: string;
  description: string;
  code: string;
}

/**
 * Produced by `craftedToolExecute(tool)`: an `execute` callback compatible
 * with codemode's `options.tools` entry shape. Each call goes to a child
 * Worker (CF) or an in-process eval (CLI). On error, returns a string-form
 * error so the caller's codemode proxy can surface it to the LLM.
 */
export type CraftedToolExecuteFn = (arg: unknown) => Promise<unknown>;

/**
 * Platform factory. Given a crafted tool row, return the host-side execute
 * function that codemode will invoke via RPC whenever the sandbox calls
 * `codemode.<name>(arg)`. Implementations MUST be idempotent — the crafted set is
 * resolved once per `execute_tools` call (so a tool crafted mid-turn is
 * callable on the next one), and each resolve calls the factory once per tool.
 */
export type CraftedToolExecute = (tool: CraftedToolSource) => CraftedToolExecuteFn;

/**
 * Lift a storage-row CraftedTool into the narrow CraftedToolSource shape.
 * Filters null/comment-only code so the executor never has to special-case.
 */
export function toCraftedToolSource(t: CraftedTool): CraftedToolSource | null {
  if (!t.code || t.code.startsWith('//')) return null;
  return { name: t.name, description: t.description ?? `Crafted tool: ${t.name}`, code: t.code };
}
