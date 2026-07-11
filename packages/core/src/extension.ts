/**
 * Proteus extension seam — the small, stable public API for observing and
 * extending a turn without importing engine internals.
 *
 * This is the one hook path the turn loop fires (see `runChat` in chat.ts):
 * plugin/host code registers a {@link ProteusExtension} on an
 * {@link ExtensionHost}, and the engine drives every registered extension's
 * lifecycle hooks + folds its contributed tools into the single turn ToolSet.
 * Internal consumers (the CLI backend's steering drain) ride the SAME host, so
 * there is one mechanism, not a private hook plus a parallel plugin API.
 *
 * The surface is deliberately tiny — a seam, not a framework. Hooks are all
 * optional and run in registration order.
 */

import type { ModelMessage, ToolSet } from 'ai';

export interface TurnStartContext {
  readonly system: string;
  readonly history: readonly ModelMessage[];
}

export interface ToolCallContext {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

export interface ToolResultContext {
  readonly toolName: string;
  readonly result: string;
}

export interface TurnEndContext {
  readonly text: string;
  readonly responseMessages: readonly ModelMessage[];
}

export interface PrepareStepContext {
  readonly stepNumber: number;
  /** The messages the SDK is about to send for this step. */
  readonly messages: ModelMessage[];
}

/**
 * A unit of turn observation/extension. Every hook is optional. Implement only
 * what you need and register it on an {@link ExtensionHost}.
 */
export interface ProteusExtension {
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
   * array to rewrite what the model sees for that step (e.g. drain mid-turn
   * steering), or `undefined` to leave it unchanged. Chained across extensions
   * — each sees the prior extension's output.
   */
  prepareStep?(ctx: PrepareStepContext): ModelMessage[] | undefined;
  /** Contribute tools into the turn's ToolSet. Called once at turn start. */
  registerTools?(): ToolSet;
}

/**
 * Aggregates registered extensions and drives their hooks. Held by a backend
 * for the life of a turn (or longer) and passed to `runChat`.
 */
export class ExtensionHost {
  private readonly extensions: ProteusExtension[] = [];

  /** Register an extension. Returns `this` for chaining. */
  register(ext: ProteusExtension): this {
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

  /** Run every prepareStep hook in order, chaining outputs. Returns the final
   *  rewritten messages, or `undefined` if no extension changed anything. */
  runPrepareStep(ctx: PrepareStepContext): ModelMessage[] | undefined {
    let messages = ctx.messages;
    let changed = false;
    for (const ext of this.extensions) {
      const next = ext.prepareStep?.({ stepNumber: ctx.stepNumber, messages });
      if (next) {
        messages = next;
        changed = true;
      }
    }
    return changed ? messages : undefined;
  }

  async emitTurnStart(ctx: TurnStartContext): Promise<void> {
    for (const ext of this.extensions) await ext.onTurnStart?.(ctx);
  }

  async emitToolCall(ctx: ToolCallContext): Promise<void> {
    for (const ext of this.extensions) await ext.onToolCall?.(ctx);
  }

  async emitToolResult(ctx: ToolResultContext): Promise<void> {
    for (const ext of this.extensions) await ext.onToolResult?.(ctx);
  }

  async emitTurnEnd(ctx: TurnEndContext): Promise<void> {
    for (const ext of this.extensions) await ext.onTurnEnd?.(ctx);
  }
}
