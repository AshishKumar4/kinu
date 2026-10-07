/**
 * The production UserDO's device chokepoint in workerd, against a machine the test plays over a real socket: the
 * account pairs the machine and binds a workspace to it, and each call below is the production method a workspace or
 * the owner reaches. The probe adds only the identities a test cannot mint from outside and the ledger reads. A hosted
 * workspace is the production one, its turn parked at its model call on the fake's queue hold, so a Stop meets a turn
 * that is really running. Bound as this script's `UserDO`, so that workspace reaches this very object.
 */
import { getAgentByName, type AgentContext } from 'agents';
import * as v from 'valibot';
import {
  DEVICE_CANCEL_METHOD, commitWorkspaceCapability, freshWorkspaceCapability, ownerCaller,
  type DeviceConsentAnswer, type SqlExec, type SqlValue, type UserCaller,
} from '@kinu.run/core';
import type { OrchestratorAgent } from '../../src/orchestrator';
import { renderThrownChain } from '@kinu.run/core/obs';
import { USER_DO_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type { DeviceCancellationOutcome } from '../../src/user/devices';
import { UserDO } from '../../src/user/user-do';

export * from '../../src/server';

const PROBE_METHODS = [
  'pair', 'bindWorkspace', 'admit', 'run', 'cancelOwn', 'stopTurn', 'acknowledge', 'withdrawConsent', 'answerConsent', 'revoke', 'requests',
  'unstoppedSince', 'hostWorkspace', 'startParkedTurn', 'runOnMachine', 'stopWork', 'pendingConsents', 'releaseTurn',
];

/** The fake models' control host and the credential that routes a pinned model to them (`http-model-fake.ts`). */
const MODEL_CONTROL = 'http://probe-control.invalid';

const FIXTURE_CREDENTIAL = { kind: 'openai-compat', baseURL: 'http://fake-models.invalid/v1', apiKey: 'probe-fixture-key' } as const;

/** Each look at the workspace's prompts is an RPC hop, never a clock; this many and the prompt never came. */
const CONSENT_LOOKS = 10_000;

type ProbeEnv = ConstructorParameters<typeof UserDO>[1];

type ConsentTarget = Pick<OrchestratorAgent,
  'claimOwner' | 'listPendingConsents' | 'resolveDeviceConsent' | 'setModel' | 'runTaskFromMcp' | 'executeInExecutor' | 'cancelCurrentWork'
  | 'onModelSettingsChanged'>;

export interface InflightRow {
  readonly requestId: string;
  readonly turnId: string | null;
  readonly outcome: string | null;
  readonly claim: string | null;
}

/** Null once `call` has answered, or how it failed. */
async function settled(call: Promise<unknown>): Promise<string | null> {
  try {
    await call;

    return null;
  } catch (cause) {
    return renderThrownChain({ cause });
  }
}

export class DeviceUserProbeDO extends UserDO {
  /** Each bound workspace's own identity, as the workspace holds it; one activation per test. */
  private readonly callers = new Map<string, UserCaller>();

  /** The parked turn's whole run: an MCP task's call answers only once its turn has ended. */
  private parked: Promise<string | null> | null = null;

  constructor(ctx: AgentContext, env: ConstructorParameters<typeof UserDO>[1]) {
    super(ctx, env);

    for (const name of PROBE_METHODS) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...USER_DO_RPC_SURFACE, ...PROBE_METHODS]);
  }

  /** Registers a machine and answers the ticket its daemon connects with. */
  async pair(label: string): Promise<{ deviceId: string; ticket: string }> {
    const owner = await ownerCaller(this.env);
    const { deviceId, token } = await this.registerDevice(owner, label);
    const issued = await this.issueDeviceConnectTicket(owner, token);

    if (!issued.ok || issued.ticket === undefined) throw new Error('the paired machine was issued no connect ticket');

    return { deviceId, ticket: issued.ticket };
  }

  /** A workspace this account owns, holding its identity, whose owner let it use `deviceId` always. */
  async bindWorkspace(workspace: string, deviceId: string): Promise<void> {
    await this.registerWorkspace(await ownerCaller(this.env), workspace, workspace);
    await (await this.workspaceTarget(workspace)).claimOwner(this.name);
    const { token, tokenHash } = await freshWorkspaceCapability();

    commitWorkspaceCapability(this.probeSql, workspace, tokenHash);
    this.callers.set(workspace, { workspaceToken: token });
    this.ctx.storage.sql.exec(
      `INSERT INTO device_consent (agent_name, device_id, policy, updated_at) VALUES (?, ?, 'allow', ?)`, workspace, deviceId, Date.now(),
    );
  }

  /** A production workspace this account owns, holding the identity the account issued it, on the fake's held model. */
  async hostWorkspace(workspace: string, deviceId: string): Promise<void> {
    const owner = await ownerCaller(this.env);
    const target = await this.workspaceTarget(workspace);

    await this.setCredential(owner, 'openai-compat.default', FIXTURE_CREDENTIAL);
    await this.registerWorkspace(owner, workspace, workspace);
    const claim = await target.claimOwner(this.name);

    await this.ensureWorkspaceCapability(workspace, claim.capabilityHash);
    // As the credential route tells a live workspace, so its next model read sees the fake's models.
    await target.onModelSettingsChanged();
    const pinned = await target.setModel('openai-compat/probe-queue');

    if (!pinned.ok) throw new Error(`the workspace refused the held model: ${JSON.stringify(pinned)}`);
    this.ctx.storage.sql.exec(
      `INSERT INTO device_consent (agent_name, device_id, policy, updated_at) VALUES (?, ?, 'allow', ?)`, workspace, deviceId, Date.now(),
    );
  }

  /** Opens a turn on `workspace` and answers once its model was asked `text`, the call the hold parks. */
  async startParkedTurn(workspace: string, text: string): Promise<void> {
    await this.control('/queue/hold', 'POST');
    const target = await this.workspaceTarget(workspace);

    // Not awaited here: the task's call settles with its turn, which the hold keeps open.
    this.parked = settled(target.runTaskFromMcp(text));
    await this.control(`/log/until?marker=${encodeURIComponent(text)}`, 'GET');
  }

  /** Lets the parked turn answer, and answers once it has ended. */
  async releaseTurn(): Promise<void> {
    await this.control('/queue/release', 'POST');
    const ended = await this.parked;

    this.parked = null;

    if (ended !== null && ended !== undefined) throw new Error(`the parked turn failed: ${ended}`);
  }

  /** A command the workspace runs on the owner's machine, as its executor route reaches it. */
  async runOnMachine(workspace: string, command: string): Promise<string> {
    return JSON.stringify(await (await this.workspaceTarget(workspace)).executeInExecutor('device', command));
  }

  /** The composer's Stop on the workspace: what it reports of each command on the machine. */
  async stopWork(workspace: string): Promise<Array<{ requestId?: string; outcome: string; detail?: string }>> {
    return [...(await (await this.workspaceTarget(workspace)).cancelCurrentWork()).deviceCommands];
  }

  async pendingConsents(workspace: string): Promise<number> {
    return (await (await this.workspaceTarget(workspace)).listPendingConsents()).length;
  }

  /** A command row as a dispatch leaves it, with no call behind it: what a far end's misanswer is tested against. */
  admit(requestId: string, deviceId: string, workspace: string, turnId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id) VALUES (?, ?, ?, ?)`,
      requestId, deviceId, workspace, turnId,
    );
  }

  /** A command the workspace's turn `turnId` runs on the machine; settles with the machine's answer. */
  run(workspace: string, requestId: string, turnId: string, command: string): Promise<string | undefined> {
    return this.deviceRpc(this.callerOf(workspace), 'exec', [command], {
      agentName: workspace, requestId, checkpoint: { agent: workspace, turnId, sessionId: 'probe-session', dir: null },
    });
  }

  /** The tool's own abort path: the workspace cancels one of its requests itself. */
  cancelOwn(workspace: string, requestId: string): Promise<string | undefined> {
    return this.deviceRpc(this.callerOf(workspace), DEVICE_CANCEL_METHOD, [requestId], { agentName: workspace });
  }

  /** The composer's Stop, as the workspace sweeps its turn. */
  stopTurn(workspace: string, turnId: string): Promise<DeviceCancellationOutcome[]> {
    return this.cancelDeviceRequestsForTurn(this.callerOf(workspace), turnId);
  }

  acknowledge(workspace: string, requestId: string): Promise<void> {
    return this.acknowledgeDeviceRequest(this.callerOf(workspace), requestId);
  }

  async withdrawConsent(workspace: string, deviceId: string): Promise<{ ok: boolean }> {
    return this.revokeDeviceConsent(await ownerCaller(this.env), workspace, deviceId);
  }

  /** The owner's answer on the workspace's consent card, once the workspace raised one. */
  async answerConsent(workspace: string, decision: DeviceConsentAnswer): Promise<void> {
    const target = await this.workspaceTarget(workspace);

    for (let look = 0; look < CONSENT_LOOKS; look += 1) {
      const [pending] = await target.listPendingConsents();

      if (pending !== undefined) {
        await target.resolveDeviceConsent(pending.consentId, decision);

        return;
      }
    }

    throw new Error(`${workspace} raised no consent card`);
  }

  async revoke(deviceId: string): Promise<{ ok: boolean; unstoppedCommands?: number }> {
    return this.revokeDevice(await ownerCaller(this.env), deviceId);
  }

  requests(): InflightRow[] {
    return this.ctx.storage.sql.exec(
      'SELECT request_id, turn_id, cancel_outcome, cancel_claim FROM device_inflight_requests ORDER BY request_id',
    ).toArray().map((row) => ({
      requestId: v.parse(v.string(), row.request_id),
      turnId: v.parse(v.nullable(v.string()), row.turn_id),
      outcome: v.parse(v.nullable(v.string()), row.cancel_outcome),
      claim: v.parse(v.nullable(v.string()), row.cancel_claim),
    }));
  }

  unstoppedSince(deviceId: string): number | null {
    const [row] = this.ctx.storage.sql.exec('SELECT unstopped_at FROM user_devices WHERE id = ?', deviceId).toArray();

    return row === undefined ? null : v.parse(v.nullable(v.number()), row.unstopped_at);
  }

  private async control(path: string, method: 'GET' | 'POST'): Promise<void> {
    const response = await fetch(`${MODEL_CONTROL}${path}`, { method });

    if (!response.ok) throw new Error(`probe-control refused ${path}: ${String(response.status)}`);
  }

  private workspaceTarget(workspace: string): Promise<ConsentTarget> {
    return getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, workspace);
  }

  private callerOf(workspace: string): UserCaller {
    const caller = this.callers.get(workspace);

    if (caller === undefined) throw new Error(`${workspace} was never bound to a machine`);

    return caller;
  }

  // SAFETY: the positional protocol `UserDO.sqlx` hands its stores; DO SQLite binds the same values.
  private readonly probeSql: SqlExec = {
    exec: (query: string, ...bindings: SqlValue[]) => {
      const cursor = this.ctx.storage.sql.exec(query, ...bindings);

      return { toArray: () => cursor.toArray() };
    },
  };
}

export { DeviceUserProbeDO as UserDO };
