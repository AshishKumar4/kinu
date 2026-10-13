/**
 * An executor's namespace for programs: each member it implements, declared once in the catalog and forwarded to the
 * executor's own member, which the shell tool also calls with its job and signal. A refusal the executor answers is
 * the call's failure.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import type { ExecutorProviderSurface } from '../execution/types';
import { answeredRefusal } from '../execution/exec-result';
import { KinuError, settleSync } from '../obs/index';
import { serve, type Operation, type Served } from '../operations/operation';
import { COMPUTER, computerResize, DEVICE, PARENT, WORKSPACE } from '../operations/executors';
import { JsonObjectSchema, projectJsonValue, type JsonObject, type JsonValue } from '../utils/json';
import { DESKTOP_MEMBERS } from '../execution/desktop';
import type { ExecCallContext } from '../execution/signal';
import { programExecContext } from './outcome';
import type { CodemodeProvider } from '../types/codemode';
import { callArgs, codemodeNamespace } from './operation-surfaces';

/** Each executor's declared members and what it is, by the executor's name. */
const DECLARED = new Map<string, { readonly ops: Readonly<Record<string, Operation>>; readonly summary: string }>([
  ['workspace', { ops: WORKSPACE, summary: 'Your workspace: its files and shell, the tools you save, and its slates.' }],
  ['computer', { ops: COMPUTER, summary: 'Your computer, a Linux machine with files and a shell of its own.' }],
  ['parent', { ops: PARENT, summary: 'The workspace that hired you.' }],
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

/** Each declared member the executor implements, forwarded with the arguments it is called with. */
function forwarded(provider: Pick<ExecutorProviderSurface, 'name' | 'tools'>, ops: readonly Operation[]): Served[] {
  return ops.flatMap((op) => {
    const member = provider.tools[op.name];

    if (member === undefined) return [];

    return [serve(op, (input, { signal }) => Effect.flatMap(Effect.promise(() => member.execute(...memberArgs(op, v.parse(JsonObjectSchema, projectJsonValue({ value: input })), signal))), (answer) => {
      const refusal = answeredRefusal(projectJsonValue({ value: answer }));

      if (refusal !== null) return Effect.fail(new KinuError(refusal.reason ?? 'io', refusal.error, refusal.execution === undefined ? undefined : { execution: refusal.execution }));

      return Effect.succeed(v.parse(op.output, answer));
    }))];
  });
}

/** The workspace's `slates` is an object of slates, not an operation, so it is declared as the member it is. */
const SLATES_DECLARATION = {
  full: '/** Slates in this workspace; read vfs://skills/slates/SKILL.md first, which names the `$` members.\n'
    + ' * `await workspace.slates.board.addStroke(stroke)` runs the board slate\'s `addStroke`. */\n'
    + 'slates: { readonly [id: string]: { readonly [member: string]: (...args: unknown[]) => Promise<unknown> } };',
  call: 'slates.<id>.<member>(...)',
};

/** An executor's members as programs call them; a computer with sizes adds `resize` over them. */
export function executorNamespace(provider: ExecutorProviderSurface): CodemodeProvider {
  const declared = DECLARED.get(provider.name);

  if (declared === undefined) return settleSync(Effect.die(new Error(`executor ${provider.name} has no declared members`)));
  // Only a computer with sizes has `resize`, declared over them.
  const sizes = provider.tools.resize === undefined ? undefined : provider.getStatus?.().sizes;
  const ops = sizes === undefined ? Object.values(declared.ops) : [...Object.values(declared.ops), computerResize(sizes.sizes)];
  const namespace = codemodeNamespace(provider.name, declared.summary, forwarded(provider, ops));
  const slates = provider.tools.slates;

  if (slates === undefined) return namespace;

  return { ...namespace, tools: { ...namespace.tools, slates }, declarations: { ...namespace.declarations, slates: SLATES_DECLARATION } };
}
