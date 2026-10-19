/**
 * An executor's namespace for programs: each member it implements, declared once in the catalog and forwarded to the
 * executor's own member, which the shell tool also calls with its job and signal. A refusal the executor answers is
 * the call's failure.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import type { ExecutorProviderSurface, ExecutorTool } from '../execution/types';
import { answeredRefusal } from '../execution/exec-result';
import { attempt, attemptInItsWords, KinuError, settleSync } from '../obs/index';
import { serve, type Operation, type Served } from '../operations/operation';
import { COMPUTER, computerDesktop, computerResize, DEVICE, MACHINE_CAPABILITIES, MACHINE_FILES, machineFileOperations, machineOperations, PARENT, WORKSPACE } from '../operations/executors';
import { JsonObjectSchema, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { DESKTOP_MEMBERS } from '../execution/desktop';
import type { ExecCallContext } from '../execution/signal';
import { programExecContext } from './outcome';
import type { CodemodeProvider } from '../types/codemode';
import { callArgs, codemodeNamespace } from './operation-surfaces';

/** Each executor's own members and what it is, by the executor's name; the members every machine shares are admitted
 *  by its capabilities (`machineOperations`). */
const DECLARED = new Map<string, { readonly ops: Readonly<Record<string, Operation>>; readonly summary: string }>([
  ['workspace', { ops: WORKSPACE, summary: 'Your workspace: its files and shell, the tools you save, and its slates.' }],
  ['computer', {
    ops: COMPUTER,
    summary: 'Your computer, a Linux machine with files and a shell of its own. Bun is its default toolchain (`bun install`, '
      + '`bun run`, `bun x`, `bun test`); restored after it slept, it keeps source and lockfiles but not node_modules or '
      + 'build output, so after a failed import run `bun install` once.',
  }],
  ['parent', { ops: PARENT, summary: 'The workspace that hired you; its shell is the fast way to search it (`grep -rn`, `find`).' }],
  ['device', { ops: DEVICE, summary: 'The user\'s machine.' }],
]);

/** What a program's shell or desktop call carries beyond its arguments, as its backend says, or else the call's own
 *  stop signal: a caller outside eval stops its command by cancelling the call. */
function callContext(signal: AbortSignal | undefined): ExecCallContext | undefined {
  return programExecContext() ?? (signal === undefined ? undefined : { signal });
}

/** A shell call's arguments, its context merged into its options. */
function withExecContext(op: Operation, args: readonly JsonValue[], signal: AbortSignal | undefined): unknown[] {
  const context = op.name === 'exec' ? callContext(signal) : undefined;

  if (context === undefined) return [...args];
  const [command, options] = args;

  return [command, { ...v.parse(v.optional(JsonObjectSchema, {}), options), ...context }];
}

/** A desktop member is called with its named input and its context: stopped with its program, and refused once its
 *  program was moved to the background. */
function memberArgs(op: Operation, input: JsonObject, signal: AbortSignal | undefined): unknown[] {
  if (op.ns === 'computer' && DESKTOP_MEMBERS.some((member) => member === op.name)) return [input, callContext(signal)];

  return withExecContext(op, callArgs(op, input), signal);
}

/** One member forwarded to the executor's own member of its name, with the arguments it is called with. */
function forward(member: ExecutorTool, op: Operation): Served {
  return serve(op, (input, { signal }) => Effect.flatMap(Effect.promise(() => member.execute(...memberArgs(op, v.parse(JsonObjectSchema, projectJsonValue({ value: input })), signal))), (answer) => {
    const refusal = answeredRefusal(projectJsonValue({ value: answer }));

    if (refusal !== null) return Effect.fail(new KinuError(refusal.reason ?? 'io', refusal.error, refusal.execution === undefined ? undefined : { execution: refusal.execution }));

    return Effect.succeed(v.parse(op.output, answer));
  }));
}

/** Each of the executor's own members it implements. */
function forwarded(provider: Pick<ExecutorProviderSurface, 'tools'>, ops: readonly Operation[]): Served[] {
  return ops.flatMap((op) => {
    const member = provider.tools[op.name];

    return member === undefined ? [] : [forward(member, op)];
  });
}

/** A member the executor's capabilities admit and it does not run: said when called, never hidden. */
function unrun(provider: Pick<ExecutorProviderSurface, 'name'>, capability: string, op: Operation): Served {
  return serve(op, () => Effect.fail(new KinuError('unsupported', `${provider.name} declares ${capability} and runs no ${op.name}`)));
}

/** The port members over the executor's own port contract (`ExecutorProvider.exposePort`), as its previews answer them. */
function servedPorts(provider: ExecutorProviderSurface, ops: ReturnType<typeof machineOperations>['net_inbound']): Served[] {
  const { exposePort, unexposePort, listExposedPorts } = provider;

  if (exposePort === undefined || unexposePort === undefined || listExposedPorts === undefined) {
    return Object.values(ops).map((op) => unrun(provider, 'net_inbound', op));
  }

  const asked = <A>(doing: string, run: () => Promise<A>) => attempt({ doing: `${provider.name}.${doing}`, otherwise: 'io' }, run);

  return [
    serve(ops.exposePort, ({ port, name }) => Effect.flatMap(asked(`exposePort ${String(port)}`, () => exposePort(port, name === undefined ? undefined : { name })), (exposed) => (exposed.supported
      // The caller acts on the reason: start the server first, or leave the name off.
      ? Effect.succeed({ port: exposed.port, url: exposed.url, ...(exposed.name !== undefined && { name: exposed.name }), route: exposed.route })
      : Effect.fail(new KinuError('bad_input', exposed.reason))))),
    serve(ops.unexposePort, ({ port }) => asked(`unexposePort ${String(port)}`, () => unexposePort(port)).pipe(Effect.as(null))),
    serve(ops.listPorts, () => asked('listPorts', () => listExposedPorts())),
  ];
}

/** The members every machine shares, each where the executor's capabilities admit it. */
function machineServed(provider: ExecutorProviderSurface): Served[] {
  const admitted = machineOperations(provider.name);

  return MACHINE_CAPABILITIES.filter((capability) => provider.capabilities.has(capability)).flatMap((capability) => {
    if (capability === 'net_inbound') return servedPorts(provider, admitted.net_inbound);

    return Object.values<Operation>(admitted[capability]).map((op) => {
      const member = provider.tools[op.name];

      return member === undefined ? unrun(provider, capability, op) : forward(member, op);
    });
  });
}

/** The workspace's `slates` is an object of slates, not an operation, so it is declared as the member it is. */
const SLATES_DECLARATION = {
  full: '/** Slates in this workspace; read vfs://skills/slates/SKILL.md first, which names the `$` members.\n'
    + ' * `await workspace.slates.board.addStroke(stroke)` runs the board slate\'s `addStroke`. */\n'
    + 'slates: { readonly [id: string]: { readonly [member: string]: (...args: unknown[]) => Promise<unknown> } };',
  call: 'slates.<id>.<member>(...)',
};

const MachineFileCallSchema = v.looseObject({ path: v.string(), device: v.optional(v.string()) });

/**
 * `path` as the plane is handed it, on a machine whose files sit at `root` there. The workspace's own files are the
 * plane's root, which walks every path itself, so its path is passed as written. On a mounted machine a relative path
 * starts at its home, else its root, and every component is left for the plane and the machine to walk, after a link as
 * open(2) does. Only a spelling that climbs above the machine's root is refused, since the plane would take that `..`
 * out of the machine: where a link leads is never guessed.
 */
function onMachine(root: string, home: string | undefined, path: string): string {
  if (root === '') return path;
  const written = path.startsWith('/') ? path : `${(home ?? '').replace(/\/+$/u, '')}/${path}`;
  let depth = 0;

  for (const part of written.split('/')) {
    if (part === '..') depth -= 1;
    else if (part !== '' && part !== '.') depth += 1;

    if (depth < 0) throw new KinuError('denied', `${path} climbs above this machine's root, which its own paths start at`);
  }

  return `${root}${written}`;
}

/**
 * `<machine>.fs`: each `file` operation on this machine's root in the plane, run by the one served `file` operation, so
 * a read through either spelling lets an edit through the other and every write meets the same gates.
 */
function machineFiles(provider: ExecutorProviderSurface, files: Readonly<Record<string, Served>>): Served[] {
  const fileRoot = provider.fileRoot?.bind(provider);

  if (fileRoot === undefined) return [];

  return Object.values(machineFileOperations(provider.name)).flatMap((op) => {
    const file = files[op.name.slice(MACHINE_FILES.length + 1)];

    if (file === undefined) return [];

    return [serve(op, (input, call) => {
      const { path, device, ...rest } = v.parse(MachineFileCallSchema, input);

      // The file operation's refusal is the call's, in its own words: what to read first, what is missing.
      return Effect.map(attemptInItsWords('io', async () => {
        const { root, home } = await fileRoot(device);

        return await file.run(projectJsonValue({ value: { ...rest, path: onMachine(root, home, path) } }), call);
      }), (answered) => answered.value);
    })];
  });
}

/**
 * An executor's members as programs call them; a computer with sizes adds `resize` over them. `files`, the actor's
 * served `file` operations, gives a machine with a root in the plane its `fs`.
 */
export function executorNamespace(provider: ExecutorProviderSurface, files?: Readonly<Record<string, Served>>): CodemodeProvider {
  const declared = DECLARED.get(provider.name);

  if (declared === undefined) return settleSync(Effect.die(new Error(`executor ${provider.name} has no declared members`)));
  // Only a computer with sizes has `resize`, declared over them; only one with a desktop has its members, over its screen.
  const status = provider.tools.resize === undefined && provider.tools.screenshot === undefined ? undefined : provider.getStatus?.();
  const sizes = provider.tools.resize === undefined ? undefined : status?.sizes;

  const ops = [
    ...Object.values(declared.ops),
    ...sizes === undefined ? [] : [computerResize(sizes.sizes)],
    ...status?.screen === undefined ? [] : Object.values(computerDesktop(status.screen)),
  ];

  const namespace = codemodeNamespace(provider.name, declared.summary, [
    ...machineServed(provider), ...files === undefined ? [] : machineFiles(provider, files), ...forwarded(provider, ops),
  ]);

  const slates = provider.tools.slates;

  if (slates === undefined) return namespace;

  return { ...namespace, tools: { ...namespace.tools, slates }, declarations: { ...namespace.declarations, slates: SLATES_DECLARATION } };
}
