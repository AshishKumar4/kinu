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
import { DEVICE, PARENT, SANDBOX, WORKSPACE, sandboxResize } from '../operations/executors';
import { JsonObjectSchema, projectJsonValue, type JsonValue } from '../utils/json';
import { programExecContext } from './outcome';
import type { CodemodeProvider } from '../types/codemode';
import { callArgs, codemodeNamespace } from './operation-surfaces';

/** Each executor's declared members, by the executor's name. */
const DECLARED = new Map<string, Readonly<Record<string, Operation>>>([['workspace', WORKSPACE], ['sandbox', SANDBOX], ['parent', PARENT], ['device', DEVICE]]);

/** A shell call's arguments, with what the running program's backend says its shell calls carry. */
function withExecContext(op: Operation, args: readonly JsonValue[]): unknown[] {
  const context = op.name === 'exec' ? programExecContext() : undefined;

  if (context === undefined) return [...args];
  const [command, options] = args;

  return [command, { ...v.parse(v.optional(JsonObjectSchema, {}), options), ...context }];
}

/** Each declared member the executor implements, forwarded with the arguments it is called with. */
function forwarded(provider: Pick<ExecutorProviderSurface, 'name' | 'tools'>, ops: readonly Operation[]): Served[] {
  return ops.flatMap((op) => {
    const member = provider.tools[op.name];

    if (member === undefined) return [];

    return [serve(op, (input) => Effect.flatMap(Effect.promise(() => member.execute(...withExecContext(op, callArgs(op, v.parse(JsonObjectSchema, projectJsonValue({ value: input })))))), (answer) => {
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

/** An executor's members as programs call them; a sandbox with sizes adds `resize` over them. */
export function executorNamespace(provider: ExecutorProviderSurface): CodemodeProvider {
  const declared = DECLARED.get(provider.name);

  if (declared === undefined) return settleSync(Effect.die(new Error(`executor ${provider.name} has no declared members`)));
  // Only a sandbox with sizes has `resize`, declared over them.
  const sizes = provider.tools.resize === undefined ? undefined : provider.getStatus?.().sizes;
  const ops = sizes === undefined ? Object.values(declared) : [...Object.values(declared), sandboxResize(sizes.sizes)];
  const namespace = codemodeNamespace(provider.name, forwarded(provider, ops));
  const slates = provider.tools.slates;

  if (slates === undefined) return namespace;

  return { ...namespace, tools: { ...namespace.tools, slates }, declarations: { ...namespace.declarations, slates: SLATES_DECLARATION } };
}
