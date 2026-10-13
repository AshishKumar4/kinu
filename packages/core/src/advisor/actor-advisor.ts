/**
 * One agent's advisor: whether its turns are reviewed, the hire that reviews one, and the answers judged and said. A
 * turn's session composes it; a host whose agent's turns run elsewhere builds it alone, over the same ports.
 */
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { Effect } from 'effect';
import { attempt, diagnostics, settle, type KinuError } from '../obs/index';
import type { AgentConfigStore } from '../config/store';
import type { EvolutionEngine } from '../evolution/engine';
import type { CompletedTurn } from '../evolution/types';
import type { AnsweredEvolutionHelper } from '../identity/evolution-helpers';
import type { ActorHandle } from '../identity/actor-handle';
import { resolveModelRoute } from '../profiles/model-route';
import type { ResolvedTurnProfile } from '../profiles/resolve';
import { advisorWorkspaceGuidance } from '../prompting/agents-md';
import { modelWindow } from '../context-window';
import type { TemporaryAgentPort } from '../types/subordinates';
import type { AgentSignal, SendOutcome } from '../types/signals';
import {
  ADVISOR_ROLE_ID, advisedTurnOf, advisorLane, buildAdvisorPrompt, judgeAdvisorReply, sayAdvisorNote,
  type AdvisorNote, type AdvisorRecoverySnapshot,
} from './review';

/** A hosted actor shares workspace priorities, but delivers feedback to itself. */
export interface ActorAdvisorContext {
  readonly config: AgentConfigStore;
  readonly workspace: () => Promise<VFS>;
  readonly parent: (signal: AgentSignal) => Promise<SendOutcome>;
}

export interface ActorAdvisorDeps {
  readonly actor: ActorHandle;
  /** Where its own priorities are read when it shares none: its state plane, else its files. */
  readonly vfs: () => VFS;
  /** Its advisor notes, recorded once per judged turn; read only by a hire and a judgement. */
  readonly notes: () => Pick<EvolutionEngine, 'recentAdvisorNotes' | 'recordAdvisorNote' | 'hasAdvisorNoteForTurn' | 'advisorNoteForTurn'>;
  /** The port its advisor is hired through; null or absent, its turns are not reviewed. */
  readonly port?: () => TemporaryAgentPort | null;
  /** The profile's `input`: an actor that takes no input (a swarm node, an evolution agent) is not reviewed. */
  readonly reviewed?: boolean;
  readonly context?: ActorAdvisorContext;
  /** The completion gate has asked and not heard back, when the host keeps one. */
  readonly gateOpen?: () => boolean;
  /** Where a note it says to itself goes: its deliveries. */
  readonly send: (signal: AgentSignal) => Promise<SendOutcome>;
  /** The profile the agent runs on now; null between turns. */
  readonly profile: () => ResolvedTurnProfile | null;
  /** The turn as recorded, its mission scope stamped. */
  readonly scoped: (turn: CompletedTurn) => CompletedTurn;
}

function deliveryFailed(turnId: string): (failure: KinuError) => Effect.Effect<boolean> {
  return (failure) => Effect.sync(() => {
    diagnostics.failure('advisor.delivery_failed', failure, { turnId });

    return false;
  });
}

export class ActorAdvisor {
  /** Notes handed to the conversation and not yet said, by the helper that answered them. */
  private readonly delivering = new Map<string, Promise<void>>();

  constructor(private readonly deps: ActorAdvisorDeps) {}

  get enabled(): boolean {
    return (this.deps.context?.config ?? this.deps.actor.config).getAdvisorEnabled();
  }

  /** Off by default: the owner's switch, a reviewed profile and a port to hire the advisor through all decide. */
  get reviewsTurns(): boolean {
    return this.deps.reviewed !== false && this.enabled && (this.deps.port?.() ?? null) !== null;
  }

  snapshot(turn: CompletedTurn, reachable: readonly string[]): AdvisorRecoverySnapshot {
    const profile = this.deps.profile();

    return {
      turn: this.deps.scoped(turn),
      reachable: [...reachable],
      model: profile === null || !this.enabled ? undefined : resolveModelRoute('advisor', profile).model,
    };
  }

  /**
   * Hires the turn's advisor, an evolution agent under the advisor preset, and returns: its answer reaches
   * {@link deliverAnswers} through the ingress. Idempotent per turn, so a replay hires no second one.
   */
  async hire(snapshot: AdvisorRecoverySnapshot): Promise<void> {
    const port = this.deps.port?.() ?? null;
    const turnId = snapshot.turn.turnId;

    // No durable id, no lane to answer on.
    if (!this.reviewsTurns || port === null || turnId === undefined || turnId === '') return;

    if (this.deps.notes().hasAdvisorNoteForTurn(turnId) || port.reclaim(advisorLane(turnId)) !== null) return;

    const task = buildAdvisorPrompt(snapshot.turn, snapshot.reachable, await this.guidance());
    const hired = await port.start({ role: ADVISOR_ROLE_ID, roleLabel: ADVISOR_ROLE_ID, task, mode: 'build', lane: advisorLane(turnId) });

    if (hired.status === 'failed') diagnostics.event('advisor.hire_failed', { turnId, reason: hired.reason ?? 'unknown' });
  }

  /** Settles once every note handed to the conversation is said, or failed and kept for the next pass. */
  deliveries(): Promise<void> {
    return Promise.allSettled(this.delivering.values()).then(() => undefined);
  }

  /**
   * Every advisor answer this actor holds, judged once and said at most once; per-turn feedback never changes the
   * learning window. A note to be said is handed to the conversation and not awaited: the turn it opens runs as long
   * as it runs, and the answer is forgotten only once it is said. False while any answer is still held. `deliver`
   * says it where the actor's notes live, true once said: an agent in its own isolate says it there.
   */
  async deliverAnswers(deliver?: (helper: AnsweredEvolutionHelper, turnId: string) => Promise<boolean>): Promise<boolean> {
    const port = this.deps.port?.() ?? null;

    if (port === null) return true;
    let settled = true;

    for (const helper of port.answered()) {
      const turnId = advisedTurnOf(helper.lane);

      if (turnId === null) continue;

      if (deliver === undefined) {
        if (!await this.deliverAnswer(port, helper, turnId)) settled = false;
      } else if (await deliver(helper, turnId)) {
        port.forget(helper.name);
      } else {
        settled = false;
      }
    }

    return settled;
  }

  /** True once the answer is forgotten. */
  deliverAnswer(port: TemporaryAgentPort, helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean> {
    if (this.delivering.has(helper.name)) return Promise.resolve(false);

    return settle(attempt({ doing: `judging the advisor's review of turn ${turnId}`, otherwise: 'unavailable' }, async () => {
      const judged = helper.status === 'completed' ? this.judged(helper.answer, turnId) : null;

      if (judged === null || !judged.spoken) {
        port.forget(helper.name);

        return true;
      }

      // Settles once the note is said and its answer forgotten, or failed and kept for the next pass.
      this.delivering.set(helper.name, this.say(judged.note, turnId)
        .then((said) => { if (said) port.forget(helper.name); })
        .finally(() => { this.delivering.delete(helper.name); }));

      return false;
    }).pipe(Effect.catch(deliveryFailed(turnId))));
  }

  /** The note judged for the turn, recorded by its first judgement; a pass after a cut delivery reads it back. */
  private judged(answer: string, turnId: string): { readonly note: AdvisorNote; readonly spoken: boolean } | null {
    const notes = this.deps.notes();
    const recorded = notes.advisorNoteForTurn(turnId);

    if (recorded !== null) return recorded;

    const judged = judgeAdvisorReply(answer, {
      turnId,
      minSeverity: (this.deps.context?.config ?? this.deps.actor.config).getAdvisorMinSeverity(),
      recent: [...notes.recentAdvisorNotes()],
      gateOpen: this.deps.gateOpen?.() ?? false,
      record: (note, id, spoken) => { notes.recordAdvisorNote(note, id, spoken); },
    });

    return judged === null || judged.disposition === 'drop' ? null : { note: judged.note, spoken: judged.disposition === 'deliver' };
  }

  /** The answer judged and, if it speaks, said here; true once nothing of it is owed. */
  async sayAnswer(helper: AnsweredEvolutionHelper, turnId: string): Promise<boolean> {
    const judged = helper.status === 'completed' ? this.judged(helper.answer, turnId) : null;

    return judged === null || !judged.spoken || await this.say(judged.note, turnId);
  }

  say(note: AdvisorNote, turnId: string): Promise<boolean> {
    return settle(attempt({ doing: `saying the advisor's note on turn ${turnId}`, otherwise: 'unavailable' }, async () => {
      const sent = await sayAdvisorNote(note, {
        turnId,
        send: (signal) => this.deps.send(signal),
        ...(this.deps.context !== undefined && { actor: this.deps.actor, parent: this.deps.context.parent }),
      });

      // A signal the host could not take stays owed for the next pass.
      return sent === 'queued' || sent === 'mid-turn';
    }).pipe(Effect.catch(deliveryFailed(turnId))));
  }

  private async guidance(): Promise<string> {
    const workspace = await this.deps.context?.workspace() ?? this.deps.vfs();

    return await advisorWorkspaceGuidance({ vfs: workspace, limits: async () => modelWindow(null) });
  }
}
