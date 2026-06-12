/**
 * Crafted-tool execution — preamble-injection pattern.
 *
 * Phase A+B+C of the upgrade plan in docs/CRAFT-ARCHITECTURE.md.
 * Replaces the hand-rolled `LiveCraftedExecutor` that reimplemented
 * `@cloudflare/codemode`'s DynamicWorkerExecutor sandbox module from scratch.
 *
 * Architecture:
 *
 *   1. `DynamicWorkerExecutor({ loader })` — upstream codemode, unmodified.
 *   2. Before every `execute(code, providers)`, read `craftStore.list()`
 *      fresh and build `const tools = { name: <code>, ... };` preamble.
 *   3. Splice the preamble into the LLM's `async (...) => { ... }` arrow
 *      via `code.replace(/^(\s*async\s*\([^)]*\)\s*=>\s*\{)/, $1\n  ${preamble})`.
 *   4. Hand the injected code to DWE. Crafted tool bodies now share lexical
 *      scope with the outer sandbox arrow — they see `workspace.*`,
 *      `codemode.*`, and standard globals, and can call each other via
 *      `tools.<name>()` (same object literal, late-bound).
 *   5. Wrap dispatcher errors as `{error: {message, stack, toolName, providerName}}`
 *      so the LLM gets attribution (Phase B).
 *
 * This deletes the entire LiveCraftedExecutor reimplementation (~130 LOC)
 * and the in-memory CraftedToolRegistry. SQL is the single source of truth;
 * a re-read per execute keeps visibility live.
 */

import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { filterByEffectiveScore } from '@proteus/core';
import type { CraftStore, SqlExecutor } from '@proteus/core';

/** Minimal WorkerLoader shape. Typed loosely — we hand it to DWE untouched. */
type WorkerLoaderLike = unknown;

/** Codemode's resolved provider shape. */
interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  positionalArgs?: boolean;
}

/**
 * Select the crafted tools eligible for injection: non-empty, non-comment
 * code, passing the SAME effective-score policy core's tool builder applies
 * (filterByEffectiveScore) — one policy, two call sites. Reads the CraftStore
 * fresh so mid-turn-saved tools are visible to the NEXT execute_tools call.
 */
export function selectInjectableCraftedTools(
  craftStore: CraftStore,
  sql: SqlExecutor,
): Array<{ name: string; code: string; description: string }> {
  let rows: Array<{ name: string; code: string; description: string }>;
  try {
    rows = craftStore.list().map(r => ({
      name: r.name,
      code: (r.code ?? '').trim(),
      description: r.description ?? '',
    })).filter(t => t.name && t.code && !t.code.startsWith('//'));
  } catch {
    return [];
  }
  return filterByEffectiveScore(sql, rows);
}

/**
 * Build the `const tools = { name: <body>, ... };` preamble.
 * Empty → empty string (preamble is only spliced if non-empty, see
 * `injectPreamble`).
 */
export function buildToolsPreamble(tools: ReadonlyArray<{ name: string; code: string }>): string {
  if (tools.length === 0) return '';
  const entries = tools.map(t => `    ${t.name}: ${t.code.trim()}`);
  return `const tools = {\n${entries.join(',\n')}\n  };\n  `;
}

/**
 * Splice the preamble into the LLM's async arrow.
 * Regex matches the head of `async (...) => { ... }` (whitespace-tolerant).
 * If the LLM's code doesn't match that shape, the preamble is dropped
 * silently.
 */
export function injectPreamble(code: string, preamble: string): string {
  if (!preamble) return code;
  return code.replace(/^(\s*async\s*\([^)]*\)\s*=>\s*\{)/, `$1\n  ${preamble}`);
}

/**
 * Structured error envelope. Replaces bare `err.message` strings on the CF
 * crafted-tool path (Phase B). `toolName` + `providerName` give the LLM
 * attribution when errors bubble out of `execute_tools`.
 */
export interface StructuredExecutionError {
  error: true;
  message: string;
  stack?: string;
  toolName?: string;
  providerName?: string;
}

function structuredError(
  err: unknown,
  toolName?: string,
  providerName?: string,
): StructuredExecutionError {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && typeof err.stack === 'string'
    ? err.stack.split('\n').slice(0, 10).join('\n')
    : undefined;
  return { error: true, message, stack, toolName, providerName };
}

/**
 * Wrap each provider's fns so thrown errors surface as a structured payload
 * (Phase B). Dispatcher serialization preserves the object across the
 * sandbox RPC boundary; the LLM sees `{error: true, message, stack, toolName}`.
 *
 * Proteus-specific — the reference prior-art implementation passes bare
 * `err.message`; we send the structured envelope for agent observability.
 */
function wrapProvidersWithStructuredErrors(providers: ResolvedProvider[]): ResolvedProvider[] {
  return providers.map(p => {
    const wrappedFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, fn] of Object.entries(p.fns)) {
      wrappedFns[name] = async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          // Return a value (don't rethrow). codemode's dispatcher distinguishes
          // result vs error by whether the fn returned or threw. We WANT this
          // to reach the LLM as an inspectable value so the agent can react.
          return structuredError(err, name, p.name);
        }
      };
    }
    return { name: p.name, fns: wrappedFns, positionalArgs: p.positionalArgs };
  });
}

/**
 * PreambleCraftedExecutor — preamble-injecting wrapper around DWE.
 *
 * Lifecycle:
 *   - Constructed once per DO lifetime (inner DWE caches LOADER stubs).
 *   - `execute(code, providers)` is called by codemode's `createCodeTool`
 *     on every `execute_tools` invocation. We:
 *       a. Select injectable tools (fresh craftStore.list(), score-filtered
 *          by the shared effective-score policy).
 *       b. Build + splice the preamble.
 *       c. Wrap provider fns with structured-error capture.
 *       d. Delegate to DWE.
 */
export class PreambleCraftedExecutor {
  #inner: DynamicWorkerExecutor;
  #craftStore: CraftStore;
  #sql: SqlExecutor;

  constructor(loader: WorkerLoaderLike, craftStore: CraftStore, sql: SqlExecutor) {
    this.#inner = new DynamicWorkerExecutor({
      loader: loader as ConstructorParameters<typeof DynamicWorkerExecutor>[0]['loader'],
    });
    this.#craftStore = craftStore;
    this.#sql = sql;
  }

  async execute(
    code: string,
    providers: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<{ result: unknown; error?: string; logs?: string[] }> {
    // Normalize to ResolvedProvider[]. Codemode passes an array in current
    // versions; defensively accept the object-shaped provider map too.
    const providerArr: ResolvedProvider[] = Array.isArray(providers)
      ? providers
      : [{ name: 'codemode', fns: providers }];

    // Fresh selection every execute — mid-turn-saved tools appear on the very
    // next `execute_tools` call, score-retired tools drop out (one policy with
    // core's builder, see selectInjectableCraftedTools).
    const craftedRows = selectInjectableCraftedTools(this.#craftStore, this.#sql);

    const preamble = buildToolsPreamble(craftedRows);
    const injected = injectPreamble(code, preamble);

    // Phase B: wrap fns so thrown errors become structured envelopes.
    const wrappedProviders = wrapProvidersWithStructuredErrors(providerArr);

    try {
      const result = await this.#inner.execute(injected, wrappedProviders);
      return result as { result: unknown; error?: string; logs?: string[] };
    } catch (err) {
      // Outer executor-level failure (sandbox spawn, timeout, etc.).
      // Propagate as a string — createCodeTool's execute wrapper converts
      // non-empty `error` into a thrown AI SDK error, which surfaces as
      // `tool-output-error` with the text as `errorText`.
      return {
        result: undefined,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
