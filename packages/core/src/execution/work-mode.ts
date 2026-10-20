import { Effect } from 'effect';
import { settle, settleSync } from '../obs/effect';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { WorkMode } from '../types/turn';
import { KinuError, refusalOf, type Refusal } from '../obs/error';

import type { CodemodeProvider } from '../types/codemode';
import { JsonValueSchema, type JsonValue } from '../utils/json';

const invocationMode = new AsyncLocalStorage<WorkMode>();

/** The operations Plan refused inside one call behind a boundary (`toolsBehindBoundary`). */
const boundaryRefusals = new AsyncLocalStorage<string[]>();

const PlanPermission = v.object({ planAllowed: v.literal(true) });

/** The mode messages merged into one turn run under: Plan where any was typed under it, as merging never widens what a
 *  message was typed under. */
export function narrowestMode(modes: readonly (WorkMode | undefined)[]): WorkMode {
  return modes.includes('plan') ? 'plan' : 'build';
}

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

/** Trusted queue, durable job, or admitted turn starts independent work; authority is not inherited. */
export function runWorkModeInvocation<Result>(mode: WorkMode, operation: () => Result): Result {
  return invocationMode.run(mode, operation);
}

/** The producer declares this operation safe for Plan; nothing infers it from its name. */
export function permitInPlan<Operation extends ToolSet[string]>(operation: Operation): Operation & { planAllowed: true } {
  const permission = { planAllowed: true } satisfies { planAllowed: true };

  return Object.assign(operation, permission);
}

export function workModeRefusal(mode: WorkMode, planAllowed: boolean, operation: string): Refusal | null {
  if ((mode === 'plan' || currentWorkMode() === 'plan') && !planAllowed) {
    boundaryRefusals.getStore()?.push(operation);

    return refusalOf(new KinuError('denied', operation + ' has no Plan-safe execution capability'));
  }

  return null;
}

export function requireWorkModePermission(mode: WorkMode, planAllowed: boolean, operation: string): void {
  return settleSync(Effect.gen(function* () {
    const refusal = workModeRefusal(mode, planAllowed, operation);

    if (refusal !== null) return yield* new KinuError(refusal.reason, refusal.error);
  }));
}

export function requireBuild(operation: string): void {
  requireWorkModePermission(currentWorkMode(), false, operation);
}

/** What a prompt may tell a turn in `mode` to call: Plan names only the tools it permits. */
export function callableToolNames(mode: WorkMode, tools: ToolSet): string[] {
  return Object.entries(tools).filter(([name, entry]) => workModeRefusal(mode, hasPlanPermission(entry), name) === null).map(([name]) => name);
}

/** Native tools retain their declared input schema; only their authority is narrowed. */
export function toolsInWorkMode(mode: WorkMode, tools: ToolSet): ToolSet {
  if (mode === 'build') return tools;
  const narrowed: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    const permitted = hasPlanPermission(entry);

    // A tool with no executor runs nothing, so only whether Plan offers it is decided here.
    if (execute === undefined) {
      if (permitted) narrowed[name] = entry;
      continue;
    }

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

/** What a measured turn's calls meet instead of the world (docs/TOOLS.md, "The inert boundary"). */
export interface ToolBoundary {
  /** A call kept from running: its tool, its input as the model wrote it, and each operation Plan refused in it. */
  readonly intended: (call: { readonly name: string; readonly input: JsonValue; readonly refused: readonly string[] }) => void;
  /** A kept call's answer from a record of the same call, where one exists; null where none does. */
  readonly recorded?: (name: string, input: JsonValue) => string | null;
}

/** What a kept call answers when no record of it exists. */
const NOT_RUN = 'Not run: this turn is measured, and the call is kept as what you meant to do.';

/**
 * Each tool runs as Plan would run it, inside a turn that stays Build: what Plan permits (reads, research, the agent's
 * own memory) runs, and any call in which Plan refused an operation is kept from running, recorded as intended, and
 * answered from its record or with `NOT_RUN`. Plan's own classification decides, so no second list of safe calls exists.
 */
export function toolsBehindBoundary(tools: ToolSet, boundary: ToolBoundary): ToolSet {
  // Plan's own narrowing: each call checked against its tool's permission, inside a Plan invocation.
  const planned = toolsInWorkMode('plan', tools);
  const kept: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) {
    const execute = planned[name]?.execute;

    // A tool with no executor runs nothing: it stays as declared.
    if (execute === undefined) {
      kept[name] = entry;
      continue;
    }

    kept[name] = {
      ...entry,
      execute: async (input, options) => {
        const refused: string[] = [];

        // A refusal Plan threw is the boundary's to answer; anything else is the call's own failure.
        const ran = await boundaryRefusals.run(refused, () => settle(Effect.tryPromise({
          try: async () => ({ result: await execute(input, options) }),
          catch: (cause) => ({ cause }),
        }).pipe(Effect.catch((failed) => (refused.length > 0 ? Effect.succeed(null) : Effect.die(failed.cause))))));

        if (refused.length === 0 && ran !== null) return ran.result;
        const written = v.safeParse(JsonValueSchema, input);
        boundary.intended({ name, input: written.success ? written.output : null, refused });

        return boundary.recorded?.(name, written.success ? written.output : null) ?? NOT_RUN;
      },
    };
  }

  return kept;
}

/** Every introduced host operation is checked; unclassified producers stay closed in Plan. */
export function providersInWorkMode(mode: WorkMode, providers: CodemodeProvider[]): CodemodeProvider[] {
  if (mode === 'build') return providers;

  return providers.map((provider) => {
    const tools: CodemodeProvider['tools'] = {};

    for (const [name, entry] of Object.entries(provider.tools)) {
      tools[name] = {
        ...entry,
        execute: (...args) => inWorkMode(mode, () => settle(Effect.tryPromise({
          try: async () => {
            requireWorkModePermission(mode, entry.planAllowed === true, provider.name + '.' + name);

            return await entry.execute(...args);
          },
          catch: (cause) => ({ cause }),
        }).pipe(Effect.catch((failed) => (failed.cause instanceof KinuError ? Effect.succeed(refusalOf(failed.cause)) : Effect.die(failed.cause)))))),
      };
    }

    return { ...provider, tools };
  });
}

/** Bind SDK-delivered native calls to the mode of the admitted turn, not the SDK caller's async ancestry. */
export function toolsForInvocation(mode: WorkMode, tools: ToolSet): ToolSet {
  const bound: ToolSet = {};

  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    bound[name] = execute === undefined ? entry : {
      ...entry,
      execute: (input, options) => runWorkModeInvocation(mode, () => execute(input, options)),
    };
  }

  return bound;
}
