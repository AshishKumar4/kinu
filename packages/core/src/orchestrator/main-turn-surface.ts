/**
 * One agent's turn as its workspace prepared it (D9): the item its isolate admitted and how it opened, the operation
 * its tools run under, the external tools its eval reaches, and the ledgers its tools account into. AgentTurns holds it
 * with the rest of the turn, so a turn's surface ends with the turn; the agent's tools read the one their call runs
 * under, and a read outside any call reads the one the agent's chat holds now. The turn's canonical accounting is the
 * agent's own, in its isolate; these ledgers only serve the calls that run here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';
import type { ActorReference } from '../identity/actor-handle';
import { captureOperationProfile, type OperationProfile } from '../profiles/operation';
import type { ProfileAuthorityInputs, ResolvedTurnProfile } from '../profiles/resolve';
import { TurnFileLedger } from '../vfs/file-ledger';
import { TurnContextBudget } from '../context-budget';
import { TurnEscalationLedger } from '../execution/escalation';
import type { TurnContinuity } from './evolution-lanes';
import type { ExecutionKey } from './execution';
import type { ChatTurnInput } from './chat-session';

export interface TurnSurfaceOpening {
  /** The execution it serves: its claims, receipts and operation key on it. */
  readonly key: ExecutionKey;
  readonly actor: ActorReference;
  readonly item: ChatTurnInput;
  readonly continuity: TurnContinuity;
  /** Whether the turn records evolution, decided as it opens: a live read could answer a recovering host otherwise. */
  readonly evolutionEnabled: boolean;
}

/** What a turn's tools account into while they run here: the files it read, its context budget, its escalations. */
export interface TurnLedgers {
  readonly files: TurnFileLedger;
  readonly context: TurnContextBudget;
  readonly escalations: TurnEscalationLedger;
}

/** Empty ledgers: a turn's own, or a call's outside any turn. */
export function turnLedgers(): TurnLedgers {
  return { files: new TurnFileLedger(), context: new TurnContextBudget(), escalations: new TurnEscalationLedger() };
}

export class TurnSurface {
  readonly key: ExecutionKey;
  readonly item: ChatTurnInput;
  readonly continuity: TurnContinuity;
  readonly evolutionEnabled: boolean;
  readonly ledgers = turnLedgers();
  readonly #actor: ActorReference;
  #external: ToolSet = {};
  #operation: OperationProfile | null = null;
  #declared: ToolSet = {};

  constructor(opening: TurnSurfaceOpening) {
    this.key = opening.key;
    this.item = opening.item;
    this.continuity = opening.continuity;
    this.evolutionEnabled = opening.evolutionEnabled;
    this.#actor = opening.actor;
  }

  /** Null until the turn's reads resolved a profile. */
  get operation(): OperationProfile | null {
    return this.#operation;
  }

  /** Every external tool the turn read, whether or not its eval reaches it: its isolate's profile admits them by name. */
  get external(): ToolSet {
    return this.#external;
  }

  /** The external tools the turn's eval declares and reaches. */
  get declared(): ToolSet {
    return this.#declared;
  }

  /** The turn's external tools were read: its eval declares and reaches `declared` of them until its profile is bound. */
  reached(external: ToolSet, declared: ToolSet): void {
    this.#external = external;
    this.#declared = declared;
  }

  /** The turn's reads resolved a profile: its tools run under it until the agent's isolate binds the one it assembled on. */
  resolved(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): void {
    this.#operation = this.#capture(profile, inputs);
  }

  /** The profile the agent's isolate assembled the turn on: its tools run under it, and its eval reaches what it allows. */
  bind(profile: ResolvedTurnProfile): void {
    // Bound under the inputs it resolved with (`resolved`), which its operation holds.
    const inputs = this.#operation?.inputs ?? null;

    if (inputs === null) return;
    const allowed = new Set(profile.allowedTools);

    this.#operation = this.#capture(profile, inputs);
    this.#declared = allowed.has('eval') ? Object.fromEntries(Object.entries(this.#external).filter(([name]) => allowed.has(name))) : {};
  }

  #capture(profile: ResolvedTurnProfile, inputs: ProfileAuthorityInputs): OperationProfile {
    return captureOperationProfile({ actor: this.#actor, profile, inputs, runId: this.key.runId, turnId: this.key.turnId });
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
