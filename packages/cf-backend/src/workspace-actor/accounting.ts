import {
  activeOperationProfile, currentOperationProfile, isAccountName, priceCall, pricedModelCallEvent, recordModelOperations,
  specProvider, splitSpec, WORKERS_AI_PROVIDER_ID, WORKSPACE_RUN_ID, type BoundActor, type ModelAttemptInfo, type ModelCallReport,
  type ModelCatalogSession, type ModelOperationSink, type ProviderWaitInfo, type RunEventRecorder, type Usage,
  type UserCaller,
} from '@kinu.run/core';
import { recordModelRow } from '@kinu.run/core/analytics';
import { attemptInItsWords, diagnostics, settleLogged, settleLoggedSync, type KinuError } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { UserHubClient } from '../account-reads';
import type { ProvidersLane } from '../owned-model-services';
import type { WorkspaceActorContext } from './context';

/** Named contract so the analytics writer and the actor agree which half is the provider. */
export interface ModelDimensions {
  readonly provider: string;
  readonly model: string;
}

/** No model resolved. Empty rather than a plausible default, so unknowns are not misattributed. */
const UNRESOLVED_MODEL: ModelDimensions = { provider: '', model: '' };

/** The owner's limits an actor asks, by the event an ask that could not reach them is logged as. */
const LIMITS_UNASKED = { turn: 'limits.turn_unasked', bytes: 'limits.bytes_unasked' } as const;

interface ProviderLog {
  readonly recorder: RunEventRecorder;
  runId(): string;
}

export interface WorkspaceAccountingDeps {
  readonly context: WorkspaceActorContext;
  readonly events: () => RunEventRecorder;
  readonly catalog: ModelCatalogSession;
  readonly env: Env;
  /** The model the workspace agent runs on, standing in where a report names none. */
  readonly effectiveSpec: () => string;
  /** The object's own SQLite size, the platform's number. */
  readonly databaseSize: () => number;
}

/**
 * What the workspace's model calls spend and its storage holds, told to the owner's limits (core limits/) and recorded
 * to the run ledger and the fleet dataset.
 */
export class WorkspaceAccounting {
  constructor(private readonly deps: WorkspaceAccountingDeps) {}

  /**
   * `ask` of the owner's limits: their own refusal (a limit, a suspension) fails the caller in their words; an account
   * object that could not be asked is logged under the ask's name and refuses nothing.
   */
  private admittedByLimits(asking: keyof typeof LIMITS_UNASKED, ask: (stub: UserHubClient, caller: UserCaller) => Promise<void>): Effect.Effect<void, KinuError> {
    const { owner, workspaceName } = this.deps.context;

    if (owner.userId() === null) return Effect.void;

    const asked = attemptInItsWords('unavailable', async () => {
      const { stub, caller } = await owner.hub();

      await ask(stub, caller);
    });

    return Effect.catch(asked, (failure) => (failure.code === 'budget' || failure.code === 'denied'
      ? Effect.fail(failure)
      : Effect.sync(() => { diagnostics.failure(LIMITS_UNASKED[asking], failure, { workspace: workspaceName() }); })));
  }

  /**
   * A turn on `spec`, admitted by the owner's limits: none starts in a suspended account, and one the platform pays for
   * (Workers AI through the deployment's binding) is bounded by the free tier's day of tokens.
   */
  admitTurn(spec: string): Effect.Effect<void, KinuError> {
    return this.admittedByLimits('turn', (stub, caller) => stub.limits_admitTurn(caller, specProvider(spec) === WORKERS_AI_PROVIDER_ID));
  }

  /** This workspace's stored bytes, as its own database reads them: the platform's number, sampled, never counted. */
  private storedSample() {
    return { source: `workspace:${this.deps.context.workspaceName()}`, bytes: this.deps.databaseSize() };
  }

  /** New bytes for this workspace (a person's upload, an agent's file): the owner's limits answer, given its size now. */
  admitNewBytes(): Effect.Effect<void, KinuError> {
    return this.admittedByLimits('bytes', (stub, caller) => stub.limits_admitStoredBytes(caller, this.storedSample()));
  }

  /** Tells the owner's limits this workspace's size now; a failure is logged, never the caller's. */
  async reportStoredBytes(): Promise<void> {
    const { owner } = this.deps.context;

    if (owner.userId() === null) return;
    await settleLogged('limits.size_unreported', { doing: "telling the owner's limits this workspace's size", otherwise: 'unavailable' }, async () => {
      const { stub, caller } = await owner.hub();
      const { source, bytes } = this.storedSample();

      await stub.limits_storageSampled(caller, source, bytes);
    });
  }

  /** What a call on the platform's own models spent counts to the owner's day, told, never waited on. */
  private debitPlatformTokens(report: ModelCallReport, provider: string): void {
    const { owner, life } = this.deps.context;
    const tokens = (report.usage.input ?? 0) + (report.usage.output ?? 0);

    if (provider !== WORKERS_AI_PROVIDER_ID || tokens <= 0 || owner.userId() === null) return;
    life.detach(Effect.promise(() => settleLogged('limits.tokens_undebited', { doing: "counting a platform model call to the owner's day", otherwise: 'unavailable' }, async () => {
      const { stub, caller } = await owner.hub();

      await stub.limits_platformTokensSpent(caller, tokens);
    })));
  }

  /** The run a record of the workspace agent files under: the operation in flight, else the workspace's own. */
  private runId(): string {
    return currentOperationProfile(this.deps.context.actor())?.runId ?? WORKSPACE_RUN_ID;
  }

  /**
   * Record one non-turn model call (judges, fast tier, evolution, compaction, AI bindings) as a `model_call` row, filed
   * under the current run or the workspace id. Row shape and pricing guard live in core's `pricedModelCallEvent`.
   */
  reportModelCall(report: ModelCallReport): void {
    const { context } = this.deps;
    const event = pricedModelCallEvent(report, this.deps.catalog);

    settleLoggedSync('event.model_call_emit_failed', { doing: 'recording a model_call run event', otherwise: 'io' }, () => {
      this.deps.events().emit(this.runId(), event);
    }, { source: report.source });

    // `spec` is absent on seams that never had one; the actor's effective model stands in so the row stays countable
    // against the provider it reached.
    const dimensions = this.dimensions(report.spec);

    this.debitPlatformTokens(report, dimensions.provider);
    recordModelRow(this.deps.env, {
      workspace: context.workspaceName(),
      agentKind: 'orchestrator',
      provider: dimensions.provider,
      model: report.modelId ?? dimensions.model,
      source: report.source,
      usage: report.usage,
      // Reuse the durable row's number; re-deriving it can disagree with the ledger if the catalog resolves a rate
      // between the two reads.
      usd: event.usd,
    });
  }

  /** Direct model operations' start and end, via core's shared mapper: a start with no end means the platform destroyed
   *  the frame mid-call. The recorder is resolved per emit, as the store bundle exists only after `onStart`. */
  readonly operations: ModelOperationSink = recordModelOperations(
    { emit: (runId, input) => { this.deps.events().emit(runId, input); } },
    () => this.runId(),
  );

  /** Where the workspace agent's provider words are recorded: its own log, under the operation in flight. */
  private ownProviderLog(): ProviderLog {
    return { recorder: this.deps.events(), runId: () => this.runId() };
  }

  /** The workspace agent's lanes' provider words. */
  readonly told: Required<NonNullable<ProvidersLane['told']>> = {
    onProviderWait: (info) => { this.noteProviderWait(info, this.ownProviderLog()); },
    onModelAttempt: (info) => { this.noteModelAttempt(info, this.ownProviderLog()); },
  };

  /** A hosted actor's lanes' provider words, recorded in its own log under the operation it is in. */
  toldFor(actor: BoundActor): Required<NonNullable<ProvidersLane['told']>> {
    const log: ProviderLog = { recorder: actor.stores.eventRecorder, runId: () => currentOperationProfile(actor.handle)?.runId ?? WORKSPACE_RUN_ID };

    return { onProviderWait: (info) => { this.noteProviderWait(info, log); }, onModelAttempt: (info) => { this.noteModelAttempt(info, log); } };
  }

  private noteModelAttempt(info: ModelAttemptInfo, log: ProviderLog): void {
    settleLoggedSync('event.model_attempt_emit_failed', { doing: 'recording a model_attempt run event', otherwise: 'io' }, () => {
      log.recorder.emit(log.runId(), { type: 'model_attempt', ...info });
    }, { provider: info.provider });
  }

  /** Records a provider-mandated wait (`provider_wait`), and tells the windows of the turn it holds: a call no turn made
   *  (a title, a logo, upkeep) holds no turn, so no window hears it. Recorder faults never kill the sleep. */
  private noteProviderWait(info: ProviderWaitInfo, log: ProviderLog): void {
    const runId = log.runId();

    settleLoggedSync('event.provider_wait_emit_failed', { doing: 'recording a provider_wait run event', otherwise: 'io' }, () => {
      log.recorder.emit(runId, { type: 'provider_wait', ...info });
    }, { provider: info.provider });

    const turn = activeOperationProfile();

    if (turn === undefined || turn.turnId === WORKSPACE_RUN_ID) return;
    const room = turn.actor.actorId === this.deps.context.actor().actorId ? null : turn.actor.actorId;

    this.deps.context.life.broadcast(JSON.stringify({ type: 'provider_wait', ...info }), room);
  }

  /**
   * The provider and model a row is counted under: `spec`'s, else the workspace agent's effective model. A malformed
   * spec (`report.spec` comes from many producers) costs the row its dimensions rather than the caller its turn.
   */
  dimensions(spec = this.deps.effectiveSpec()): ModelDimensions {
    const parts = spec.trim() === '' ? null : splitSpec(spec.trim());

    if (parts !== null && (parts.account === null || isAccountName(parts.account))) return { provider: parts.provider, model: parts.modelId };

    if (spec !== '') diagnostics.event('actor.model_spec_unparseable', { workspace: this.deps.context.workspaceName(), spec });

    return UNRESOLVED_MODEL;
  }

  /** Cost at the model's current catalog rate; undefined when the catalog has no rate. */
  price(usage: Usage): number | undefined {
    const pricing = this.deps.catalog.pricing();

    return pricing ? priceCall(usage, pricing) : undefined;
  }
}
