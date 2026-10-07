/**
 * Workerd fixture for delegation: the shipped orchestrator, a hire authored by a fake model wire, verdicts read from storage.
 * The child resolves its model from the role tier (`actor-agent.ts:hostedActorProfile`), not the workspace pin.
 * No clocks: `scripts/test-clocks.ts` locks this file, so every wait is a gate and a missing path hangs. A job's window
 * runs on a hand clock the object is handed and the test advances.
 */

import { Agent, getAgentByName, type AgentContext } from 'agents';
import { Effect } from 'effect';
import * as v from 'valibot';
import { actorReferenceOf, isSubordinateOrigin, ownerCaller, type ArchiveCursor, type Clock } from '@kinu.run/core';
import { handClock } from '@kinu.run/test-utils/hand-clock';
import { diagnostics } from '@kinu.run/core/obs';
import { sealRpcSurface, ORCHESTRATOR_RPC_SURFACE } from '../../src/rpc-surface';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import type { UserDO } from '../../src/user/user-do';
import { HIRE_CHILD_MODEL, hireControlUrl, hireModelsBaseUrl, JOB_GATE, REPORT_MARK, type ActorRow, type JobRow, type JobWatchState, type ArchiveSections, type ChildScript, type HireObservation, type LogRow, type RosterRow, type TurnCount } from './hire-shapes';
import { FIBER_RECOVERY_MAX_AGE_MS } from '../../src/fiber-recovery';

export * from '../../src/server';

export { default } from '../../src/server';






type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

const ArchiveLineSchema = v.looseObject({
  t: v.string(), agents: v.optional(v.array(v.string())), actor: v.optional(v.string()), rows: v.optional(v.number()),
});

const ChatTextSchema = v.object({
  role: v.string(),
  parts: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
});

export class HireOrchestrator extends ProductionOrchestrator {
  private readonly probeState: AgentContext;

  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, env);
    this.probeState = ctx;

    // `ActorAgent`'s constructor already sealed the surface with non-enumerable shadows over these reads;
    // deleting the shadow lets the wider seal below expose the prototype method.
    const reads = ['rosterRows', 'actorRows', 'logRows', 'turnCounts', 'driveOwedWork', 'rootActorId', 'childTranscript', 'wakeReturned', 'wakeWhileRunning', 'stopHosted', 'settled', 'archiveSections', 'jobWindowArmed', 'outrunJobWindow', 'openJobGate', 'redeliverJobWake', 'ageJobFiber', 'jobWatchState', 'jobRows'];

    for (const name of reads) Reflect.deleteProperty(this, name);

    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, ...reads]);
  }

  private readonly probeClock = handClock(Date.now());

  /** Every job runner here detaches on this clock: a window fires only when the test moves it. */
  protected override jobClock(): Clock {
    return this.probeClock;
  }

  /** Settles once `count` waits were armed on the job clock; a call's window is the first its job clock sees. */
  async jobWindowArmed(count: number): Promise<void> {
    await this.probeClock.whenArmed(count);
  }

  /** The armed window fires: the call it bounds outruns it. */
  async outrunJobWindow(): Promise<void> {
    this.probeClock.tick();
  }

  /** The job's command ends: the file it waits on now exists in the workspace's home. */
  async openJobGate(): Promise<void> {
    await this.workspaceBox(this.shellId()).files.write(JOB_GATE, 'open');
  }

  /** What a restart's fiber recovery does for a job whose fiber outlived its settle: re-deliver its wake. */
  async redeliverJobWake(jobId: string): Promise<void> {
    await this.workspaceJobs().recover({ phase: 'running', jobId, kind: 'shell' });
  }

  async ageJobFiber(jobId: string): Promise<number> {
    return this.probeState.storage.sql.exec(
      `UPDATE cf_agents_runs SET created_at = ? WHERE name LIKE 'bg:%' AND json_extract(snapshot, '$.jobId') = ?`,
      Date.now() - FIBER_RECOVERY_MAX_AGE_MS - 1_000, jobId,
    ).rowsWritten;
  }

  async jobWatchState(): Promise<JobWatchState> {
    return {
      incarnation: this.probeIncarnation,
      terminalRetry: this.probeState.storage.sql.exec(`SELECT 1 FROM cf_agents_jobs WHERE id = 'terminal-retry'`).toArray().length > 0,
      fibers: this.probeState.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM cf_agents_runs WHERE name LIKE 'bg:%'`).one().n,
      wakes: this.probeWakeCount,
      started: this.probeStarted,
      jobs: await this.jobRows(),
    };
  }

  private readonly probeIncarnation = crypto.randomUUID();
  private probeStarted = false;
  private probeWakeCount = 0;

  override async onStart(): Promise<void> {
    await super.onStart();
    this.probeStarted = true;
  }

  override onAlarm(): void {
    super.onAlarm();
    this.detachOwned(Effect.promise(async () => {
      await fetch(hireControlUrl(this.name, 'alarm-returned'), {
        method: 'POST', body: JSON.stringify(await this.jobWatchState()),
      });
    }));
  }

  async jobRows(): Promise<JobRow[]> {
    return this.probeState.storage.sql.exec<{ actor_id: string; id: string; status: string }>(
      'SELECT actor_id, id, status FROM background_jobs ORDER BY created_at').toArray()
      .map((row) => ({ actorId: row.actor_id, id: row.id, status: row.status }));
  }

  /** Read, not assumed: child counts are "not this id", and a guessed literal would count the root's rows. */
  async rootActorId(): Promise<string> {
    const rows = this.probeState.storage.sql.exec<{ actor_id: string }>(
      `SELECT actor_id FROM workspace_actors WHERE origin = 'system' LIMIT 1`).toArray();

    return rows[0]?.actor_id ?? '';
  }

  async rosterRows(): Promise<RosterRow[]> {
    const rows = this.probeState.storage.sql.exec<{
      actor_id: string; name: string; lifetime: string; status: string; task_event_id: string | null;
    }>(`SELECT actor_id, name,
        COALESCE((SELECT lifetime FROM workspace_actors
          WHERE actor_id = json_extract(actor_subordinates.actor_reference, '$.actorId')),
          json_extract(birth_request, '$.seed.lifetime')) AS lifetime,
        status, task_event_id FROM actor_subordinates ORDER BY created_at`).toArray();

    return rows.map((row) => ({
      actorId: row.actor_id, name: row.name, lifetime: row.lifetime,
      status: row.status, taskEventId: row.task_event_id,
    }));
  }

  /** A settled task hire moves only the directory, not the roster, so child assertions state which plane they read. */
  async actorRows(): Promise<ActorRow[]> {
    const rows = this.probeState.storage.sql.exec<{
      actor_id: string; name: string; parent_actor_id: string | null; retiring_at: number | null; deleted_at: number | null;
    }>(`SELECT actor_id, name, parent_actor_id, retiring_at, deleted_at
        FROM workspace_actors ORDER BY created_at`).toArray();

    return rows.map((row) => ({
      actorId: row.actor_id, name: row.name, hired: row.parent_actor_id !== null,
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

  /** Runs started per actor: the root's in this object, each subordinate's in its own database. */
  async turnCounts(): Promise<TurnCount[]> {
    const counts: TurnCount[] = this.probeState.storage.sql.exec<{ actor_id: string; runs: number }>(
      `SELECT actor_id, COUNT(DISTINCT run_id) AS runs FROM run_events
       WHERE type = 'run_start' GROUP BY actor_id`).toArray().map((row) => ({ actorId: row.actor_id, runs: row.runs }));

    const subordinates = this.probeState.storage.sql.exec<{ actor_id: string }>(
      `SELECT actor_id FROM workspace_actors WHERE origin IN ('user', 'agent', 'evolution')`).toArray();

    for (const { actor_id: actorId } of subordinates) {
      const seen = await (await this.agentFacetOf(actorId)).inspect(this.agentSnapshot(actorId), { path: [], view: 'runs', page: { limit: 100 } });

      if (seen.view === 'runs' && seen.page.items.length > 0) counts.push({ actorId, runs: seen.page.items.length });
    }

    return counts;
  }

  async archiveSections(): Promise<ArchiveSections> {
    const listed: string[] = [];
    const sections: Record<string, number> = {};
    let cursor: ArchiveCursor | undefined;

    do {
      const page = await this.exportWorkspaceArchive(cursor);

      for (const line of page.lines) {
        const record = v.parse(ArchiveLineSchema, JSON.parse(line));

        if (record.t === 'header') listed.push(...record.agents ?? []);

        if (record.t === 'agent' && record.actor !== undefined && record.rows !== undefined) sections[record.actor] = record.rows;
      }

      cursor = page.next ?? undefined;
    } while (cursor !== undefined);

    return { listed, sections };
  }

  /** The agent's chat as its pane reads it: the brief, and the answer its turn recorded. */
  async childTranscript(name: string): Promise<string[]> {
    const rows = this.probeState.storage.sql.exec<{ actor_id: string }>('SELECT actor_id FROM workspace_actors WHERE name = ?', name).toArray();
    const lines: string[] = [];

    // The chat lives in the agent's own database; read it as its pane does.
    for (const { actor_id: actorId } of rows) {
      const messages = await (await this.agentFacetOf(actorId)).history(this.agentSnapshot(actorId));

      for (const message of v.parse(v.array(ChatTextSchema), messages)) {
        for (const part of message.parts) if (part.type === 'text' && part.text !== undefined) lines.push(`${message.role}: ${part.text}`);
      }
    }

    return lines;
  }


  private readonly wakeReturn = Promise.withResolvers<void>();

  /** The platform's wake as the `terminal-retry` job dispatches it. It counts only once it returned with a child's
   *  turn still claimed, so a wake that ran before the hire, or one that ran the child to its end, cannot satisfy it. */
  override async terminalRetryPass(...args: Parameters<ProductionOrchestrator['terminalRetryPass']>): Promise<void> {
    await super.terminalRetryPass(...args);
    this.probeWakeCount++;
    this.countReturnedWake();
  }

  /** The wake's own pass, run in-request while a delegated turn is parked: it must return, not hold the turn. */
  async wakeWhileRunning(): Promise<void> {
    await this.terminalRetryPass();
  }

  private countReturnedWake(): void {
    // A subordinate's turn claim is in its own database; the workspace knows which of its turns are running.
    const inFlight = this.actorDirectoryStore().list()
      .filter((record) => isSubordinateOrigin(record.origin) && this.currentTurnOf(actorReferenceOf(record)) !== null).length;

    diagnostics.event('probe.wake_returned', { delegatedTurnsInFlight: inFlight });

    if (inFlight > 0) this.wakeReturn.resolve();
  }

  /** The owner's Stop in an actor pane: the `cancel` frame reaches the hosted room's wire as this call. */
  async stopHosted(name: string): Promise<void> {
    const resolved = await this.resolveHostedActorRoute(name);
    const wire = 'reason' in resolved ? null : this.hostedChatWire(resolved.actorId);

    if (wire === null) throw new Error(`no hosted chat wire for ${name}`);
    wire.interrupt();
  }

  /** Every delegated turn ended and every task agent its answer retired: a hirer no longer waits on either. */
  async settled(): Promise<void> {
    await this.agentTurns.idle();
    await this.delegatedTurns.idle();
    await this.settleBackgroundTasks();
  }

  /** Settles when a terminal-retry wake returned while a delegated turn was still in flight. */
  async wakeReturned(): Promise<void> {
    await this.wakeReturn.promise;
  }

  /**
   * Runs the full `terminal-retry` wake pass in-request (an in-flight request holds the input gate, so no alarm arrives).
   * A narrower frame would report hangs the product does not have. The debounced reactor drain is driven separately.
   */
  async driveOwedWork(): Promise<void> {
    await this.terminalRetryPass();
    await this.orch.drainPendingEvents({ rethrow: true });
  }
}

export { HireOrchestrator as OrchestratorAgent };


const WireLogSchema = v.looseObject({
  calls: v.array(v.looseObject({
    toolResults: v.optional(v.array(v.unknown())), lastUser: v.optional(v.string()), tools: v.optional(v.array(v.string())),
  })),
});


/** A `Pick` intersection: the full stub type instantiates too deeply to compile. */
type HireTarget = Pick<ProductionOrchestrator, 'claimOwner' | 'setModel' | 'setSoul' | 'runTaskFromMcp' | 'dismissSubordinate'>
  & Pick<HireOrchestrator,
    'rosterRows' | 'actorRows' | 'logRows' | 'turnCounts' | 'driveOwedWork' | 'rootActorId' | 'childTranscript' | 'wakeReturned' | 'wakeWhileRunning' | 'stopHosted' | 'settled' | 'archiveSections'
    | 'jobWindowArmed' | 'outrunJobWindow' | 'openJobGate' | 'redeliverJobWake' | 'ageJobFiber' | 'jobWatchState' | 'jobRows'>;

/** `durableObjects` installs `HireOrchestrator` under the `OrchestratorAgent` name, so every stub carries the fixture reads. */
interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<HireOrchestrator>;
}

type OwnerTarget = Pick<UserDO,
  'registerWorkspace' | 'ensureWorkspaceCapability' | 'setCredential' | 'getProfileCatalog' | 'putProfileCatalog'>;

export class HireProbeRoot extends Agent<ProbeRootEnv> {

  private target(workspace: string): Promise<HireTarget> {
    return getAgentByName<ProbeEnv, HireOrchestrator>(this.env.OrchestratorAgent, workspace);
  }

  private owner(name: string): OwnerTarget {
    return this.env.UserDO.get(this.env.UserDO.idFromName(name));
  }

  async setup(workspace: string, model: string, script: ChildScript): Promise<void> {
    await fetch(hireControlUrl(workspace, 'reset'), {
      method: 'POST', body: JSON.stringify({ script }),
    });

    const target = await this.target(workspace);
    const caller = await ownerCaller(this.env);
    const userDO = this.owner(`${workspace}-owner`);

    await userDO.registerWorkspace(caller, workspace, 'Hire Probe');

    const claim = await target.claimOwner(`${workspace}-owner`);

    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    await userDO.setCredential(caller, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: hireModelsBaseUrl(workspace), apiKey: 'hire-fixture-key',
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
    await fetch(hireControlUrl(this.name, 'release-child'), { method: 'POST' });
  }

  /** Settles when the child's turn reached the model wire. */
  async childSpoke(): Promise<void> {
    await fetch(hireControlUrl(this.name, 'child-spoke'));
  }

  async modelSaw(workspace: string, texts: readonly string[]): Promise<void> {
    const url = new URL(hireControlUrl(workspace, 'saw'));

    for (const text of texts) url.searchParams.append('text', text);

    await fetch(url);
  }

  async restartAlarm(workspace: string, exclude: string): Promise<JobWatchState> {
    const url = new URL(hireControlUrl(workspace, 'restart-alarm'));
    url.searchParams.set('exclude', exclude);

    const response = await fetch(url);

    return await response.json();
  }

  /** Settles when the caller's own `agents` call resolved into its next model
   *  request — the caller observing its answer. */
  async callerObserved(): Promise<void> {
    await fetch(hireControlUrl(this.name, 'root-saw'));
  }

  async stopChild(workspace: string): Promise<void> {
    const target = await this.target(workspace);
    const [child] = await target.rosterRows();

    if (child === undefined) throw new Error('no hired child to stop');
    await target.stopHosted(child.name);
  }

  /** The owner's Dismiss of `name` with its history kept, answered as the roster menu reads it. */
  async dismissAnswer(workspace: string, name: string): Promise<string> {
    return JSON.stringify(await (await this.target(workspace)).dismissSubordinate(name, true));
  }

  /** The owner's Dismiss with its history kept, as the roster menu calls it. */
  async dismissChild(workspace: string): Promise<string> {
    const target = await this.target(workspace);
    const [child] = await target.rosterRows();

    if (child === undefined) throw new Error('no hired child to dismiss');

    return (await target.dismissSubordinate(child.name, true)).name;
  }

  async settled(workspace: string): Promise<void> {
    await (await this.target(workspace)).settled();
  }

  async wakeReturned(workspace: string): Promise<void> {
    const target = await this.target(workspace);

    // A hirer's turn ends at once now, so no later wake comes on its own while the child parks: drive one.
    await target.wakeWhileRunning();
    await target.wakeReturned();
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

  async archiveSections(workspace: string): Promise<ArchiveSections> {
    return await (await this.target(workspace)).archiveSections();
  }

  async jobWindowArmed(workspace: string, count: number): Promise<void> {
    await (await this.target(workspace)).jobWindowArmed(count);
  }

  async outrunJobWindow(workspace: string): Promise<void> {
    await (await this.target(workspace)).outrunJobWindow();
  }

  async openJobGate(workspace: string): Promise<void> {
    await (await this.target(workspace)).openJobGate();
  }

  async redeliverJobWake(workspace: string, jobId: string): Promise<void> {
    await (await this.target(workspace)).redeliverJobWake(jobId);
  }

  async ageJobFiber(workspace: string, jobId: string): Promise<number> {
    return await (await this.target(workspace)).ageJobFiber(jobId);
  }

  async jobWatchState(workspace: string): Promise<JobWatchState> {
    return await (await this.target(workspace)).jobWatchState();
  }

  async jobRows(workspace: string): Promise<JobRow[]> {
    return await (await this.target(workspace)).jobRows();
  }

  async observe(workspace: string): Promise<HireObservation> {
    const target = await this.target(workspace);
    const rootActorId = await target.rootActorId();
    const roster = await target.rosterRows();
    const actors = await target.actorRows();
    const log = await target.logRows();
    const turns = await target.turnCounts();
    const response = await fetch(hireControlUrl(workspace, 'log'));

    const wire = v.parse(
      v.fallback(WireLogSchema, { calls: [] }),
      await response.json(),
    );

    const toolResults: string[] = [];
    const reports: string[] = [];
    const rootReports: string[] = [];

    for (const call of wire.calls) {
      for (const result of call.toolResults ?? []) {
        if (v.is(v.string(), result)) toolResults.push(result);
      }

      if (call.lastUser?.includes(REPORT_MARK) !== true) continue;
      reports.push(call.lastUser);

      if (call.tools?.includes('report') !== true) rootReports.push(call.lastUser);
    }

    const transcript: string[] = [];

    for (const row of roster) transcript.push(...await target.childTranscript(row.name));

    return { rootActorId, roster, actors, log, turns, toolResults, reports, rootReports, transcript };
  }
}
