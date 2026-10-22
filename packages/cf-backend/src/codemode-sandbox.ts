/**
  * The `eval` sandbox: codemode's DynamicWorkerExecutor plus `kinu-node.js`, a `tools` prelude
  * (process, require, workspace.slates, env, crafted tools) and loopback egress (server.ts `CodemodeEgress`).
  */

import { DynamicWorkerExecutor, sanitizeToolName } from '@cloudflare/codemode';
import { normalizeCode } from '@cloudflare/codemode/normalize';
import {
  CRAFTED_TOOL_NAMESPACE, explainSandboxError, nestedMembers, renderCraftedDefinitions, SANDBOX_CONSOLE_PRELUDE, SANDBOX_CREATE_TOOL_PRELUDE,
  NO_TIMER_DEADLINE_MS, bindTaskPlan, launched, codemodeFunction, type MemberImpacts, decodeJsonValue, relayedAnswer,
  type CraftedToolSource, type ExecuteResult, type Executor, type ProgramStop, type ResolvedProvider as HostProvider,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { KINU_NODE_MODULE_NAME, KINU_NODE_MODULE_SOURCE, programPlace, stoppedProgram } from '@kinu.run/core';
import { WorkerEntrypoint, exports } from 'cloudflare:workers';
import { codemodeEgress, type CodemodeEgressProps } from './codemode-egress-mint';
import { EGRESS_FAILURE_HEADER } from './egress/send-out';
import { BROWSER_CLIENT_MODULE, browserClientSource } from './browser-prelude';
import { NODE_COMPAT_MODULE, nodeCompatSource } from './node-compat-module';
import { runNodeProgram, type NodeProgramPrincipal } from './node-program';

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
    `    const __kinuCompat = await import(${JSON.stringify(`./${NODE_COMPAT_MODULE}`)});`,
    '    const __kinuWorkspace = typeof workspace === "undefined" ? null : workspace;',
    '    __kinu.bindSlates(__kinuWorkspace);',
    '    const __kinuBuiltins = await __kinu.loadBuiltins();',
    `    const process = __kinu.createProcess(${JSON.stringify(identity.cwd)});`,
    '    const __kinuMachines = { computer: typeof computer === "undefined" ? null : computer, device: typeof device === "undefined" ? null : device };',
    '    const require = __kinu.createRequire({ workspace: __kinuWorkspace, machines: __kinuMachines, builtins: __kinuBuiltins.loaded, cwd: process.cwd(), createNodeCompat: __kinuCompat.createNodeCompat });',
    `    const fetch = __kinu.createFetch(${JSON.stringify(EGRESS_FAILURE_HEADER)});`,
    // The program's own bindings first (the owner's secrets granted here, `process.env` holds them too), never over these.
    `    const env = Object.freeze({ ...this.env, workspace: ${JSON.stringify(identity.workspace)}, missingBuiltins: __kinuBuiltins.missing });`,
    renderCraftedDefinitions(crafted),
  ].join('\n');
}

/**
 * Capture the invocation's task plan and failure census before the RPC hop.
 */
function attributeProviders(providers: ResolvedProvider[], impacts: MemberImpacts): ResolvedProvider[] {
  return providers.map((provider) => {
    const fns: ResolvedProvider['fns'] = {};

    for (const [name, fn] of Object.entries(provider.fns)) {
      const invoke = bindTaskPlan(fn);
      fns[name] = codemodeFunction(provider.name, name, invoke, impacts(provider.name, name));
    }

    const attributed: ResolvedProvider = { name: provider.name, fns };

    if (provider.prelude !== undefined) attributed.prelude = provider.prelude;

    return attributed;
  });
}

type ProgramResult = Awaited<ReturnType<DynamicWorkerExecutor['execute']>>;

/**
 * A provider as the sandbox must hold it for a program to reach each member by the name it wrote, in the shape an
 * in-process program holds one (`programNamespace`). The vendor registers a member under its sanitized name (`delete`
 * as `delete_`) but dispatches the name the program wrote, so `state.delete` never resolved; its namespace serves its
 * own properties first, so each member is set there by the name written, as the registered member. `workspace.createTool` takes the function itself, sent as its source: source written as text in the program
 * had its escapes read once by the program and again by the tool's parser.
 *
 * Every namespace has its own `then`, undefined, so it is never a thenable: the vendor's proxy answers any other name
 * as a member, and `await agents` called `agents.then` as one, which rejected unheard while the await waited on its
 * callbacks forever (production crafted-harbor-37f29697, 2026-10-16: a program held its job running for 12.5 h).
 */
function reachableAsWritten(provider: ResolvedProvider): ResolvedProvider {
  const ns = provider.name;
  const registered = (name: string): string => `${ns}[${JSON.stringify(sanitizeToolName(name))}]`;

  // A member group (`fs.read`) is an object of its members, each the member the vendor registered.
  const held = Object.entries(nestedMembers(Object.fromEntries(Object.keys(provider.fns).map((name) => [name, name]))));

  const lines = [`    ${ns}.then = undefined;`];

  // Each member it serves is its own property, so `'slates' in workspace` says whether slates are served
  // (`programNamespace`, the in-process shape); any other name the vendor's proxy answers, refused when called.
  for (const [name, member] of held) {
    if (typeof member !== 'string') {
      lines.push(`    ${ns}[${JSON.stringify(name)}] = Object.freeze({ ${Object.entries(member).map(([inner, full]) => `${JSON.stringify(inner)}: ${registered(full)}`).join(', ')} });`);
    } else lines.push(`    ${ns}[${JSON.stringify(name)}] = ${registered(name)};`);
  }

  if (ns === 'workspace' && Object.hasOwn(provider.fns, 'createTool')) lines.push(`    ${SANDBOX_CREATE_TOOL_PRELUDE}`);

  // Before its own prelude, which defines what it serves itself (a crafted tool's body) under the written name.
  return { ...provider, prelude: [...lines, ...(provider.prelude === undefined ? [] : [provider.prelude])].join('\n') };
}

export interface ProgramLaunch {
  /** `deadlineMs`: the sandbox ends the program after this long; absent, nothing but completion does. */
  run(source: string, providers: ResolvedProvider[], opts?: { readonly deadlineMs?: number }): Promise<ProgramResult>;
  /** Who its programs run as, which one that imports from the workspace runs as there (`node-program.ts`); absent, none does. */
  readonly principal?: NodeProgramPrincipal;
}

export interface CodemodeLauncherProps {
  readonly kinuNode: boolean;
  readonly egress: CodemodeEgressProps | null;
  /** The program's bindings, `env.NAME` and `process.env.NAME`: the owner's secrets granted to its workspace. */
  readonly env: Readonly<Record<string, string>>;
  /** The sandbox ends the program after this long; absent, nothing but completion does. */
  readonly deadlineMs?: number;
}

/** Launches in a request of its own, so no program holds a workspace slot (D10). */
export class CodemodeLauncher extends WorkerEntrypoint<{ readonly LOADER: WorkerLoader }, CodemodeLauncherProps> {
  async run(source: string, providers: ResolvedProvider[]): Promise<ProgramResult> {
    const { kinuNode, egress, env, deadlineMs } = this.ctx.props;

    const worker = await programWorker({
      loader: this.env.LOADER, egress: egress === null ? null : codemodeEgress(egress), kinuNode, env, timeout: deadlineMs ?? NO_TIMER_DEADLINE_MS,
    });

    // The vendor runs preludes in its providers' order: every namespace holds its members as its own first, so `tools.*`'s
    // prelude, which binds slates where the workspace serves them, finds what each serves.
    const ordered = [...providers.filter((provider) => provider.name !== CRAFTED_TOOL_NAMESPACE), ...providers.filter((provider) => provider.name === CRAFTED_TOOL_NAMESPACE)];

    return await worker.execute(`async () => { ${SANDBOX_CONSOLE_PRELUDE}\n return await (\n${normalizeCode(source)}\n)(); }`, ordered.map(reachableAsWritten));
  }

  /** Asked from a detached background job's context (core jobs/runner `alive`), over the path its programs take. */
  answer(): void {}
}

/**
 * Each run is counted by the invocation whose work launched it, when that invocation holds its programs (`launched`).
 * `environment` is read for each run, so a secret granted or revoked since is as it stands.
 */
export function codemodeLauncher(props: Omit<CodemodeLauncherProps, 'env'>, environment: () => Promise<Readonly<Record<string, string>>>): ProgramLaunch {
  const run: ProgramLaunch['run'] = async (source, providers, opts) => {
    const env = await environment();
    const deadline = opts?.deadlineMs === undefined ? {} : { deadlineMs: opts.deadlineMs };

    return await launched(exports.CodemodeLauncher({ props: { ...props, env, ...deadline } }).run(source, providers));
  };

  // Online, its programs reach the network as this principal, so one that imports from the workspace may run there.
  const principal = props.egress?.principal;

  return principal === undefined ? { run } : { run, principal: { workspace: principal.workspace, actorId: principal.actorId, as: principal.as } };
}

/** A context the platform dropped delivers no answer, this one's included, so a job whose context stops answering
 *  has lost its work's answers too. */
export async function jobContextAnswers(): Promise<void> {
  await exports.CodemodeLauncher({ props: { kinuNode: false, egress: null, env: {} } }).answer();
}

/** No work deadline unless the caller set one, where codemode's default is 60 s: a node agent's whole scaffold loop is
 *  one program, bounded by the detach window and the platform CPU limit. */
async function programWorker(input: {
  readonly loader: WorkerLoader; readonly egress: Fetcher | null; readonly kinuNode: boolean; readonly env: Readonly<Record<string, string>>;
  readonly timeout: number;
}): Promise<DynamicWorkerExecutor> {
  return new DynamicWorkerExecutor({
    loader: input.loader,
    timeout: input.timeout,
    globalOutbound: input.egress,
    bindings: { ...input.env },
    modules: input.kinuNode
      ? { [KINU_NODE_MODULE_NAME]: KINU_NODE_MODULE_SOURCE, [NODE_COMPAT_MODULE]: await nodeCompatSource(), [BROWSER_CLIENT_MODULE]: await browserClientSource() }
      : {},
  });
}

/** Where a program that imports from the workspace runs as Node (`node-program.ts`): its directory and crafted tools. */
export interface NodeProgramPlace {
  readonly cwd: string;
  readonly crafted: readonly CraftedToolSource[];
}

export class KinuSandboxExecutor {
  readonly #inner: ProgramLaunch;
  /** Source run before each program, in its scope: `describe` (`describeProgramSource`). */
  readonly #prelude: string;
  /** What each member's served operation declares, from the providers it was built over (`servedImpacts`). */
  readonly #impacts: MemberImpacts;
  /** Absent: every program runs in the isolate, and one that imports from the workspace is refused. */
  readonly #node: NodeProgramPlace | undefined;

  constructor(launch: ProgramLaunch, prelude = '', impacts: MemberImpacts = () => null, node?: NodeProgramPlace) {
    this.#inner = launch;
    this.#prelude = prelude;
    this.#impacts = impacts;
    this.#node = node;
  }

  async execute(code: string, providers: DynamicProviderInput) {
    const providerArr: ResolvedProvider[] = Array.isArray(providers)
      ? providers
      : [{ name: 'codemode', fns: providers }];

    const place = programPlace(code);

    if (place.kind === 'node') return await this.#onNode(code, place.imports, attributeProviders(providerArr, this.#impacts));

    try {
      // The vendor reads only err.message. Carry an explicitly thrown refusal
      // as a result so the shared completion mapper retains its classification.
      const callable = normalizeCode(code);
      const source = `async () => { ${this.#prelude}\n try { return await (${callable})(); } catch (cause) { if (cause && cause.success === false && typeof cause.error === 'string') return cause; throw cause; } }`;
      const result = await this.#inner.run(source, attributeProviders(providerArr, this.#impacts));

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

  /** A program that imports from the workspace, run there as Node, as the one who runs it; one offline runs nowhere. */
  async #onNode(code: string, imports: Parameters<typeof runNodeProgram>[0]['imports'], providers: ResolvedProvider[]): Promise<ProgramResult> {
    const principal = this.#inner.principal;

    if (principal === undefined || this.#node === undefined) {
      return { result: undefined, error: 'Imports from the workspace run the program in the workspace, which this call cannot: inline what it imports.' };
    }

    const [ran] = await Promise.allSettled([runNodeProgram({ code, imports, providers, principal, cwd: this.#node.cwd, crafted: this.#node.crafted, prelude: this.#prelude })]);

    return ran.status === 'fulfilled' ? ran.value : { result: undefined, error: renderThrownChain({ cause: ran.reason }) };
  }
}

/** `rt.executor`: heads, swarm scoring, mcts and craft run programs through it. */
export function createRuntimeExecutor(launch: ProgramLaunch): Executor {
  return {
    languages: ['javascript'],
    execute(code: string, providers: HostProvider[], opts?: ProgramStop): Promise<ExecuteResult> {
      // The sandbox ends a program at its deadline; a stop answers here at once, as the program may still be running.
      return stoppedProgram(() => runtimeProgram(launch, code, providers, opts?.deadlineMs), opts);
    },
  };
}

async function runtimeProgram(launch: ProgramLaunch, code: string, providers: HostProvider[], deadlineMs: number | undefined): Promise<ExecuteResult> {
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

    const res = await launch.run(code, bridged, deadlineMs === undefined ? {} : { deadlineMs });
    const result = res.result === undefined ? undefined : decodeJsonValue({ value: res.result });
    const output: ExecuteResult = { result };

    if (res.error !== undefined) output.error = res.error;

    if (res.logs !== undefined) output.logs = res.logs;

    return output;
  } catch (e) {
    return { result: undefined, error: renderThrownChain({ cause: e }) };
  }
}
