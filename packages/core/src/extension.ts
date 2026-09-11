/**
 * Kinu extension seam — the small, stable public API for observing and
 * extending a turn without importing engine internals.
 *
 * This is the one hook path BOTH backends' turn loops fire: the shared chat
 * engine (`runChat` in chat.ts, the CLI path) and the cloud DO's Think hook
 * bridge (cf-backend `OrchestratorAgent` — beforeTurn/beforeStep/
 * beforeToolCall/afterToolCall/onChatResponse map onto this contract).
 * Plugin/host code registers a {@link KinuExtension} on an
 * {@link ExtensionHost}, and the engine drives every registered extension's
 * lifecycle hooks + folds its contributed tools into the single turn ToolSet.
 * Internal consumers (the CLI backend's steering drain) ride the SAME host, so
 * there is one mechanism, not a private hook plus a parallel plugin API.
 *
 * The surface is deliberately tiny — a seam, not a framework. Hooks are all
 * optional and run in registration order.
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
}

export type ToolResultContext = ToolOutcome & {
  readonly toolName: string;
  readonly args: JsonObject;
  /** Full rendered content for display and repeat detection, never status evidence. */
  readonly result: string;
};

export interface TurnEndContext {
  readonly text: string;
  readonly responseMessages: readonly ModelMessage[];
}

export interface PrepareStepContext {
  readonly stepNumber: number;
  /** The messages the SDK is about to send for this step. */
  readonly messages: ModelMessage[];
  /** The turn's cancellation. A hook that does I/O forwards it; the host stops
   *  waiting on any hook once it fires. */
  readonly abortSignal?: AbortSignal;
}

export interface TransformContext {
  /** Stable conversation identity — the agent/DO name on cf, the session key on cli. */
  readonly sessionKey: string;
  /** The durable history about to be sent, BEFORE the turn-local tail is
   *  spliced and before any dynamic-context block is woven — a transform never
   *  sees what is never persisted. */
  readonly messages: readonly ModelMessage[];
  /** The assembled system prompt for this turn. */
  readonly system: string;
  /** The resolved model's context window, in tokens. */
  readonly contextWindow: number;
  /** Provider-reported prompt tokens for the previous turn, when known —
   *  the measured trigger signal (chars/4 estimates lie). */
  readonly providerReportedTokens?: number;
  /** 'auto' = normal turn assembly; 'force' = overflow recovery demands a
   *  rewrite before the turn can be replayed. */
  readonly trigger: 'auto' | 'force';
  /** The turn's cancellation, as on {@link PrepareStepContext}. */
  readonly abortSignal?: AbortSignal;
}

/**
 * A unit of turn observation/extension. Every hook is optional. Implement only
 * what you need and register it on an {@link ExtensionHost}.
 */
export interface KinuExtension {
  /** Stable identifier — surfaced in errors (e.g. tool-name collisions). */
  readonly name: string;
  /** Fires once before the model is streamed. */
  onTurnStart?(ctx: TurnStartContext): void | Promise<void>;
  /** Fires as each tool call is emitted by the model. */
  onToolCall?(ctx: ToolCallContext): void | Promise<void>;
  /** Fires as each tool result comes back. */
  onToolResult?(ctx: ToolResultContext): void | Promise<void>;
  /** Fires once after the turn settles, with the final text + response messages. */
  onTurnEnd?(ctx: TurnEndContext): void | Promise<void>;
  /**
   * Message-transform hook at each step boundary: return a replacement message
   * array to rewrite what the model sees for that step (for example, a durable
   * mid-turn steer), or `undefined` to leave it unchanged. Chained across
   * extensions — each sees the prior extension's output. Async is load-bearing:
   * a persisted injection must land before the provider can receive it.
   */
  prepareStep?(
    ctx: PrepareStepContext,
  ): ModelMessage[] | undefined | Promise<ModelMessage[] | undefined>;
  /**
   * Async context-transform hook, fired ONCE per turn assembly before the
   * model streams (and before the turn-local tail is spliced).
   * Return a replacement history (e.g. a compacted one) or `undefined` to
   * leave it unchanged. Chained like {@link prepareStep}, but awaited — and
   * fail-open: a throwing transform is logged and skipped, never allowed to
   * break the turn.
   */
  transformContext?(ctx: TransformContext): Promise<ModelMessage[] | undefined>;
  /** Contribute tools into the turn's ToolSet. Called once at turn start. */
  registerTools?(): ToolSet;
}

/**
 * Aggregates registered extensions and drives their hooks. Held by a backend
 * for the life of a turn (or longer) and passed to `runChat`.
 */
/** Settle with the hook, or with the turn's cancellation, whichever comes
 *  first. A hook that never settles would otherwise hold the turn past its own
 *  abort; the orphaned promise is left to settle on its own. */
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

  /** Register an extension. Returns `this` for chaining. */
  register(ext: KinuExtension): this {
    this.extensions.push(ext);

    return this;
  }

  get size(): number {
    return this.extensions.length;
  }

  /** Merge every extension's contributed tools. Throws on a name collision so
   *  a plugin can never silently shadow another extension's tool. */
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

  /** Run every prepareStep hook in order, chaining outputs. The synchronous
   * fast path stays synchronous for extensions that need no I/O; the first
   * Promise promotes only that invocation to the awaited path. */
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
        return this.continuePrepareStep(index + 1, ctx, messages, changed, next);
      }

      if (next) {
        messages = next;
        changed = true;
      }
    }

    return changed ? messages : undefined;
  }

  private async continuePrepareStep(
    start: number,
    ctx: PrepareStepContext,
    messages: ModelMessage[],
    changed: boolean,
    first: Promise<ModelMessage[] | undefined>,
  ): Promise<ModelMessage[] | undefined> {
    const firstResult = await untilAborted(first, ctx.abortSignal);
    let current = firstResult ?? messages;
    let rewritten = changed || firstResult !== undefined;

    for (let index = start; index < this.extensions.length; index += 1) {
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

  /** Run one extension hook fail-open — a plugin must never break a turn. A
   *  throwing hook is recorded (which extension, which hook) and skipped, and
   *  the caller sees `undefined` as if the hook had stayed silent — except the
   *  caller's own abort and an out-of-memory kill, which are not the plugin's
   *  and propagate instead of reading as a silent skip. */
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

      // Every plugin failure is tolerated EXCEPT a cancelled turn and an oom:
      // neither is the plugin's fault, and swallowing the turn's own abort
      // (or a memory kill) as a silent skip would paper over it. A plain
      // Error classifies as io and stays fail-open.
      if (failure.code === 'cancelled' || failure.code === 'oom') throw failure;
      diagnostics.failure('extension.hook_failed', failure, { extension, hook });

      return undefined;
    }
  }

  /** Run every transformContext hook in registration order, chaining outputs
   *  (extension N sees extension N-1's rewritten history). Awaited, and
   *  fail-open per extension — a plugin must never break a turn. Returns the
   *  final rewritten messages, or `undefined` if no extension changed
   *  anything. */
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
