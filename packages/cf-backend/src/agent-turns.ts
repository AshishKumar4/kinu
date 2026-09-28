/** The workspace half of an agent-isolate turn (D9). */
import { asSchema, type ModelMessage, type ToolSet } from 'ai';
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
  interrupt(reference: ActorReference): Promise<void>;
  dynamic(actor: HostedActor, profile: ResolvedTurnProfile, tools: ToolSet): DynamicContext;
  pricing(spec: string): ModelPricing | null;
}

interface PendingTurn {
  readonly reference: ActorReference;
  readonly request: HostedTaskRequest;
  readonly ended: (end: AgentTurnEnd) => Promise<void>;
  prepared: PreparedHostedTask | null;
  profile?: ResolvedTurnProfile;
  over: boolean;
  readonly settled: Promise<AgentTurnEnd>;
  readonly resolve: (end: AgentTurnEnd) => void;
  readonly reject: (cause: KinuError) => void;
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

  async run(
    reference: ActorReference, request: HostedTaskRequest, task: AgentTask, ended: (end: AgentTurnEnd) => Promise<void>,
  ): Promise<AgentTurnEnd> {
    const { promise, resolve, reject } = Promise.withResolvers<AgentTurnEnd>();
    const pending: PendingTurn = { reference, request, ended, prepared: null, over: false, settled: promise, resolve, reject };

    this.pending.set(request.sequenceId, pending);

    try {
      await this.deps.deliver(reference, task);

      return await pending.settled;
    } finally {
      this.pending.delete(request.sequenceId);
    }
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
    const open = [...this.pending.values()].filter((pending) => pending.reference.actorId === actorId);

    await Promise.allSettled(open.map((pending) => pending.settled));
  }

  currentTurn(actorId: string): string | null {
    return this.running(actorId)?.request.sequenceId ?? null;
  }

  async beforeRetirement(actorId: string, interrupt: boolean): Promise<void> {
    const pending = this.running(actorId);

    if (pending === null) return;

    if (interrupt) {
      await this.deps.interrupt(pending.reference);

      return;
    }

    await Promise.allSettled([pending.settled]);
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

  advise(actorId: string, { turnId, turn, reachable, mode }: AgentReview): Promise<ModelMessage[]> {
    const { session } = this.prepared(this.turn(actorId, turnId)).turn.actor;
    const advice: ModelMessage[] = [];

    if (!session.orchestrator.improvementLanesOpen('completed', mode)) return Promise.resolve(advice);

    return settle(attempt({ doing: 'reviewing the reporting actor turn', otherwise: 'unavailable' }, () => session.reviewTurn(
      session.advisorSnapshot(turn, reachable), false, async (signal) => {
        advice.push({ role: 'user', content: signal.text });

        return 'queued';
      },
    )).pipe(Effect.match({
      onSuccess: () => advice,
      onFailure: (failure) => {
        diagnostics.failure('advisor.review_relay_failed', failure, { actor: actorId });

        return advice;
      },
    })));
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
    const pending = this.turn(actorId, turnId);

    pending.over = true;

    return settle(attempt({ doing: 'settling a delegated turn the agent finished', otherwise: 'io' }, async () => {
      await pending.ended(end);
      await settleHostedTask(this.deps.seams(), this.prepared(pending), pending.request, end);
    }).pipe(Effect.match({ onSuccess: () => { pending.resolve(end); }, onFailure: (failure) => { pending.reject(failure); } })));
  }

  fail(actorId: string, turnId: string, failure: string): void {
    this.turn(actorId, turnId).reject(new KinuError('io', failure));
  }
}
