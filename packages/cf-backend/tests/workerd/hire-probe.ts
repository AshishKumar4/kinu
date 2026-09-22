/**
 * The workerd fixture for the delegation path: a real workspace Durable
 * Object, a real hire authored by a real model, and reads over the storage the
 * product wrote.
 *
 * WHAT IS REAL HERE. The orchestrator is the shipped class, bound under the
 * production name, sealed with the production RPC surface plus read-only
 * fixture queries. Nothing stubs `scheduleDrain`, nothing hand-calls
 * `relayHostedReport`, and no case asserts on source text: a hire is driven by
 * pinning the workspace model to a fake wire whose first answer IS the real
 * `agents` tool call, and every verdict is read back out of
 * `actor_subordinates`, `agent_log`, `run_events` and the child's own
 * transcript.
 *
 * WHY THE CHILD SPEAKS ON A DIFFERENT WIRE. A hosted actor's turn profile
 * resolves its model from the role's tier in the profile catalog
 * (`actor-agent.ts:hostedActorProfile`), which does NOT take the workspace pin
 * — so the child's spec is a `workers-ai/` model and its request arrives on the
 * AI service binding, not over HTTP. `HireAI` below is that wire.
 *
 * NO CLOCKS, ANYWHERE. `scripts/test-clocks.ts` locks the clock corpus
 * shrink-only and this file is inside it, so every wait is a gate some request
 * resolves. A case whose product path never arrives therefore hangs instead of
 * failing on a deadline; the workerd tier sets `testTimeout: 0`, so a hang is
 * reported as a hang rather than dressed up as an assertion.
 */

import { Agent, getAgentByName, type AgentContext } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { ownerCaller } from '@kinu.run/core';
import { sealRpcSurface, ORCHESTRATOR_RPC_SURFACE } from '../../src/rpc-surface';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type { UserDO } from '../../src/user/user-do';
import { HIRE_CHILD_MODEL, type ActorRow, type ChildScript, type HireObservation, type LogRow, type RosterRow, type TurnCount } from './hire-shapes';

// The production user object, re-exported so the fixture worker binds the
// shipped class rather than a stand-in.
export { UserDO } from '../../src/user/user-do';

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

export class HireOrchestrator extends ProductionOrchestrator {
  private readonly probeState: AgentContext;

  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    this.probeState = ctx;

    // `ActorAgent`'s own constructor sealed the surface BEFORE this body ran,
    // and that pass installs an own non-enumerable shadow over every
    // prototype member it does not allow — including these reads, which it
    // could not have known about. Deleting the shadow restores the prototype
    // method so the wider seal below actually exposes it. Same three lines the
    // two-turn probe carries, for the same reason.
    for (const name of ['rosterRows', 'actorRows', 'logRows', 'turnCounts', 'driveOwedWork', 'rootActorId', 'childTranscript']) {
      Reflect.deleteProperty(this, name);
    }

    sealRpcSurface(this, [
      ...ORCHESTRATOR_RPC_SURFACE,
      'rosterRows', 'actorRows', 'logRows', 'turnCounts', 'driveOwedWork', 'rootActorId', 'childTranscript',
    ]);
  }

  /** The workspace's own top-level actor, read from the directory rather than
   *  assumed: every child-scoped count is "not this id", and a literal guessed
   *  here would silently count the root's rows as a child's. */
  async rootActorId(): Promise<string> {
    const rows = this.probeState.storage.sql.exec<{ actor_id: string }>(
      `SELECT actor_id FROM workspace_actors WHERE kind = 'main' LIMIT 1`).toArray();

    return rows[0]?.actor_id ?? '';
  }

  /** Every roster row in this object, dismissed rows included. */
  async rosterRows(): Promise<RosterRow[]> {
    const rows = this.probeState.storage.sql.exec<{
      actor_id: string; name: string; lifetime: string; status: string; task_event_id: string | null;
    }>(`SELECT actor_id, name, lifetime, status, task_event_id
        FROM actor_subordinates ORDER BY created_at`).toArray();

    return rows.map((row) => ({
      actorId: row.actor_id, name: row.name, lifetime: row.lifetime,
      status: row.status, taskEventId: row.task_event_id,
    }));
  }

  /** Every identity row in this workspace, retired ones included. The roster
   *  and the directory are two different tables and a settled task hire moves
   *  only the second, so an assertion that reads a child's rows states which
   *  plane it is reading. */
  async actorRows(): Promise<ActorRow[]> {
    const rows = this.probeState.storage.sql.exec<{
      actor_id: string; name: string; kind: string; retiring_at: number | null; deleted_at: number | null;
    }>(`SELECT actor_id, name, kind, retiring_at, deleted_at
        FROM workspace_actors ORDER BY created_at`).toArray();

    return rows.map((row) => ({
      actorId: row.actor_id, name: row.name, kind: row.kind,
      retiringAt: row.retiring_at, deletedAt: row.deleted_at,
    }));
  }

  /** Delegation rows across every actor's log: the admission ledger a bounded
   *  assertion counts, plus the reports that came back. */
  async logRows(): Promise<LogRow[]> {
    const rows = this.probeState.storage.sql.exec<{
      actor_id: string; id: string; variant: string; turn_id: string | null;
      consumed_at: number | null; payload: string;
    }>(`SELECT actor_id, id, variant, turn_id, consumed_at, payload
        FROM agent_log
        WHERE kind = 'event' AND variant IN ('subordinate_task', 'subordinate_report')
        ORDER BY id`).toArray();

    return rows.map((row) => {
      const record = v.parse(
        v.fallback(
          v.looseObject({ kind: v.optional(v.string()), body: v.optional(v.string()), content: v.optional(v.string()) }),
          {},
        ),
        JSON.parse(row.payload),
      );

      const kind = v.is(v.string(), record.kind) ? record.kind : row.variant;

      const authored = v.is(v.string(), record.body) ? record.body : null;
      const rendered = v.is(v.string(), record.content) ? record.content : null;
      const body = authored ?? rendered ?? '';

      return {
        actorId: row.actor_id, id: row.id, variant: row.variant,
        turnId: row.turn_id, consumedAt: row.consumed_at,
        kind, bodyLength: body.length, body,
      };
    });
  }

  /** Turns per actor, from the run ledger the product writes. */
  async turnCounts(): Promise<TurnCount[]> {
    const rows = this.probeState.storage.sql.exec<{ actor_id: string; runs: number }>(
      `SELECT actor_id, COUNT(DISTINCT run_id) AS runs FROM run_events
       WHERE type = 'run_start' GROUP BY actor_id`).toArray();

    return rows.map((row) => ({ actorId: row.actor_id, runs: row.runs }));
  }

  /** One named subordinate's own transcript, by the name the roster carries.
   *
   *  A delegated turn reports rather than chats, so its durable record is the
   *  child's OWN `run_events` — `run_start` carries the admitted brief as the
   *  turn's input, `step_partial` the streamed answer as it accumulated, and
   *  `step_finish` the step's settled messages. The transcript is not it:
   *  that store is written by the conversational path a delegated turn never
   *  enters. Read here rather than over RPC so the assertion sees what the
   *  child's turn actually persisted, not a projection built for a pane. */
  async childTranscript(name: string): Promise<string[]> {
    const rows = this.probeState.storage.sql.exec<{ run_id: string; type: string; payload: string }>(
      `SELECT e.run_id AS run_id, e.type AS type, e.payload AS payload
       FROM run_events e
       JOIN workspace_actors a ON a.actor_id = e.actor_id
       WHERE a.name = ? AND e.type IN ('run_start', 'step_partial', 'step_finish')
       ORDER BY e.rowid`, name).toArray();

    const lines: string[] = [];
    // `step_partial` rewrites one step's text-so-far, so the row that counts
    // is the last per (run, step): the partial cadence flushes cumulative
    // text, and earlier flushes are prefixes of it.
    const partials = new Map<string, string>();

    for (const row of rows) {
      const payload = v.parse(
        v.fallback(v.looseObject({
          userMessage: v.optional(v.unknown()),
          text: v.optional(v.unknown()),
          stepIndex: v.optional(v.number()),
          messages: v.optional(v.array(v.unknown())),
        }), {}),
        JSON.parse(row.payload),
      );

      if (row.type === 'run_start' && v.is(v.string(), payload.userMessage)) {
        lines.push(`user: ${payload.userMessage}`);
      }

      if (row.type === 'step_partial' && v.is(v.string(), payload.text)) {
        partials.set(`${row.run_id}:${String(payload.stepIndex ?? 0)}`, payload.text);
      }

      if (row.type !== 'step_finish') continue;

      for (const message of payload.messages ?? []) {
        const parsed = v.safeParse(v.looseObject({
          role: v.optional(v.string()),
          content: v.optional(v.union([
            v.string(),
            v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
          ])),
        }), message);

        if (!parsed.success || parsed.output.role !== 'assistant') continue;

        const content = parsed.output.content;

        const text = v.is(v.string(), content)
          ? content
          : (content ?? []).map((part) => part.text ?? '').join('');

        if (text !== '') lines.push(`assistant: ${text}`);
      }
    }

    for (const text of partials.values()) lines.push(`assistant: ${text}`);

    return lines;
  }

  /**
   * The owed-work frame this object runs on its own wake, driven in-request.
   *
   * This is the re-entry a suite needs after an eviction: an in-flight request
   * holds the input gate, so a probe cannot sit and wait for the platform's
   * alarm to be delivered.
   *
   * THE WAKE ITSELF, `_kinuTerminalRetryTick`, and not a hand-picked subset of
   * it. The subset this used to drive — `owedDeliveryWork` alone — left out
   * both maintenance passes, so the re-entry ran neither the chat-loop resume,
   * nor the interrupted-claim recovery, nor the delegation sweep, and a case
   * that needed any of them measured a product that had never been asked. A
   * probe that narrows the frame it claims to drive reports a hang the product
   * does not have.
   *
   * The reactor drain after it is the one thing the frame genuinely cannot do
   * in-request: `owedDeliveryWork` re-pends stale leases and asks for a
   * DEBOUNCED drain, whose 250 ms timer no request can wait for.
   */
  async driveOwedWork(): Promise<void> {
    await this.terminalRetryPass();
    await this.orch.drainPendingEvents({ rethrow: true });
  }
}

export { HireOrchestrator as OrchestratorAgent };

/** The auxiliary Workers AI lanes: the title suggester and the sleep-time
 *  judge, which resolve their own models and must be answered for every
 *  workspace here.
 *
 *  The CHILD's turn is deliberately NOT on this binding: the workspace is
 *  pinned to an `openai-compat` spec and a hosted actor's turn runs on that
 *  pin, so a delegated turn travels the same HTTP seam the two-turn tier
 *  already proves — the direct Workers AI streaming path hangs a delegated
 *  turn for a minute and then reports "ReadableStream reader has been
 *  released", which is its own finding and not something the delegation
 *  assertions should ride on. */
export class HireAI extends WorkerEntrypoint {
  async run(
    _model: string,
    body: { messages?: readonly { role?: string }[] },
    _options?: HireRunOptions,
  ): Promise<Response> {

    // Lane by ROLE, never by text, as the two-turn fake keys it: the title lane
    // leads with a system message, the sleep judge is user-only.
    const title = body.messages?.[0]?.role === 'system';

    return Response.json({
      response: title
        ? JSON.stringify({ title: 'Hire Probe' })
        : JSON.stringify({ upserts: [], decay: [] }),
    });
  }
}

/** The control host's `/hire/log` answer: captured model calls, each with the
 *  tool-result strings it carried in. */
const WireLogSchema = v.looseObject({
  calls: v.array(v.looseObject({ toolResults: v.optional(v.array(v.unknown())) })),
});

/** `options` as the Workers AI adapter builds it; the fixture does not read
 *  it, only names its contract so the binding call resolves. */
interface HireRunOptions {
  readonly signal?: unknown;
  readonly returnRawResponse?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}


/** The narrow view of the workspace this fixture drives. Stated as a `Pick`
 *  intersection for the reason the two-turn probe states it: the full stub type
 *  instantiates too deeply to compile. */
type HireTarget = Pick<ProductionOrchestrator, 'claimOwner' | 'setModel' | 'setSoul' | 'runTaskFromMcp'>
  & Pick<HireOrchestrator,
    'rosterRows' | 'actorRows' | 'logRows' | 'turnCounts' | 'driveOwedWork' | 'rootActorId' | 'childTranscript'>;

/** The probe worker's own bindings. `durableObjects` installs `HireOrchestrator`
 *  under the `OrchestratorAgent` name (the re-export above), which the
 *  production `Env` declares by its base class, so every stub the namespace
 *  returns carries the fixture reads. */
interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<HireOrchestrator>;
}

type OwnerTarget = Pick<UserDO,
  'registerWorkspace' | 'ensureWorkspaceCapability' | 'setCredential' | 'getProfileCatalog' | 'putProfileCatalog'>;

export class HireProbeRoot extends Agent<ProbeRootEnv> {
  /** Settles when the durable lane's `msg` call was authored. */
  async msgSent(): Promise<void> {
    await fetch('http://hire-control.invalid/hire/msg-sent');
  }

  private target(workspace: string): Promise<HireTarget> {
    return getAgentByName<ProbeEnv, HireOrchestrator>(this.env.OrchestratorAgent, workspace);
  }

  private owner(name: string): OwnerTarget {
    return this.env.UserDO.get(this.env.UserDO.idFromName(name));
  }

  /** Claim the workspace, pin the root's wire, and arm the child's script. */
  async setup(workspace: string, model: string, script: ChildScript): Promise<void> {
    await fetch('http://hire-control.invalid/hire/reset', {
      method: 'POST', body: JSON.stringify({ script }),
    });

    const target = await this.target(workspace);
    const caller = await ownerCaller(this.env);
    const userDO = this.owner(`${workspace}-owner`);

    await userDO.registerWorkspace(caller, workspace, 'Hire Probe');

    const claim = await target.claimOwner(`${workspace}-owner`);

    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: 'http://hire-models.invalid/v1', apiKey: 'hire-fixture-key',
    });
    // The default tier, written through the account catalog's own
    // compare-and-swap rather than by reaching into any actor's config: every
    // tier slot is checked against the provider listing at the turn boundary,
    // so the default has to name a spec this fixture's host offers. The
    // child's own turn runs on the workspace pin below, as every turn of a
    // pinned workspace does.
    const catalog = await userDO.getProfileCatalog(caller);

    await userDO.putProfileCatalog(
      caller,
      { roles: {}, tiers: { default: { model: `openai-compat/${HIRE_CHILD_MODEL}` } } },
      catalog.version,
    );
    await target.setModel(`openai-compat/${model}`);
    await target.setSoul('# Hire Probe\n\n## Mission\n\nDelegate exactly what the owner asks for.');
  }

  /** Let a parked child finish its turn. */
  async releaseChild(): Promise<void> {
    await fetch('http://hire-control.invalid/hire/release-child', { method: 'POST' });
  }

  /** Settles when the child's turn reached the model wire. */
  async childSpoke(): Promise<void> {
    await fetch('http://hire-control.invalid/hire/child-spoke');
  }

  /** Settles when the caller's own `agents` call resolved into its next model
   *  request — the caller observing its answer. */
  async callerObserved(): Promise<void> {
    await fetch('http://hire-control.invalid/hire/root-saw');
  }

  /** Open the turn that authors the hire. */
  async openHire(workspace: string, prompt: string): Promise<void> {
    const target = await this.target(workspace);

    await target.runTaskFromMcp(prompt);
  }

  /** Drive the object's own owed-work frame — the re-entry after an eviction. */
  async reenter(workspace: string): Promise<void> {
    const target = await this.target(workspace);

    await target.driveOwedWork();
  }

  /** Everything the assertions read, in one round trip. */
  async observe(workspace: string): Promise<HireObservation> {
    const target = await this.target(workspace);
    const rootActorId = await target.rootActorId();
    const roster = await target.rosterRows();
    const actors = await target.actorRows();
    const log = await target.logRows();
    const turns = await target.turnCounts();
    const response = await fetch('http://hire-control.invalid/hire/log');

    const wire = v.parse(
      v.fallback(WireLogSchema, { calls: [] }),
      await response.json(),
    );

    const toolResults: string[] = [];

    for (const call of wire.calls) {
      for (const result of call.toolResults ?? []) {
        if (v.is(v.string(), result)) toolResults.push(result);
      }
    }


    const transcript: string[] = [];

    for (const row of roster) transcript.push(...await target.childTranscript(row.name));

    return { rootActorId, roster, actors, log, turns, toolResults, transcript };
  }
}
