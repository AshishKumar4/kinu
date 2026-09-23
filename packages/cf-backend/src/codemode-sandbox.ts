/**
  * The `eval` sandbox: codemode's DynamicWorkerExecutor plus `kinu-node.js`, a `tools` prelude
  * (process, require, env, crafted tools) and loopback egress (server.ts `CodemodeEgress`).
  */

import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { normalizeCode } from '@cloudflare/codemode/normalize';
import {
  explainNativeToolReferenceError, parsesAsExpression,
  NO_TIMER_DEADLINE_MS, bindTaskPlan, codemodeFunction,
  type CraftedToolSource,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { KINU_NODE_MODULE_NAME, KINU_NODE_MODULE_SOURCE, WORKSPACE_ROOT } from '@kinu.run/core';
import { EGRESS_FAILURE_HEADER } from './codemode-egress';

type DynamicProviderInput = Parameters<DynamicWorkerExecutor['execute']>[1];

type ResolvedProvider = Extract<DynamicProviderInput, object[]>[number];

export interface SandboxIdentity {
  readonly workspace: string;
}

/**
  * `typeof` guards: a namespace this actor does not wire is an unresolved identifier, and `typeof`
  * is the one read of it that does not throw. An unparseable crafted body throws only on call.
  */
export function renderToolsPrelude(crafted: readonly CraftedToolSource[], identity: SandboxIdentity): string {
  const definitions = crafted.map((entry) => {
    const parseError = parsesAsExpression(entry.code);

    const factory = parseError === null
      // Async: the gate admits top-level `await`, which in a sync arrow is a SyntaxError that
      // breaks the whole prelude module.
      ? `async () => (\n${entry.code}\n)`
      : `() => { throw new Error(${JSON.stringify(`stored source does not parse: ${parseError}`)}); }`;

    return `      ${JSON.stringify(entry.name)}: __kinu.defineCrafted(${JSON.stringify(entry.name)}, ${factory}, tools[${JSON.stringify(entry.name)}]),`;
  });

  return [
    `    const __kinu = await import(${JSON.stringify(`./${KINU_NODE_MODULE_NAME}`)});`,
    '    const __kinuWorkspace = typeof workspace === "undefined" ? null : workspace;',
    '    const __kinuState = typeof state === "undefined" ? null : state;',
    '    const __kinuBuiltins = await __kinu.loadBuiltins();',
    `    const process = __kinu.createProcess(${JSON.stringify(WORKSPACE_ROOT)});`,
    '    const require = __kinu.createRequire({ workspace: __kinuWorkspace, builtins: __kinuBuiltins.loaded, cwd: process.cwd() });',
    `    const fetch = __kinu.createFetch(${JSON.stringify(EGRESS_FAILURE_HEADER)});`,
    `    const env = Object.freeze({ workspace: ${JSON.stringify(identity.workspace)}, state: __kinuState, missingBuiltins: __kinuBuiltins.missing });`,
    '    Object.assign(tools, {',
    ...definitions,
    '    });',
  ].join('\n');
}

/**
 * Capture the invocation's task plan and failure census before the RPC hop.
 */
function attributeProviders(providers: ResolvedProvider[]): ResolvedProvider[] {
  return providers.map((provider) => {
    const fns: ResolvedProvider['fns'] = {};

    for (const [name, fn] of Object.entries(provider.fns)) {
      const invoke = bindTaskPlan(fn);
      fns[name] = codemodeFunction(provider.name, name, invoke);
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

export class KinuSandboxExecutor {
  readonly #inner: DynamicWorkerExecutor;

  constructor(options: KinuSandboxExecutorOptions) {
    // No work deadline: programs mostly await long host calls. The detach window bounds them;
    // the platform CPU limit stops runaways.
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
      // The vendor reads only err.message. Carry an explicitly thrown refusal
      // as a result so the shared completion mapper retains its classification.
      const callable = normalizeCode(code);
      const source = `async () => { try { return await (${callable})(); } catch (cause) { if (cause && cause.success === false && typeof cause.error === 'string') return cause; throw cause; } }`;
      const result = await this.#inner.execute(source, attributeProviders(providerArr));

      // DWE returns sandbox-internal failures as strings; only the native-tool ReferenceError is
      // rewritten into the correction.
      return result.error
        ? { ...result, error: explainNativeToolReferenceError(result.error) }
        : result;
    } catch (err) {
      // createCodeTool turns a non-empty `error` into a tool-output-error the model sees.
      return { result: undefined, error: renderThrownChain({ cause: err }) };
    }
  }
}
