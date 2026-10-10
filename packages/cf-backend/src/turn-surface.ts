/**
 * One of main's turns as this workspace prepared it (D9): the item its isolate admitted and how it opened, the operation
 * its tools run under, the external tools its eval reaches, and the reply its owner's sent-back review awaits. AgentTurns
 * holds it with the rest of the turn, so a turn's surface ends with the turn; main's tools read the one their call runs
 * under, and a read outside any call reads the one main's chat holds now.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';
import {
  captureOperationProfile,
  type ActorReference, type ChatTurnInput, type OperationProfile, type ProfileAuthorityInputs, type ReplyToCommentToolDeps,
  type ResolvedTurnProfile, type TurnContinuity,
} from '@kinu.run/core';

export interface TurnSurfaceOpening {
  readonly turnId: string;
  readonly actor: ActorReference;
  readonly item: ChatTurnInput;
  readonly continuity: TurnContinuity;
  /** Whether the turn records evolution, decided as it opens: a live read could answer a recovering host otherwise. */
  readonly evolutionEnabled: boolean;
  readonly planReply: ReplyToCommentToolDeps | undefined;
}

export class TurnSurface {
  readonly turnId: string;
  readonly item: ChatTurnInput;
  readonly continuity: TurnContinuity;
  readonly evolutionEnabled: boolean;
  readonly planReply: ReplyToCommentToolDeps | undefined;
  readonly #actor: ActorReference;
  #reach: { readonly inputs: ProfileAuthorityInputs; readonly external: ToolSet } | null = null;
  #operation: OperationProfile | null = null;
  #declared: ToolSet = {};

  constructor(opening: TurnSurfaceOpening) {
    this.turnId = opening.turnId;
    this.item = opening.item;
    this.continuity = opening.continuity;
    this.evolutionEnabled = opening.evolutionEnabled;
    this.planReply = opening.planReply;
    this.#actor = opening.actor;
  }

  /** Null until the turn's reads resolved a profile. */
  get operation(): OperationProfile | null {
    return this.#operation;
  }

  /** The external tools the turn's eval declares and reaches. */
  get declared(): ToolSet {
    return this.#declared;
  }

  /** The turn's reads resolved: its tools run under `profile` until main's isolate binds the one it assembled on. */
  resolved(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs, external: ToolSet, declared: ToolSet): void {
    this.#reach = { inputs, external };
    this.#operation = this.#capture(profile, inputs);
    this.#declared = declared;
  }

  /** The profile main's isolate assembled the turn on: its tools run under it, and its eval reaches what it allows. */
  bind(profile: ResolvedTurnProfile): void {
    if (this.#reach === null) return;
    const allowed = new Set(profile.allowedTools);

    this.#operation = this.#capture(profile, this.#reach.inputs);
    this.#declared = allowed.has('eval') ? Object.fromEntries(Object.entries(this.#reach.external).filter(([name]) => allowed.has(name))) : {};
  }

  #capture(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): OperationProfile {
    return captureOperationProfile({ actor: this.#actor, profile, inputs, runId: this.turnId, turnId: this.turnId });
  }
}

const scope = new AsyncLocalStorage<TurnSurface>();

/** `run` and everything it awaits read `surface` as their turn's. */
export function inTurnSurface<A>(surface: TurnSurface, run: () => A): A {
  return scope.run(surface, run);
}

/** The surface the running call was given, if any. */
export function scopedTurnSurface(): TurnSurface | null {
  return scope.getStore() ?? null;
}
