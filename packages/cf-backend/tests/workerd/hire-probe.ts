/**
 * Workerd fixture for delegation: the shipped orchestrator, a hire authored by a fake model wire, verdicts read from storage.
 * The child resolves its model from the role tier (`actor-agent.ts:hostedActorProfile`), not the workspace pin.
 * No clocks: `scripts/test-clocks.ts` locks this file, so every wait is a gate and a missing path hangs.
 */

import { Agent, getAgentByName, type AgentContext } from 'agents';
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as v from 'valibot';
import { ownerCaller } from '@kinu.run/core';
import { sealRpcSurface, ORCHESTRATOR_RPC_SURFACE } from '../../src/rpc-surface';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type { UserDO } from '../../src/user/user-do';
import { HIRE_CHILD_MODEL, type ActorRow, type ChildScript, type HireObservation, type LogRow, type RosterRow, type TurnCount } from './hire-shapes';

export { UserDO } from '../../src/user/user-do';

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

export class HireOrchestrator extends ProductionOrchestrator {
  private readonly probeState: AgentContext;

  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    this.probeState = ctx;

    // `ActorAgent`'s constructor already sealed the surface with non-enumerable shadows over these reads;
    // deleting the shadow lets the wider seal below expose the prototype method.
    for (const name of ['rosterRows', 'actorRows', 'logRows', 'turnCounts', 'driveOwedWork', 'rootActorId', 'childTranscript']) {
      Reflect.deleteProperty(this, name);
    }

    sealRpcSurface(this, [
      ...ORCHESTRATOR_RPC_SURFACE,
      'rosterRows', 'actorRows', 'logRows', 'turnCounts', 'driveOwedWork', 'rootActorId', 'childTranscript',
    ]);
  }

  /** Read, not assumed: child counts are "not this id", and a guessed literal would count the root's rows. */
  async rootActorId(): Promise<string> {
    const rows = this.probeState.storage.sql.exec<{ actor_id: string }>(
      `SELECT actor_id FROM workspace_actors WHERE kind = 'main' LIMIT 1`).toArray();

    return rows[0]?.actor_id ?? '';
  }

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

  /** A settled task hire moves only the directory, not the roster, so child assertions state which plane they read. */
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

  async turnCounts(): Promise<TurnCount[]> {
    const rows = this.probeState.storage.sql.exec<{ actor_id: string; runs: number }>(
      `SELECT actor_id, COUNT(DISTINCT run_id) AS runs FROM run_events
       WHERE type = 'run_start' GROUP BY actor_id`).toArray();

    return rows.map((row) => ({ actorId: row.actor_id, runs: row.runs }));
  }

  /** A delegated turn's durable record is its own `run_events` (`run_start` brief, `step_partial` stream,
   *  `step_finish` messages); the transcript store is never written by a delegated turn. */
  async childTranscript(name: string): Promise<string[]> {
    const rows = this.probeState.storage.sql.exec<{ run_id: string; type: string; payload: string }>(
      `SELECT e.run_id AS run_id, e.type AS type, e.payload AS payload
       FROM run_events e
       JOIN workspace_actors a ON a.actor_id = e.actor_id
       WHERE a.name = ? AND e.type IN ('run_start', 'step_partial', 'step_finish')
       ORDER BY e.rowid`, name).toArray();

    const lines: string[] = [];
    // Partial flushes are cumulative, so only the last row per (run, step) counts.
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
   * Runs the full wake `_kinuTerminalRetryTick` in-request (an in-flight request holds the input gate, so no alarm arrives).
   * A narrower frame would report hangs the product does not have. The debounced reactor drain is driven separately.
   */
  async driveOwedWork(): Promise<void> {
    await this.terminalRetryPass();
    await this.orch.drainPendingEvents({ rethrow: true });
  }
}

export { HireOrchestrator as OrchestratorAgent };

/** The auxiliary Workers AI lanes (title suggester, sleep-time judge). The child's turn is deliberately not on this
 *  binding: the direct Workers AI streaming path hangs a delegated turn ("ReadableStream reader has been released"). */
export class HireAI extends WorkerEntrypoint {
  async run(
    _model: string,
    body: { messages?: readonly { role?: string }[] },
    _options?: HireRunOptions,
  ): Promise<Response> {

    // Lane by role, never by text: the title lane leads with a system message, the sleep judge is user-only.
    const title = body.messages?.[0]?.role === 'system';

    return Response.json({
      response: title
        ? JSON.stringify({ title: 'Hire Probe' })
        : JSON.stringify({ upserts: [], decay: [] }),
    });
  }
}

const WireLogSchema = v.looseObject({
  calls: v.array(v.looseObject({ toolResults: v.optional(v.array(v.unknown())) })),
});

interface HireRunOptions {
  readonly signal?: unknown;
  readonly returnRawResponse?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/** A `Pick` intersection: the full stub type instantiates too deeply to compile. */
type HireTarget = Pick<ProductionOrchestrator, 'claimOwner' | 'setModel' | 'setSoul' | 'runTaskFromMcp'>
  & Pick<HireOrchestrator,
    'rosterRows' | 'actorRows' | 'logRows' | 'turnCounts' | 'driveOwedWork' | 'rootActorId' | 'childTranscript'>;

/** `durableObjects` installs `HireOrchestrator` under the `OrchestratorAgent` name, so every stub carries the fixture reads. */
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
    // Written through the account catalog's compare-and-swap: every tier slot is checked against the provider
    // listing at the turn boundary, so the default must name a spec this host offers.
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

  async openHire(workspace: string, prompt: string): Promise<void> {
    const target = await this.target(workspace);

    await target.runTaskFromMcp(prompt);
  }

  /** Drive the object's own owed-work frame — the re-entry after an eviction. */
  async reenter(workspace: string): Promise<void> {
    const target = await this.target(workspace);

    await target.driveOwedWork();
  }

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
