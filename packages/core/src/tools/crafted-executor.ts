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
 * `codemode.<name>(arg)`. Implementations MUST be idempotent — `buildBuiltinTools`
 * calls the factory once per tool per turn; the returned function is then
 * invoked many times per turn from the sandbox Worker.
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

/**
 * Platform detection helper. True on CF Workers runtime (V8 isolate with
 * codegen disallowed). Implementations in the adapter layer MUST check
 * this only as an optimisation hint — the authoritative signal is whether
 * `env.LOADER` is bound, which is what the CF adapter actually uses.
 *
 * Returns `false` on Node/Bun, where codegen is allowed. Safe to call in any
 * runtime — does not itself invoke any codegen primitive.
 */
export function codegenDisallowed(): boolean {
  // Workers expose `navigator.userAgent === "Cloudflare-Workers"` in most
  // contexts; fall through to feature-probing via typeof tests if not present.
  // We do NOT probe via codegen because that would throw synchronously in the
  // runtime we're trying to detect.
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (typeof nav?.userAgent === 'string' && nav.userAgent.includes('Cloudflare-Workers')) {
    return true;
  }
  return false;
}
