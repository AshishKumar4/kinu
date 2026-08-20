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

import { DynamicWorkerExecutor, normalizeCode } from '@cloudflare/codemode';
import { craftFailureMarker, filterByEffectiveScore, explainNativeToolReferenceError } from '@kinu/core';
import type { CraftStore, SqlExecutor } from '@kinu/core';
import { renderThrownChain } from '@kinu/core/obs';

/** Codemode's resolved provider shape. */
type DynamicProviderInput = Parameters<DynamicWorkerExecutor['execute']>[1];
type ResolvedProvider = Extract<DynamicProviderInput, object[]>[number] & {
  positionalArgs?: boolean;
};

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
  const rows = craftStore.list().map(r => ({
    name: r.name,
    code: (r.code ?? '').trim(),
    description: r.description ?? '',
  })).filter(t => t.name && t.code && !t.code.startsWith('//'));
  return filterByEffectiveScore(sql, rows);
}

/**
 * Build the `const tools = { name: <body>, ... };` preamble.
 * Empty → empty string (preamble is only spliced if non-empty, see
 * `injectPreamble`).
 *
 * Each body is wrapped so a failure leaves the sandbox stamped with the tool
 * that raised it (`craftFailureMarker`, core craft/in-episode.ts) — the model
 * otherwise gets a bare message with no idea which of its own tools broke, and
 * the in-episode fitness signal scores an artifact only when the failure names
 * it. The wrapper is an IIFE, so the body keeps the lexical scope of the
 * sandbox arrow it is spliced into (`workspace.*`, the `tools` literal itself)
 * exactly as an unwrapped body did.
 */
export function buildToolsPreamble(tools: ReadonlyArray<{ name: string; code: string }>): string {
  if (tools.length === 0) return '';
  const entries = tools.map(t => `    ${t.name}: ${attributedBody(t.name, t.code.trim())}`);
  return `const tools = {\n${entries.join(',\n')}\n  };\n  `;
}

function attributedBody(name: string, code: string): string {
  const marker = JSON.stringify(`${craftFailureMarker(name)} `);
  // The stored body sits alone between parentheses on its own lines. It is
  // model-authored and routinely ends in a `//` comment, which on one line
  // would swallow the rest of the wrapper and make the whole preamble — spliced
  // into EVERY execute — a syntax error that no crafted tool could survive.
  return `(() => { const __impl = (\n${code}\n); return async (...__a) => { try { return await __impl(...__a); } ` +
    `catch (__e) { throw new Error(${marker} + (__e && __e.message ? __e.message : String(__e)), { cause: __e }); } }; })()`;
}

/**
 * Wrap the model's code so the crafted-tool preamble is ALWAYS in its lexical
 * scope.
 *
 * This used to be a regex splice into the head of `async (...) => {` against
 * the model's raw code, and its own docstring conceded that "if the LLM's code
 * doesn't match that shape, the preamble is dropped silently". A bare statement
 * body never matches — and a bare statement body is exactly what
 * BUILTIN_TOOL_SPECS.execute_tools.example teaches, and what codemode itself
 * wraps for you (normalizeCode, called later inside DynamicWorkerExecutor).
 * So on every such call the whole crafted-tool surface was undefined, with no
 * error naming why: the one capability that makes a tool crafted in step 1
 * callable in step 2 failed in the case our own worked example trains for.
 *
 * Normalizing first and wrapping instead of splicing removes the shape
 * dependency entirely. DWE declares each provider namespace as a `const` in
 * the scope that encloses the evaluated arrow, so the inner arrow still closes
 * over `workspace`, `memory`, `agents` and the rest, and now over `tools` too.
 * DWE re-normalizes this wrapper, which is already codemode's canonical shape,
 * so that pass is a no-op.
 */
export function injectPreamble(code: string, preamble: string): string {
  if (!preamble) return code;
  return `async () => {\n  ${preamble}return await (${normalizeCode(code)})();\n}`;
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

function structuredError<Thrown>(
  err: Thrown,
  toolName?: string,
  providerName?: string,
): StructuredExecutionError {
  const message = renderThrownChain({ cause: err });
  const stack = err instanceof Error && err.stack
    ? err.stack.split('\n').slice(0, 10).join('\n')
    : undefined;
  return { error: true, message, stack, toolName, providerName };
}

/**
 * Wrap each provider's fns so thrown errors surface as a structured payload
 * (Phase B). Dispatcher serialization preserves the object across the
 * sandbox RPC boundary; the LLM sees `{error: true, message, stack, toolName}`.
 *
 * Kinu-specific — the reference prior-art implementation passes bare
 * `err.message`; we send the structured envelope for agent observability.
 */
function wrapProvidersWithStructuredErrors(providers: ResolvedProvider[]): ResolvedProvider[] {
  return providers.map(p => {
    const wrappedFns: ResolvedProvider['fns'] = {};
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

  constructor(loader: WorkerLoader, craftStore: CraftStore, sql: SqlExecutor) {
    this.#inner = new DynamicWorkerExecutor({ loader });
    this.#craftStore = craftStore;
    this.#sql = sql;
  }

  async execute(
    code: string,
    providers: DynamicProviderInput,
  ) {
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
      // DWE never throws for sandbox-internal failures (a bare `ReferenceError:
      // run is not defined` from code that reached for a native tool as if it
      // were in codemode scope lands here as a string). Rewrite exactly that
      // shape into the correction; every other error is untouched.
      return result.error
        ? { ...result, error: explainNativeToolReferenceError(result.error) }
        : result;
    } catch (err) {
      // Outer executor-level failure (sandbox spawn, timeout, etc.).
      // Propagate as a string — createCodeTool's execute wrapper converts
      // non-empty `error` into a thrown AI SDK error, which surfaces as
      // `tool-output-error` with the text as `errorText`.
      return {
        result: undefined,
        error: renderThrownChain({ cause: err }),
      };
    }
  }
}
