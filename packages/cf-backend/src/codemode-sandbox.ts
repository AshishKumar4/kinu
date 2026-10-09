/**
  * The `eval` sandbox: codemode's DynamicWorkerExecutor plus `kinu-node.js`, a `tools` prelude
  * (process, require, workspace.slates, env, crafted tools) and loopback egress (server.ts `CodemodeEgress`).
  */

import { DynamicWorkerExecutor, sanitizeToolName } from '@cloudflare/codemode';
import { normalizeCode } from '@cloudflare/codemode/normalize';
import {
  explainSandboxError, renderCraftedDefinitions,
  NO_TIMER_DEADLINE_MS, bindTaskPlan, launched, codemodeFunction, decodeJsonValue, relayedAnswer,
  type CraftedToolSource, type ExecuteResult, type Executor, type ResolvedProvider as HostProvider,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { KINU_NODE_MODULE_NAME, KINU_NODE_MODULE_SOURCE } from '@kinu.run/core';
import { WorkerEntrypoint, exports } from 'cloudflare:workers';
import { EGRESS_FAILURE_HEADER, codemodeEgress, type CodemodeEgressProps } from './codemode-egress';
import { BROWSER_CLIENT_MODULE, browserClientSource } from './browser-prelude';

type DynamicProviderInput = Parameters<DynamicWorkerExecutor['execute']>[1];

type ResolvedProvider = Extract<DynamicProviderInput, object[]>[number];

export interface SandboxIdentity {
  readonly workspace: string;
  /** Where the program's `process` starts: the actor's own (`PathPlanes.cwd`). */
  readonly cwd: string;
}

/**
  * `typeof` guards: a namespace this actor does not wire is an unresolved identifier, and `typeof`
  * is the one read of it that does not throw. An unparseable crafted body throws only on call.
  */
export function renderToolsPrelude(crafted: readonly CraftedToolSource[], identity: SandboxIdentity): string {
  return [
    `    const __kinu = await import(${JSON.stringify(`./${KINU_NODE_MODULE_NAME}`)});`,
    '    const __kinuWorkspace = typeof workspace === "undefined" ? null : workspace;',
    '    __kinu.bindSlates(__kinuWorkspace);',
    '    const __kinuState = typeof state === "undefined" ? null : state;',
    '    const __kinuBuiltins = await __kinu.loadBuiltins();',
    `    const process = __kinu.createProcess(${JSON.stringify(identity.cwd)});`,
    '    const require = __kinu.createRequire({ workspace: __kinuWorkspace, builtins: __kinuBuiltins.loaded, cwd: process.cwd() });',
    `    const fetch = __kinu.createFetch(${JSON.stringify(EGRESS_FAILURE_HEADER)});`,
    `    const env = Object.freeze({ workspace: ${JSON.stringify(identity.workspace)}, state: __kinuState, missingBuiltins: __kinuBuiltins.missing });`,
    renderCraftedDefinitions(crafted),
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

type ProgramResult = Awaited<ReturnType<DynamicWorkerExecutor['execute']>>;

/**
 * A provider as the sandbox must hold it for a program to reach each member by the name it wrote. The vendor registers
 * a member under its sanitized name (`delete` as `delete_`) but dispatches the name the program wrote, so `state.delete`
 * never resolved; its namespace serves its own properties first, so each such name is set there as the sanitized
 * member. `workspace.createTool` takes the function itself, sent as its source: source written as text in the program
 * had its escapes read once by the program and again by the tool's parser.
 */
function reachableAsWritten(provider: ResolvedProvider): ResolvedProvider {
  const ns = provider.name;

  const lines = Object.keys(provider.fns)
    .filter((name) => sanitizeToolName(name) !== name)
    .map((name) => `    ${ns}[${JSON.stringify(name)}] = ${ns}[${JSON.stringify(sanitizeToolName(name))}];`);

  if (ns === 'workspace' && Object.hasOwn(provider.fns, 'createTool')) {
    lines.push('    { const create = workspace.createTool; workspace.createTool = (name, description, code, ...rest) => '
      + 'create(name, description, typeof code === "function" ? String(code) : code, ...rest); }');
  }

  if (lines.length === 0) return provider;

  // Before its own prelude, which defines what it serves itself (a crafted tool's body) under the written name.
  return { ...provider, prelude: [...lines, ...(provider.prelude === undefined ? [] : [provider.prelude])].join('\n') };
}

/** Console output as the program meant it: an object as JSON, where the vendor's `String` logs `[object Object]`, and `[]` as `""`. */
const SHOWN_CONSOLE = 'const __kinuShown = (value) => { if (typeof value === "string") return value; '
  + 'try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } }; '
  + 'for (const level of ["log", "warn", "error"]) { const write = console[level]; console[level] = (...args) => write(...args.map(__kinuShown)); }';

export interface ProgramLaunch {
  run(source: string, providers: ResolvedProvider[]): Promise<ProgramResult>;
}

export interface CodemodeLauncherProps {
  readonly kinuNode: boolean;
  readonly egress: CodemodeEgressProps | null;
}

/** Launches in a request of its own, so no program holds a workspace slot (D10). */
export class CodemodeLauncher extends WorkerEntrypoint<{ readonly LOADER: WorkerLoader }, CodemodeLauncherProps> {
  async run(source: string, providers: ResolvedProvider[]): Promise<ProgramResult> {
    const { kinuNode, egress } = this.ctx.props;

    const worker = await programWorker({ loader: this.env.LOADER, egress: egress === null ? null : codemodeEgress(egress), kinuNode });

    return await worker.execute(`async () => { ${SHOWN_CONSOLE}\n return await (\n${normalizeCode(source)}\n)(); }`, providers.map(reachableAsWritten));
  }

  /** Asked from a detached background job's context (core jobs/runner `alive`), over the path its programs take. */
  answer(): void {}
}

/** Each run is counted by the invocation whose work launched it, when that invocation holds its programs (`launched`). */
export function codemodeLauncher(props: CodemodeLauncherProps): ProgramLaunch {
  return { run: (source, providers) => launched(exports.CodemodeLauncher({ props }).run(source, providers)) };
}

/** A context the platform dropped delivers no answer, this one's included, so a job whose context stops answering
 *  has lost its work's answers too. */
export async function jobContextAnswers(): Promise<void> {
  await exports.CodemodeLauncher({ props: { kinuNode: false, egress: null } }).answer();
}

/** No work deadline, where codemode's default is 60 s: a node agent's whole scaffold loop is one program, bounded
 *  by the detach window and the platform CPU limit. */
async function programWorker(input: { readonly loader: WorkerLoader; readonly egress: Fetcher | null; readonly kinuNode: boolean }): Promise<DynamicWorkerExecutor> {
  return new DynamicWorkerExecutor({
    loader: input.loader,
    timeout: NO_TIMER_DEADLINE_MS,
    globalOutbound: input.egress,
    modules: input.kinuNode ? { [KINU_NODE_MODULE_NAME]: KINU_NODE_MODULE_SOURCE, [BROWSER_CLIENT_MODULE]: await browserClientSource() } : {},
  });
}

export class KinuSandboxExecutor {
  readonly #inner: ProgramLaunch;
  /** Source run before each program, in its scope: `describe` (`describeProgramSource`). */
  readonly #prelude: string;

  constructor(launch: ProgramLaunch, prelude = '') {
    this.#inner = launch;
    this.#prelude = prelude;
  }

  async execute(code: string, providers: DynamicProviderInput) {
    const providerArr: ResolvedProvider[] = Array.isArray(providers)
      ? providers
      : [{ name: 'codemode', fns: providers }];

    try {
      // The vendor reads only err.message. Carry an explicitly thrown refusal
      // as a result so the shared completion mapper retains its classification.
      const callable = normalizeCode(code);
      const source = `async () => { ${this.#prelude}\n try { return await (${callable})(); } catch (cause) { if (cause && cause.success === false && typeof cause.error === 'string') return cause; throw cause; } }`;
      const result = await this.#inner.run(source, attributeProviders(providerArr));

      // DWE returns sandbox-internal failures as strings; only the native-tool ReferenceError is
      // rewritten into the correction.
      return result.error
        ? { ...result, error: explainSandboxError(result.error) }
        : result;
    } catch (err) {
      // createCodeTool turns a non-empty `error` into a tool-output-error the model sees.
      return { result: undefined, error: renderThrownChain({ cause: err }) };
    }
  }
}

/** `rt.executor`: heads, swarm scoring, mcts and craft run programs through it. */
export function createRuntimeExecutor(launch: ProgramLaunch): Executor {
  return {
    languages: ['javascript'],
    async execute(code: string, providers: HostProvider[]): Promise<ExecuteResult> {
      try {
        const normalized = Array.isArray(providers)
          ? providers
          : [{ name: 'codemode', fns: providers }];

        const bridged = normalized.map((provider) => ({
          name: provider.name,
          fns: Object.fromEntries(Object.entries(provider.fns).map(([name, fn]) => [
            name,
            async (...args: unknown[]) => await relayedAnswer(fn(...args.map((value) => decodeJsonValue({ value })))),
          ])),
        }));

        const res = await launch.run(code, bridged);
        const result = res.result === undefined ? undefined : decodeJsonValue({ value: res.result });
        const output: ExecuteResult = { result };

        if (res.error !== undefined) output.error = res.error;

        if (res.logs !== undefined) output.logs = res.logs;

        return output;
      } catch (e) {
        return { result: undefined, error: renderThrownChain({ cause: e }) };
      }
    },
  };
}
