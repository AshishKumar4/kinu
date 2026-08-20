/**
 * Kinu extension seam — the small, stable public API for observing and
 * extending a turn without importing engine internals.
 *
 * This is the one hook path BOTH backends' turn loops fire: the shared chat
 * engine (`runChat` in chat.ts, the CLI path) and the cloud DO's Think hook
 * bridge (cf-backend `OrchestratorAgent` — beforeTurn/beforeStep/
 * beforeToolCall/afterToolCall/onChatResponse map onto this contract).
 * Plugin/host code registers a {@link ProteusExtension} on an
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
import { diagnostics, toProteusError } from './obs/index';

export interface TurnStartContext {
  readonly system: string;
  readonly history: readonly ModelMessage[];
}

export interface ToolCallContext {
  readonly toolName: string;
  readonly args: JsonObject;
}

export interface ToolResultContext {
  readonly toolName: string;
  /** The call's own input, carried through so a consumer can tell one call of
   *  a tool from another without re-pairing on ids (the repeat detector in
   *  orchestrator/turn-steering.ts). Both backends have it at result time. */
  readonly args: JsonObject;
  /** The call's full rendered output — never a slice. Consumers key on it
   *  (the repeat detector hashes it as the call's identity) and read it for
   *  failure shapes that can sit anywhere in the text, both of which a head
   *  slice silently breaks. Bound it at your own render if you display it;
   *  `evidenceWindow` keeps both ends and names what it dropped. */
  readonly result: string;
  /** How the call settled. A tool that catches its own failure and RETURNS it
   *  (the `run` tool's `Error (exit N)`) still reports success here, so a
   *  consumer that cares about failure reads the text too — see
   *  isFailingToolResult in orchestrator/turn-steering.ts. */
  readonly success: boolean;
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
      try {
        const next = await ext.transformContext({ ...ctx, messages: current });
        if (next) {
          out = next;
          current = next;
        }
      } catch (err) {
        diagnostics.failure(
          'extension.transform_context_failed',
          toProteusError({ doing: 'run an extension transformContext hook', cause: err, otherwise: 'io' }),
          { extension: ext.name },
        );
      }
    }
    return out;
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
