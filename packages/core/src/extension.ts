/**
 * Public turn-extension seam fired by both backends: `runChat` (CLI) and the cf `OrchestratorAgent` Think hook bridge.
 * Hooks are optional and run in registration order.
 */

import type { ModelMessage, ToolSet } from 'ai';
import type { JsonObject } from './utils/json';
import { diagnostics, KinuError, toKinuError } from './obs/index';
import type { ToolOutcome } from './tools/outcome';

export interface TurnStartContext {
  readonly system: string;
  readonly history: readonly ModelMessage[];
}

export interface ToolCallContext {
  readonly toolName: string;
  readonly args: JsonObject;
  readonly toolCallId?: string;
}

export type ToolResultContext = ToolOutcome & ToolCallContext & {
  /** Full rendered content for display and repeat detection, never status evidence. */
  readonly result: string;
};

export interface TurnEndContext {
  readonly text: string;
  readonly responseMessages: readonly ModelMessage[];
}

export interface PrepareStepContext {
  readonly stepNumber: number;
  readonly messages: ModelMessage[];
  /** The host stops waiting on any hook once it fires. */
  readonly abortSignal?: AbortSignal;
}

/** Lets the awaited prepareStep path resume the chain where the synchronous walk stopped. */
interface PrepareStepResumption {
  /** The index after the hook that returned `first`. */
  readonly start: number;
  readonly ctx: PrepareStepContext;
  readonly messages: ModelMessage[];
  readonly changed: boolean;
  readonly first: Promise<ModelMessage[] | undefined>;
}

export interface TransformContext {
  /** The agent/DO name on cf, the session key on cli. */
  readonly sessionKey: string;
  /** Durable history only: before the turn-local tail and dynamic-context blocks. */
  readonly messages: readonly ModelMessage[];
  readonly system: string;
  readonly contextWindow: number;
  /** Previous turn's measured prompt tokens; preferred over chars/4 estimates. */
  readonly providerReportedTokens?: number;
  /** 'force': overflow recovery requires a rewrite before replay. */
  readonly trigger: 'auto' | 'force';
  readonly abortSignal?: AbortSignal;
}

export interface KinuExtension {
  /** Surfaced in errors such as tool-name collisions. */
  readonly name: string;
  onTurnStart?(ctx: TurnStartContext): void | Promise<void>;
  onToolCall?(ctx: ToolCallContext): void | Promise<void>;
  onToolResult?(ctx: ToolResultContext): void | Promise<void>;
  onTurnEnd?(ctx: TurnEndContext): void | Promise<void>;
  /** Per-step message rewrite, chained across extensions. Async is load-bearing: a persisted injection must land before the provider sees it. */
  prepareStep?(
    ctx: PrepareStepContext,
  ): ModelMessage[] | undefined | Promise<ModelMessage[] | undefined>;
  /** Once per turn assembly; chained, awaited, and fail-open (a throw is logged and skipped). */
  transformContext?(ctx: TransformContext): Promise<ModelMessage[] | undefined>;
  registerTools?(): ToolSet;
}

/** A hook that never settles must not hold the turn past its abort; the orphaned promise settles on its own. */
async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;

  const cancelled = (): KinuError =>
    new KinuError('cancelled', 'the turn was cancelled while an extension hook was running', { cause: signal.reason });

  if (signal.aborted) throw cancelled();
  let onAbort: (() => void) | undefined;

  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export class ExtensionHost {
  private readonly extensions: KinuExtension[] = [];

  register(ext: KinuExtension): this {
    this.extensions.push(ext);

    return this;
  }

  get size(): number {
    return this.extensions.length;
  }

  list(): readonly KinuExtension[] {
    return [...this.extensions];
  }

  /** Throws on a name collision so a plugin never silently shadows another's tool. */
  tools(): ToolSet {
    const merged: ToolSet = {};
    const owners = new Map<string, string>();

    for (const ext of this.extensions) {
      const contributed = ext.registerTools?.();

      if (!contributed) continue;

      for (const [name, tool] of Object.entries(contributed)) {
        const prior = owners.get(name);

        if (prior) {
          throw new Error(`extension "${ext.name}" registers tool "${name}" already registered by "${prior}"`);
        }

        owners.set(name, ext.name);
        merged[name] = tool;
      }
    }

    return merged;
  }

  /** Stays synchronous until a hook returns a Promise, which promotes only this invocation to the awaited path. */
  runPrepareStep(
    ctx: PrepareStepContext,
  ): ModelMessage[] | undefined | Promise<ModelMessage[] | undefined> {
    let messages = ctx.messages;
    let changed = false;

    for (let index = 0; index < this.extensions.length; index += 1) {
      const next = this.extensions[index]?.prepareStep?.({
        stepNumber: ctx.stepNumber,
        messages,
        abortSignal: ctx.abortSignal,
      });

      if (next instanceof Promise) {
        return this.continuePrepareStep({ start: index + 1, ctx, messages, changed, first: next });
      }

      if (next) {
        messages = next;
        changed = true;
      }
    }

    return changed ? messages : undefined;
  }

  private async continuePrepareStep(resume: PrepareStepResumption): Promise<ModelMessage[] | undefined> {
    const { ctx, messages } = resume;
    const firstResult = await untilAborted(resume.first, ctx.abortSignal);
    let current = firstResult ?? messages;
    let rewritten = resume.changed || firstResult !== undefined;

    for (let index = resume.start; index < this.extensions.length; index += 1) {
      const next = await untilAborted(Promise.resolve(this.extensions[index]?.prepareStep?.({
        stepNumber: ctx.stepNumber,
        messages: current,
        abortSignal: ctx.abortSignal,
      })), ctx.abortSignal);

      if (next) {
        current = next;
        rewritten = true;
      }
    }

    return rewritten ? current : undefined;
  }

  /** Fail-open: a throwing hook is recorded and skipped, except cancellation and oom, which propagate. */
  private async guardHook<T>(
    hook: string,
    extension: string,
    run: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    try {
      return await untilAborted(Promise.resolve(run()), signal);
    } catch (err) {
      const failure = toKinuError({ doing: `run an extension ${hook} hook`, cause: err, otherwise: 'io' });

      if (failure.code === 'cancelled' || failure.code === 'oom') throw failure;
      diagnostics.failure('extension.hook_failed', failure, { extension, hook });

      return undefined;
    }
  }

  async runTransformContext(ctx: TransformContext): Promise<ModelMessage[] | undefined> {
    let current: readonly ModelMessage[] = ctx.messages;
    let out: ModelMessage[] | undefined;

    for (const ext of this.extensions) {
      if (!ext.transformContext) continue;

      const next = await this.guardHook(
        'transformContext',
        ext.name,
        () => ext.transformContext?.({ ...ctx, messages: current }),
        ctx.abortSignal,
      );

      if (next) {
        out = next;
        current = next;
      }
    }

    return out;
  }

  async emitTurnStart(ctx: TurnStartContext): Promise<void> {
    for (const ext of this.extensions) {
      if (!ext.onTurnStart) continue;
      await this.guardHook('onTurnStart', ext.name, () => ext.onTurnStart?.(ctx));
    }
  }

  async emitToolCall(ctx: ToolCallContext): Promise<void> {
    for (const ext of this.extensions) {
      if (!ext.onToolCall) continue;
      await this.guardHook('onToolCall', ext.name, () => ext.onToolCall?.(ctx));
    }
  }

  async emitToolResult(ctx: ToolResultContext): Promise<void> {
    for (const ext of this.extensions) {
      if (!ext.onToolResult) continue;
      await this.guardHook('onToolResult', ext.name, () => ext.onToolResult?.(ctx));
    }
  }

  async emitTurnEnd(ctx: TurnEndContext): Promise<void> {
    for (const ext of this.extensions) {
      if (!ext.onTurnEnd) continue;
      await this.guardHook('onTurnEnd', ext.name, () => ext.onTurnEnd?.(ctx));
    }
  }

}
