/**
 * The `execute_tools` sandbox on Cloudflare: `@cloudflare/codemode`'s
 * DynamicWorkerExecutor, given the three things Kinu adds to it.
 *
 *   1. A MODULE. `kinu-node.js` (codemode-node-shim.ts) is loaded beside the
 *      model's program, so the prelude can hand the program a Node-style
 *      `require`, and each crafted tool a guarded definition.
 *   2. A PRELUDE on the `tools` namespace. The vendor declares one `const`
 *      proxy per provider, then runs each provider's prelude in that scope;
 *      this prelude defines `require`, `env` and every crafted tool as own
 *      properties of `tools`, which the proxy serves ahead of the host
 *      dispatch. Crafted source is inlined per tool inside `defineCrafted`,
 *      so a body that throws when evaluated, or is not a function, breaks its
 *      own name and nothing else. A body that does not PARSE is caught on the
 *      host with the same parser the admission gate uses, and becomes a
 *      definition that throws the parse error on call — one bad row used to
 *      be a SyntaxError for every program in the workspace.
 *   3. EGRESS. `globalOutbound` is the Worker's own loopback entrypoint
 *      (server.ts `CodemodeEgress`), so `fetch()` inside the sandbox is the
 *      real thing.
 *
 * Host tool failures THROW across the boundary — the dispatcher turns a
 * rejection into `{error}` and the sandbox proxy rethrows it as an `Error` the
 * program's own `try`/`catch` sees, with the namespace and member in front of
 * the message so the model knows which call raised.
 */

import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import {
  filterByEffectiveScore, explainNativeToolReferenceError, parsesAsExpression,
  NO_TIMER_DEADLINE_MS,
  type CraftStore, type SqlExecutor,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { KINU_NODE_MODULE_NAME, KINU_NODE_MODULE_SOURCE } from './codemode-node-shim';
import { EGRESS_FAILURE_HEADER } from './codemode-egress';

/** Codemode's resolved provider shape. */
type DynamicProviderInput = Parameters<DynamicWorkerExecutor['execute']>[1];
type ResolvedProvider = Extract<DynamicProviderInput, object[]>[number];

export interface InjectableCraftedTool {
  readonly name: string;
  readonly code: string;
  readonly description: string;
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
): InjectableCraftedTool[] {
  const rows = craftStore.list().map((row) => ({
    name: row.name,
    code: (row.code ?? '').trim(),
    description: row.description ?? '',
  })).filter((row) => row.name && row.code && !row.code.startsWith('//'));
  return filterByEffectiveScore(sql, rows);
}

/** What the sandbox prelude needs to know about the actor it runs for. */
export interface SandboxIdentity {
  readonly workspace: string;
}

/**
 * The `tools` provider's prelude: `require`, `env`, and one guarded
 * definition per crafted tool.
 *
 * `typeof` guards on `workspace` and `state`: the vendor declares a `const`
 * per provider, so a namespace this actor does not wire is an unresolved
 * identifier, and `typeof` is the one read of such a name that does not throw.
 */
export function renderToolsPrelude(crafted: readonly InjectableCraftedTool[], identity: SandboxIdentity): string {
  const definitions = crafted.map((entry) => {
    const parseError = parsesAsExpression(entry.code);
    const factory = parseError === null
      // ASYNC, because a stored body may await at its top level: `parsesAsExpression`
      // runs acorn with `allowAwaitOutsideFunction`, so `await foo()` passes the gate
      // while `() => (await foo())` is a SyntaxError — and one bad factory broke the
      // vendor-compiled prelude module, denying EVERY tool. An async wrapper still
      // satisfies `defineCrafted`'s typeof-function check, and a body that throws
      // still fails by name at call time rather than at module load.
      ? `async () => (\n${entry.code}\n)`
      : `() => { throw new Error(${JSON.stringify(`stored source does not parse: ${parseError}`)}); }`;
    return `      ${JSON.stringify(entry.name)}: __kinu.defineCrafted(${JSON.stringify(entry.name)}, ${factory}),`;
  });
  return [
    `    const __kinu = await import(${JSON.stringify(`./${KINU_NODE_MODULE_NAME}`)});`,
    '    const __kinuWorkspace = typeof workspace === "undefined" ? null : workspace;',
    '    const __kinuState = typeof state === "undefined" ? null : state;',
    '    const __kinuBuiltins = await __kinu.loadBuiltins();',
    '    const require = __kinu.createRequire({ workspace: __kinuWorkspace, builtins: __kinuBuiltins.loaded });',
    `    const fetch = __kinu.createFetch(${JSON.stringify(EGRESS_FAILURE_HEADER)});`,
    `    const env = Object.freeze({ workspace: ${JSON.stringify(identity.workspace)}, state: __kinuState, missingBuiltins: __kinuBuiltins.missing });`,
    '    Object.assign(tools, {',
    ...definitions,
    '    });',
  ].join('\n');
}

/**
 * Attribute a host rejection to the call that raised it, then rethrow — the
 * dispatcher carries the message across as `{error}` and the sandbox proxy
 * throws it, so the program's `catch` gets `workspace.readFile: ENOENT …`.
 */
function attributeProviders(providers: ResolvedProvider[]): ResolvedProvider[] {
  return providers.map((provider) => {
    const fns: ResolvedProvider['fns'] = {};
    for (const [name, fn] of Object.entries(provider.fns)) {
      fns[name] = async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (cause) {
          throw new Error(`${provider.name}.${name}: ${renderThrownChain({ cause })}`, { cause });
        }
      };
    }
    const attributed: ResolvedProvider = { name: provider.name, fns };
    if (provider.prelude !== undefined) attributed.prelude = provider.prelude;
    return attributed;
  });
}

export interface KinuSandboxExecutorOptions {
  readonly loader: WorkerLoader;
  /** The loopback Fetcher outbound requests ride; null keeps the sandbox offline. */
  readonly egress: Fetcher | null;
}

/** DynamicWorkerExecutor with Kinu's module, egress and attribution. */
export class KinuSandboxExecutor {
  readonly #inner: DynamicWorkerExecutor;

  constructor(options: KinuSandboxExecutorOptions) {
    // NO WORK DEADLINE. Codemode's own default is 60s, raced against the
    // program inside the dynamic Worker. A program here is mostly AWAITING host
    // tool calls — a sandbox exec, a delegated agent, an LLM call — so that
    // deadline killed the caller of long work rather than the long work itself,
    // after the detach had already promised the model the run was still going.
    // The window that bounds this program is the detach window; a runaway
    // program is stopped by the platform's CPU limit, not by us.
    this.#inner = new DynamicWorkerExecutor({
      loader: options.loader,
      timeout: NO_TIMER_DEADLINE_MS,
      modules: { [KINU_NODE_MODULE_NAME]: KINU_NODE_MODULE_SOURCE },
      globalOutbound: options.egress,
    });
  }

  async execute(code: string, providers: DynamicProviderInput) {
    const providerArr: ResolvedProvider[] = Array.isArray(providers)
      ? providers
      : [{ name: 'codemode', fns: providers }];
    try {
      const result = await this.#inner.execute(code, attributeProviders(providerArr));
      // DWE never throws for sandbox-internal failures (a bare `ReferenceError:
      // run is not defined` from code that reached for a native tool as if it
      // were in scope lands here as a string). Rewrite exactly that shape into
      // the correction; every other error is untouched.
      return result.error
        ? { ...result, error: explainNativeToolReferenceError(result.error) }
        : result;
    } catch (err) {
      // Outer executor-level failure (sandbox spawn, module load). Propagate as
      // a string — createCodeTool's execute wrapper converts a non-empty
      // `error` into a thrown AI SDK error the model sees as `tool-output-error`.
      return { result: undefined, error: renderThrownChain({ cause: err }) };
    }
  }
}
