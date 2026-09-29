/** The workspace half of an agent-isolate turn (D9). */
import { asSchema, type ToolSet } from 'ai';
import { attempt, diagnostics, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import type { ActorReference, DynamicContext, HostedActor, ModelPricing, ResolvedTurnProfile, WorkMode } from '@kinu.run/core';
import {
  prepareHostedTask, settleHostedTask,
  type HostedActorSeams, type HostedTaskRequest, type PreparedHostedTask,
} from './hosted-actors';
import type { AgentReview, AgentTask, AgentToolAnswer, AgentToolCall, AgentToolDescriptor, AgentTurnEnd, AgentTurnProfile, PreparedAgentTurn } from './agent-facet/protocol';

export interface AgentTurnsDeps {
  seams(): HostedActorSeams;
  deliver(reference: ActorReference, task: AgentTask): Promise<void>;
  interrupt(reference: ActorReference, turnId: string): Promise<void>;
  dynamic(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext;
  pricing(spec: string): ModelPricing | null;
  live(actorId: string): boolean;
}

/** Each hook runs in the request that reaches it; none is awaited from another request (D9). */
export interface AgentTurnHooks {
  begin(): Promise<void>;
  ended(end: AgentTurnEnd): Promise<void>;
  failed(failure: KinuError): Promise<void>;
  after(): Promise<void>;
}

interface PendingTurn {
  readonly reference: ActorReference;
  readonly request: HostedTaskRequest;
  readonly task: AgentTask;
  readonly hooks: AgentTurnHooks;
  prepared: PreparedHostedTask | null;
  profile?: ResolvedTurnProfile;
  over: boolean;
  readonly done: ReturnType<typeof Promise.withResolvers<void>>;
}

async function describe(tools: ToolSet): Promise<AgentToolDescriptor[]> {
  return await Promise.all(Object.entries(tools).map(async ([name, tool]) => ({
    name,
    description: tool.description ?? '',
    inputSchema: await asSchema(tool.inputSchema).jsonSchema,
  })));
}

export class AgentTurns {
  private readonly pending = new Map<string, PendingTurn>();

  constructor(private readonly deps: AgentTurnsDeps) {}

  start(reference: ActorReference, request: HostedTaskRequest, task: AgentTask, hooks: AgentTurnHooks): Promise<void> {
    const pending: PendingTurn = { reference, request, task, hooks, prepared: null, over: false, done: Promise.withResolvers<void>() };

    this.pending.set(request.sequenceId, pending);

    return settle(attempt({ doing: "handing a delegated turn to the agent's own isolate", otherwise: 'io' }, async () => {
      await hooks.begin();
      await this.deps.deliver(reference, task);
    }).pipe(Effect.catch((failure) => this.closing(pending, { failure }))));
  }

  private closing(pending: PendingTurn, outcome: { readonly end: AgentTurnEnd } | { readonly failure: KinuError }): Effect.Effect<void> {
    pending.over = true;

    return attempt({ doing: 'settling a delegated turn the agent finished', otherwise: 'io' }, async () => {
      if ('end' in outcome) {
        await pending.hooks.ended(outcome.end);

        if (!this.deps.live(pending.reference.actorId)) return;
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

  prepared(pending: PendingTurn): PreparedHostedTask {
    if (pending.prepared !== null) return pending.prepared;

    return settleSync(Effect.fail(new KinuError('denied', 'The agent called a tool before its turn was prepared.')));
  }

  private dynamic(pending: PendingTurn): DynamicContext {
    const { turn, tools } = this.prepared(pending);

    return this.deps.dynamic(turn.actor, pending.profile ?? turn.profile.profile, tools);
  }

  async prepare(actorId: string, turnId: string): Promise<PreparedAgentTurn> {
    const pending = this.turn(actorId, turnId);
    const prepared = await prepareHostedTask(this.deps.seams(), pending.reference, pending.request);

    pending.prepared = prepared;

    return {
      input: prepared.turn.input,
      birthContext: prepared.birthContext,
      model: prepared.turn.profile.profile.tier.model,
      pricing: this.deps.pricing(prepared.turn.profile.profile.tier.model),
      framing: prepared.framing,
      tools: await describe(prepared.tools),
      dynamic: this.dynamic(pending),
    };
  }

  async profile(actorId: string, turnId: string, availableTools: readonly string[], workMode: WorkMode): Promise<AgentTurnProfile> {
    const pending = this.turn(actorId, turnId);
    const resolved = await this.deps.seams().profile({ actor: this.prepared(pending).turn.actor, availableTools, workMode });

    pending.profile = resolved.profile;

    return { ...resolved, dynamic: this.dynamic(pending) };
  }

  async advise(actorId: string, { turnId, turn, reachable, mode }: AgentReview): Promise<void> {
    const { session } = this.prepared(this.turn(actorId, turnId)).turn.actor;

    if (!session.orchestrator.improvementLanesOpen('completed', mode)) return;

    await session.hireAdvisor(session.advisorSnapshot(turn, reachable));
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

    const output = await execute(input, { toolCallId: callId, messages: [] });

    return {
      output,
      captured: {
        evidence: capture.evidence.slice(before.evidence),
        decisions: capture.decisions.slice(before.decisions),
        artifacts: capture.artifacts.slice(before.artifacts),
        toolCalls: capture.toolCalls.slice(before.toolCalls),
        childHeadIds: capture.childHeadIds.slice(before.childHeadIds),
      },
      dynamic: this.dynamic(pending),
    };
  }

  finish(actorId: string, turnId: string, end: AgentTurnEnd): Promise<void> {
    return settle(this.closing(this.turn(actorId, turnId), { end }));
  }

  fail(actorId: string, turnId: string, failure: string): Promise<void> {
    return settle(this.closing(this.turn(actorId, turnId), { failure: new KinuError('io', failure) }));
  }
}
