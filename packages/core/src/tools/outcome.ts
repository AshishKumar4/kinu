import { AsyncLocalStorage } from 'node:async_hooks';
import { Data, Effect } from 'effect';
import * as v from 'valibot';
import { KinuError, renderThrownChain, classifyErrorCode, settle } from '../obs/index';
import { FileRefusalError } from '../types/file-edits';
import { BindingFailureSchema, ToolFailureValueSchema, type BindingFailure, type ToolOutcome } from '../types/tool-outcome';
import type { JsonValue } from '../utils/json';

export { ToolOutcomeSchema, type ToolOutcome } from '../types/tool-outcome';

/** Read only producer-owned error metadata; output and diagnostic wording are not status. */
export function failedToolOutcome(input: Parameters<typeof renderThrownChain>[0]): Extract<ToolOutcome, { success: false }> {
  const outcome: Extract<ToolOutcome, { success: false }> = { success: false, reason: null };
  const seen = new Set<Error>();
  let error = input.cause;

  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);

    if (error instanceof CodemodeProgramError) return error.outcome;

    if (error instanceof KinuError) {
      outcome.reason ??= error instanceof FileRefusalError ? error.verdict : error.code;

      if (error.execution !== undefined) outcome.execution ??= error.execution;
    }

    error = error.cause;
  }

  const propagated = v.safeParse(ToolFailureValueSchema, error);

  if (propagated.success) return propagated.output;
  outcome.reason ??= classifyErrorCode(input);

  return outcome;
}

/** A namespace call returns typed operation refusals for authored code to handle. */
export function branchableToolCall<Result>(call: () => Promise<Result>) {
  return settle(Effect.tryPromise({ try: call, catch: (cause) => ({ cause }) }).pipe(
    Effect.catch((failed) => Effect.succeed({ ...failedToolOutcome(failed), error: renderThrownChain(failed) })),
  ));
}

interface ProgramInvocation {
  failures: BindingFailure[];
  pending: Promise<JsonValue | undefined>[];
}

const program = new AsyncLocalStorage<ProgramInvocation>();

const ProgramFailuresSchema = v.object({ failures: v.array(BindingFailureSchema) });

/** Only eval produces this outer envelope; authored return data is nested under result. */
export function successfulToolOutcome(name: string, result: { output: unknown }): Extract<ToolOutcome, { success: true }> {
  const parsed = name === 'eval' ? v.safeParse(ProgramFailuresSchema, result.output) : null;

  return parsed?.success ? { success: true, failures: parsed.output.failures } : { success: true };
}

class CodemodeProgramError extends Data.TaggedError('CodemodeProgramError')<{ readonly message: string; readonly cause?: unknown }> {
  constructor(readonly outcome: Extract<ToolOutcome, { success: false }>, message: string, options?: ErrorOptions) {
    super({ message, ...(options?.cause !== undefined && { cause: options.cause }) });
  }
}

/** Capture the invocation before crossing RPC, whose callback has no caller async context. */
export function bindProgramCall<Args extends unknown[]>(
  binding: { tool: string; action: string | null },
  invoke: (...args: Args) => Promise<JsonValue | undefined>,
  returnedRefusals = false,
): (...args: Args) => Promise<JsonValue | undefined> {
  const active = program.getStore();

  return (...args) => {
    const call = branchableToolCall(() => invoke(...args)).then((value) => {
      const parsed = v.safeParse(ToolFailureValueSchema, value);

      const legacy = returnedRefusals && !parsed.success
        ? v.safeParse(v.object({ ...ToolFailureValueSchema.entries, success: v.optional(v.literal(false), false) }), value)
        : null;

      const strict = parsed.success ? parsed.output : null;
      const recovered = legacy?.success === true ? legacy.output : null;
      const failure = strict ?? recovered;

      if (failure === null) return value;
      const input = v.safeParse(v.object({ action: v.string() }), args[0]);
      const action = binding.action ?? (binding.tool !== 'shell' && input.success ? input.output.action : null);
      active?.failures.push({ ...failure, tool: binding.tool, action });

      return failure;
    });

    active?.pending.push(call);

    return call;
  };
}

/** Program recovery is success; returning or throwing a binding refusal propagates it. */
export async function withCodemodeProgram<Result extends { result?: unknown; logs?: string[] }>(
  invoke: () => Promise<Result>,
): Promise<Result & { failures?: BindingFailure[] }> {
  if (program.getStore() !== undefined) return invoke();
  const active: ProgramInvocation = { failures: [], pending: [] };

  const settled = Effect.promise(() => Promise.all(active.pending));

  return program.run(active, () => settle(Effect.gen(function* () {
    const result = yield* Effect.tryPromise({ try: invoke, catch: (cause) => ({ cause }) }).pipe(
      Effect.catch((failed) => Effect.flatMap(settled, () => {
        const cause = failed.cause;

        if (active.failures.length === 0) return Effect.die(cause);
        const propagated = v.safeParse(ToolFailureValueSchema, cause);
        const outcome = propagated.success ? propagated.output : failedToolOutcome({ cause });

        return Effect.die(new CodemodeProgramError({ ...outcome, failures: active.failures },
          JSON.stringify({ ...outcome, error: renderThrownChain({ cause }), failures: active.failures }), { cause }));
      })),
    );

    yield* settled;
    const propagated = v.safeParse(ToolFailureValueSchema, result.result);

    if (propagated.success && active.failures.some((failure) => failure.reason === propagated.output.reason && failure.error === propagated.output.error)) {
      const outcome = { ...propagated.output, failures: active.failures };

      return yield* Effect.die(new CodemodeProgramError(outcome, JSON.stringify({ ...result, ...outcome })));
    }

    const answered: Result & { failures?: BindingFailure[] } = active.failures.length === 0 ? result : { ...result, failures: active.failures };

    return answered;
  })));
}
