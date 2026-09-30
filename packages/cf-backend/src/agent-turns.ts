/** The workspace half of an agent-isolate turn (D9). */
import { asSchema, type ToolSet } from 'ai';
import { attempt, diagnostics, KinuError, renderThrownChain, settle, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import {
  AgentOpenTurns, failedToolOutcome, hasPlanPermission, scaffoldProviders, runWorkModeInvocation,
  type ActorReference, type DynamicContext, type HostedActor, type ModelPricing, type ResolvedTurnProfile, type WorkMode,
  type HeadInput, type HeadInferenceDeps, type HeadReport, type SqlExecutor, type MissionBudgetPort, type Executor,
} from '@kinu.run/core';
import {
  prepareHostedTurn, settleHostedTask,
  type HostedActorSeams, type HostedTurnRequest, type PreparedHostedTurn,
} from './hosted-actors';
import type { AgentReview, AgentTask, AgentToolAnswer, AgentToolCall, AgentToolDescriptor, AgentTrace, AgentTurnEnd, AgentTurnProfile, PreparedAgentTurn, StoredRow } from './agent-facet/protocol';

export interface AgentTurnsDeps {
  readonly sql: SqlExecutor;
  seams(): HostedActorSeams;
  deliver(reference: ActorReference, task: AgentTask): Promise<void>;
  interrupt(reference: ActorReference, turnId: string): Promise<void>;
  dynamic(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext;
  pricing(spec: string): ModelPricing | null;
  live(actorId: string): boolean;
}

export interface AgentTurnHooks {
  begin(): Promise<void>;
  ended(end: AgentTurnEnd): Promise<void>;
  failed(failure: KinuError): Promise<void>;
  after(): Promise<void>;
}

interface PendingTurn {
  readonly reference: ActorReference;
  readonly request: HostedTurnRequest;
  readonly task: AgentTask;
  readonly hooks: AgentTurnHooks;
  prepared: PreparedHostedTurn | null;
  profile?: ResolvedTurnProfile;
  over: boolean;
  readonly done: ReturnType<typeof Promise.withResolvers<void>>;
}

async function describe(tools: ToolSet): Promise<AgentToolDescriptor[]> {
  return await Promise.all(Object.entries(tools).map(async ([name, tool]) => ({
    name,
    description: tool.description ?? '',
    inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    planAllowed: hasPlanPermission(tool),
  })));
}

export class AgentTurns {
  private readonly pending = new Map<string, PendingTurn>();

  constructor(private readonly deps: AgentTurnsDeps) {}

  start(reference: ActorReference, request: HostedTurnRequest, task: AgentTask, hooks: AgentTurnHooks): Promise<void> {
    const pending: PendingTurn = { reference, request, task, hooks, prepared: null, over: false, done: Promise.withResolvers<void>() };

    this.pending.set(request.sequenceId, pending);

    return settle(attempt({ doing: "handing a delegated turn to the agent's own isolate", otherwise: 'io' }, async () => {
      await hooks.begin();
      await this.deps.deliver(reference, task);
    }).pipe(Effect.catch((failure) => this.closing(pending, { failure }))));
  }

  async run(reference: ActorReference, input: HeadInput, inference: HeadInferenceDeps): Promise<HeadReport> {
    const result = Promise.withResolvers<Effect.Effect<HeadReport, KinuError>>();
    const task = { sequenceId: input.id, body: input.task, mode: input.mode };
    const opened = { actorId: reference.actorId, turnId: input.id };
    const ledger = new AgentOpenTurns(this.deps.sql);
    const interruptions: Promise<void>[] = [];
    const interrupt = () => { interruptions.push(this.interruptRun(reference, input.id)); };

    inference.signal?.addEventListener('abort', interrupt, { once: true });

    await this.start(reference, { ...task, run: { input, inference } }, task, {
      begin: async () => { ledger.open(opened, Date.now()); },
      ended: async ({ activity: _activity, narration: _narration, produced, errorMessage, ...report }) => {
        result.resolve(attempt({ doing: 'receiving an isolated swarm turn', otherwise: 'io' }, async (): Promise<HeadReport> => {
          if (produced !== undefined) inference.reportMessages?.(produced);

          return {
            ...report,
            errorMessage: errorMessage ?? undefined,
            fileChanges: inference.capture.files.snapshot(),
            ...(inference.isAborted() && { status: 'aborted', errorMessage: inference.abortReason?.() ?? errorMessage ?? undefined }),
          };
        }));
      },
      failed: async (failure) => { result.resolve(Effect.fail(failure)); },
      after: async () => {
        inference.signal?.removeEventListener('abort', interrupt);
        ledger.close(opened);
      },
    });

    if (inference.isAborted()) await this.interruptRun(reference, input.id);

    const outcome = await result.promise;
    await Promise.all(interruptions);

    return await settle(outcome);
  }

  interruptRun(reference: ActorReference, turnId: string): Promise<void> {
    return settle(attempt({ doing: 'interrupting a swarm turn in its own isolate', otherwise: 'io' },
      () => this.deps.interrupt(reference, turnId)).pipe(Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('agent.interrupt_failed', failure, { actor: reference.actorId });
      }))));
  }

  private closing(pending: PendingTurn, outcome: { readonly end: AgentTurnEnd } | { readonly failure: KinuError }): Effect.Effect<void> {
    pending.over = true;

    return attempt({ doing: 'settling a delegated turn the agent finished', otherwise: 'io' }, async () => {
      if ('end' in outcome) {
        await pending.hooks.ended(outcome.end);

        if (!this.deps.live(pending.reference.actorId) || pending.request.run !== undefined) return;
        await settleHostedTask(this.deps.seams(), this.prepared(pending), pending.request, outcome.end);
      } else {
        await pending.hooks.failed(outcome.failure);
      }
    }).pipe(
      Effect.andThen(() => attempt({ doing: 'closing the books on a delegated turn', otherwise: 'io' }, () => pending.hooks.after())),
      Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('subordinate.delegated_turn_settle_failed', failure, { actor: pending.reference.actorId });
      })),
      Effect.ensuring(Effect.sync(() => {
        this.pending.delete(pending.request.sequenceId);
        pending.done.resolve();
      })),
    );
  }

  private running(actorId: string): PendingTurn | null {
    for (const pending of this.pending.values()) {
      if (pending.reference.actorId === actorId && !pending.over) return pending;
    }

    return null;
  }

  inFlight(actorId: string): boolean {
    return this.running(actorId) !== null;
  }

  async settled(actorId: string): Promise<void> {
    await Promise.all([...this.pending.values()].filter((pending) => pending.reference.actorId === actorId)
      .map((pending) => pending.done.promise));
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending.values()].map((pending) => pending.done.promise));
  }

  async interrupt(actorId: string): Promise<void> {
    const pending = this.running(actorId);

    if (pending !== null) await this.deps.interrupt(pending.reference, pending.request.sequenceId);
  }

  currentTurn(actorId: string): string | null {
    return this.running(actorId)?.request.sequenceId ?? null;
  }

  async beforeRetirement(actorId: string, interrupt: boolean): Promise<void> {
    const pending = this.running(actorId);

    if (pending === null) return;

    if (interrupt) return await this.deps.interrupt(pending.reference, pending.request.sequenceId);

    return await settle(Effect.fail(new KinuError('denied', 'This actor holds a turn in flight; retire it once the turn settles.')));
  }

  turn(actorId: string, turnId: string): PendingTurn {
    const pending = this.pending.get(turnId);

    if (pending !== undefined && pending.reference.actorId === actorId) return pending;

    return settleSync(Effect.fail(new KinuError('missing', `No delegated turn ${turnId} is open for this agent in the workspace.`)));
  }

  prepared(pending: PendingTurn): PreparedHostedTurn {
    if (pending.prepared !== null) return pending.prepared;

    return settleSync(Effect.fail(new KinuError('denied', 'The agent called a tool before its turn was prepared.')));
  }

  private dynamic(pending: PendingTurn): DynamicContext {
    const { turn, tools } = this.prepared(pending);
    const active = pending.profile ?? turn.profile.profile;
    const run = pending.request.run?.inference;

    return run === undefined ? this.deps.dynamic(turn.actor, active, tools) : run.dynamic(active, tools);
  }

  async prepare(actorId: string, turnId: string): Promise<PreparedAgentTurn> {
    const pending = this.turn(actorId, turnId);
    const prepared = await prepareHostedTurn(this.deps.seams(), pending.reference, pending.request);
    const run = pending.request.run?.inference;

    pending.prepared = prepared;
    const { actor } = prepared.turn;
    const version = await actor.runtime.identity.scaffold.version();

    const scaffold = actor.runtime.storage.sql<StoredRow>`
      SELECT * FROM scaffold_versions WHERE actor_id = ${actor.record.actorId} AND version = ${version}`[0];

    if (scaffold === undefined) return settleSync(Effect.fail(new KinuError('missing', "The agent's selected scaffold has no stored version.")));

    return {
      input: prepared.turn.input,
      runId: run?.runId ?? crypto.randomUUID(),
      ...(run === undefined && { birthContext: prepared.birthContext }),
      model: prepared.model,
      pricing: this.deps.pricing(prepared.model),
      scaffold,
      languages: actor.runtime.executor.languages,
      framing: prepared.framing,
      workspaceLayout: run?.workspaceLayout ?? 'shared-workspace',
      tools: await describe(prepared.tools),
      dynamic: this.dynamic(pending),
      ...(run?.mission !== undefined && { missionLabels: run.mission.labels }),
      trace: run?.reportStep !== undefined || run?.reportDelta !== undefined,
      resume: run?.resume !== undefined,
      reportMessages: run?.reportMessages !== undefined,
    };
  }

  async profile(actorId: string, turnId: string, availableTools: readonly string[], workMode: WorkMode): Promise<AgentTurnProfile> {
    const pending = this.turn(actorId, turnId);
    const run = pending.request.run?.inference;

    const resolved = await (run === undefined
      ? this.deps.seams().profile({ actor: this.prepared(pending).turn.actor, availableTools, workMode })
      : run.profile({ availableTools, workMode }));

    pending.profile = resolved.profile;

    return { ...resolved, dynamic: this.dynamic(pending) };
  }

  async advise(actorId: string, { turnId, turn, reachable, mode }: AgentReview): Promise<void> {
    const pending = this.turn(actorId, turnId);
    const advise = pending.request.run?.inference.advise;

    if (advise !== undefined) return await advise(turn, reachable, mode);
    const { session } = this.prepared(pending).turn.actor;

    if (!session.orchestrator.improvementLanesOpen('completed', mode)) return;

    await session.hireAdvisor(session.advisorSnapshot(turn, reachable));
  }

  async trace(actorId: string, turnId: string, event: AgentTrace): Promise<void> {
    const inference = this.turn(actorId, turnId).request.run?.inference;

    if (event.kind === 'step') await inference?.reportStep?.(event.sequence, event.step);
    else inference?.reportDelta?.(event.kind, event.delta);
  }

  async resume(actorId: string, turnId: string) {
    return await this.turn(actorId, turnId).request.run?.inference.resume?.() ?? null;
  }

  async guard(actorId: string, turnId: string, ...args: Parameters<MissionBudgetPort['guard']>) {
    return await this.turn(actorId, turnId).request.run?.inference.mission?.port.guard(...args) ?? null;
  }

  async debit(actorId: string, turnId: string, ...args: Parameters<MissionBudgetPort['debit']>): Promise<void> {
    await this.turn(actorId, turnId).request.run?.inference.mission?.port.debit(...args);
  }

  async program(actorId: string, turnId: string, ...[code, providers, opts]: Parameters<Executor['execute']>) {
    const pending = this.turn(actorId, turnId);
    const { actor } = this.prepared(pending).turn;
    const supplied = Array.isArray(providers) ? providers : [{ name: 'codemode', fns: providers }];
    const signal = pending.request.run?.inference.signal;
    const control = signal === undefined ? {} : { signal };

    return await actor.runtime.executor.execute(code, [...supplied, ...scaffoldProviders(actor.runtime, control, pending.task.mode)], opts);
  }
  async execute(actorId: string, { turnId, callId, name, input }: AgentToolCall): Promise<AgentToolAnswer> {
    const pending = this.turn(actorId, turnId);
    const prepared = this.prepared(pending);
    const execute = prepared.tools[name]?.execute;

    if (execute === undefined) return settleSync(Effect.fail(new KinuError('bad_input', `The agent called ${name}, which its turn's tool surface does not hold.`)));

    const { capture } = prepared.turn;

    const before = {
      evidence: capture.evidence.length, decisions: capture.decisions.length, artifacts: capture.artifacts.length,
      toolCalls: capture.toolCalls.length, childHeadIds: capture.childHeadIds.length,
    };

    return settle(Effect.tryPromise({
      try: async () => ({ output: await runWorkModeInvocation(pending.task.mode, () => execute(input, { toolCallId: callId, messages: [] })) }),
      catch: (cause) => ({ cause }),
    }).pipe(
      Effect.catch((failed) => Effect.succeed({ failure: { ...failedToolOutcome(failed), error: renderThrownChain(failed) } })),
      Effect.map((result) => ({
        ...result,
        captured: {
          evidence: capture.evidence.slice(before.evidence),
          decisions: capture.decisions.slice(before.decisions),
          artifacts: capture.artifacts.slice(before.artifacts),
          toolCalls: capture.toolCalls.slice(before.toolCalls),
          childHeadIds: capture.childHeadIds.slice(before.childHeadIds),
        },
        dynamic: this.dynamic(pending),
      })),
    ));
  }

  finish(actorId: string, turnId: string, end: AgentTurnEnd): Promise<void> {
    return settle(this.closing(this.turn(actorId, turnId), { end }));
  }

  fail(actorId: string, turnId: string, failure: string): Promise<void> {
    return settle(this.closing(this.turn(actorId, turnId), { failure: new KinuError('io', failure) }));
  }
}
