import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { WorkMode } from '../types/turn';
import { KinuError, refusalOf, type Refusal } from '../obs/error';

import type { CodemodeProvider } from '../tools/sandbox-contract';
const invocationMode = new AsyncLocalStorage<WorkMode>();
const PlanPermission = v.object({ planAllowed: v.literal(true) });

export function hasPlanPermission(operation: ToolSet[string]): boolean {
  return v.is(PlanPermission, operation);
}

/** Mode belongs to the invocation, including work that settles after its turn. */
export function currentWorkMode(): WorkMode {
  return invocationMode.getStore() ?? 'build';
}

/** A nested invocation may narrow authority but cannot upgrade a Plan parent. */
export function inWorkMode<Result>(mode: WorkMode, operation: () => Result): Result {
  return invocationMode.run(currentWorkMode() === 'plan' ? 'plan' : mode, operation);
}

/** A trusted queue, durable job record, or admitted turn starts independent work.
 * Unlike nested tool calls, its authority is not inherited from the callback that delivered it. */
export function runWorkModeInvocation<Result>(mode: WorkMode, operation: () => Result): Result {
  return invocationMode.run(mode, operation);
}

/** The producer declares this operation safe for Plan; nothing infers it from its name. */
export function permitInPlan<Operation extends ToolSet[string]>(operation: Operation): Operation & { planAllowed: true } {
  const permission = { planAllowed: true } satisfies { planAllowed: true };
  return Object.assign(operation, permission);
}

/** The refusal a Plan invocation receives, or null when the operation may proceed. */
export function workModeRefusal(mode: WorkMode, planAllowed: boolean, operation: string): Refusal | null {
  if ((mode === 'plan' || currentWorkMode() === 'plan') && !planAllowed) {
    return refusalOf(new KinuError('denied', operation + ' has no Plan-safe execution capability'));
  }
  return null;
}

export function requireWorkModePermission(mode: WorkMode, planAllowed: boolean, operation: string): void {
  const refusal = workModeRefusal(mode, planAllowed, operation);
  if (refusal !== null) throw new KinuError(refusal.reason, refusal.error);
}

export function requireBuild(operation: string): void {
  requireWorkModePermission(currentWorkMode(), false, operation);
}

/** Native tools retain their declared input schema; only their authority is narrowed. */
export function toolsInWorkMode(mode: WorkMode, tools: ToolSet): ToolSet {
  if (mode === 'build') return tools;
  const narrowed: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    if (execute === undefined) continue;
    const permitted = hasPlanPermission(entry);
    narrowed[name] = {
      ...entry,
      execute: (input, options) => inWorkMode(mode, async () => {
        requireWorkModePermission(mode, permitted, name);
        return await execute(input, options);
      }),
    };
  }
  return narrowed;
}

/** Every introduced host operation is checked; unclassified producers stay closed in Plan. */
export function providersInWorkMode(mode: WorkMode, providers: CodemodeProvider[]): CodemodeProvider[] {
  if (mode === 'build') return providers;
  return providers.map((provider) => {
    const tools: CodemodeProvider['tools'] = {};
    for (const [name, entry] of Object.entries(provider.tools)) {
      tools[name] = {
        ...entry,
        execute: (...args) => inWorkMode(mode, async () => {
          try {
            requireWorkModePermission(mode, entry.planAllowed === true, provider.name + '.' + name);
            return await entry.execute(...args);
          }
          catch (cause) {
            if (!(cause instanceof KinuError)) throw cause;
            return refusalOf(cause);
          }
        }),
      };
    }
    return { ...provider, tools };
  });
}

/** Bind SDK-delivered native calls to the mode of the admitted turn, not the SDK caller's async ancestry. */
export function toolsForInvocation(mode: WorkMode, tools: ToolSet): ToolSet {
  const permitted = toolsInWorkMode(mode, tools);
  const bound: ToolSet = {};
  for (const [name, entry] of Object.entries(permitted)) {
    const execute = entry.execute;
    bound[name] = execute === undefined ? entry : {
      ...entry,
      execute: (input, options) => runWorkModeInvocation(mode, () => execute(input, options)),
    };
  }
  return bound;
}
