/**
 * `/api/control/*` at route altitude: "every mutation is audited before it runs" is an ordering
 * inside one handler that a store test cannot see. Only the transport is stood in for.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AuthIdentity } from '../src/auth/session';
import type { AccessIdentity } from '../src/control-plane/access-gate';
import * as store from '@kinu.run/core/control-plane';
import * as feedbackStore from '@kinu.run/core/control-plane';
import type { ControlCapability, PresentedCaller } from '@kinu.run/core/control-plane';
import * as v from 'valibot';
import {
  CACHE_HIT_EMA_ALPHA, JsonValueSchema,
  type ActivitySnapshot, type ApprovalGrant, type DeferredApprovalAnswer, type JsonValue,
  type UserCaller,
} from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { sqlExec } from './helpers/user-do';
import type { ControlEnv } from '../src/control-plane/routes';
import type { WorkspaceEntry } from '../src/user/user-do';

mockAgentsSdk();

// `routes.ts` reaches the orchestrator's module graph at load: import it after the mock is
// registered.
const { handleControlRequest: routeControlRequest } = await import('../src/control-plane/routes');

const { requireControl } = await import('@kinu.run/core/control-plane');

type ControlRoutesEnv = ControlEnv<string>;

const SECRET = 'routes-test-secret-0123456789';

const OPERATOR = 'ops@kinu.run';

const USER_ID = 'a'.repeat(32);

const OTHER_ID = 'b'.repeat(32);

interface RpcLog {
  calls: { workspace: string; method: string; args: unknown[] }[];
}

interface Harness {
  env: ControlRoutesEnv;
  sql: ReturnType<typeof sqlExec>;
  rpc: RpcLog;
  removed: { userId: string; workspace: string }[];
  close: () => void;
}

interface WorkspaceBehaviour {
  cancel?: { ok: boolean };
  retry?: { ok: boolean; jobId?: string; error?: string };
  grants?: { grants: ApprovalGrant[] };
  clear?: { ok: boolean };
  decided?: string[];
  throws?: string;
}

/** `append` breaks the store before the action; `settle` after. */
type AuditFault = 'append' | 'settle';

interface World {
  admins?: string;
  behaviour?: WorkspaceBehaviour;
  rosterError?: string;
  rosters?: Record<string, WorkspaceEntry[]>;
  owners?: Record<string, string>;
  audit?: AuditFault;
}

function roster(...names: string[]): WorkspaceEntry[] {
  return names.map((name, index) => ({
    name, displayName: name, createdAt: 100 + index, lastVisited: 900 - index, archivedAt: null,
  }));
}

/** The real empty-log shape: the drilldown hands it back whole, so a stand-in would let
 *  contracts drift. */
function unrunActivity(): ActivitySnapshot {
  return {
    latest: null,
    contextWindow: null,
    telemetry: {
      steps: 0,
      windowLimit: 0,
      tokens: {},
      cacheHit: {
        samples: 0, last: null, mean: null, p95: null, p99: null, ema: null,
        emaAlpha: CACHE_HIT_EMA_ALPHA, warms: 0,
      },
      usd: 0,
      pricedSteps: 0,
      unpricedSteps: 0,
      stepsWithoutUsage: 0,
    },
    spend: {
      producers: [],
      total: { calls: 0, callsWithoutUsage: 0, usage: {}, unpricedCalls: 0, floorPricedCalls: 0 },
      coverage: { calls: 0, measured: 0, reported: null, silent: [], partial: [] },
      offTurnShare: null,
      missions: [],
      accounts: [],
    },
    log: [],
  };
}

function harness(options: World = {}): Harness {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  store.initControlPlaneSchema(sql);
  const rpc: RpcLog = { calls: [] };
  const removed: { userId: string; workspace: string }[] = [];
  const behaviour = options.behaviour ?? {};
  const rosters = new Map(Object.entries(options.rosters ?? { [USER_ID]: roster('alpha') }));
  const owners = new Map(Object.entries(options.owners ?? { alpha: USER_ID }));

  // The capability gate is the production one, so a route that forgot to authorize is refused here
  // too.
  const controlPlane = {
    async observeUser(caller: PresentedCaller, observation: store.UserObservation) {
      await gate(caller, 'index.observe'); store.observeUser(sql, observation);
    },
    async observeWorkspace(caller: PresentedCaller, observation: store.WorkspaceObservation) {
      await gate(caller, 'index.workspace'); store.observeWorkspace(sql, observation);
    },
    async forgetWorkspace(caller: PresentedCaller, target: { userId: string; name: string }) {
      await gate(caller, 'index.forget'); store.forgetWorkspace(sql, target);
    },
    async replaceUserWorkspaces(
      caller: PresentedCaller, userId: string, live: readonly store.RosterWorkspace[],
    ) {
      await gate(caller, 'index.reconcile');

      return store.replaceUserWorkspaces(sql, userId, live);
    },
    async overview(caller: PresentedCaller) {
      await gate(caller, 'overview.read');

      return store.overview(sql);
    },
    async listUsers(caller: PresentedCaller, request = {}) {
      await gate(caller, 'users.read');

      return store.listUsers(sql, request);
    },
    async getUser(caller: PresentedCaller, userId: string) {
      await gate(caller, 'users.read');

      return store.getUser(sql, userId);
    },
    async listWorkspaces(caller: PresentedCaller, request = {}, filter = {}) {
      await gate(caller, 'workspaces.read');

      return store.listWorkspaces(sql, request, filter);
    },
    async listFeedback(caller: PresentedCaller, request = {}) {
      await gate(caller, 'feedback.read');

      return feedbackStore.listFeedback(sql, request);
    },
    async listAudit(caller: PresentedCaller, request = {}) {
      await gate(caller, 'audit.read');

      return store.listAudit(sql, request);
    },
    async recordAudit(caller: PresentedCaller, entry: store.AuditDraft) {
      await gate(caller, 'audit.write');

      if (options.audit === 'append') throw new Error('the control plane is unreachable');

      return store.appendAudit(sql, entry);
    },
    async settleAudit(
      caller: PresentedCaller,
      settlement: { id: string; outcome: store.AuditSettlement; detail: string },
    ) {
      await gate(caller, 'audit.write');

      if (options.audit === 'settle') throw new Error('the control plane is unreachable');
      const row = store.settleAudit(sql, settlement);

      if (row === null) throw new Error(`no pending audit row ${settlement.id}`);

      return row;
    },
    /** No admin route writes this row: the feed is reached from the Worker's ownership gate. */
    touchWorkspace(): Promise<void> {
      throw new Error('ControlPlaneDO.touchWorkspace: not reachable in this test');
    },
  };

  const emptyListStub = (workspace: string, method: string) => async () => {
    rpc.calls.push({ workspace, method, args: [] });

    return [];
  };

  const workspaceStub = (name: string) => ({
    // As `OrchestratorAgent` implements it: unclaimed accepts the first claimant, claimed refuses
    // others.
    async claimOwner(userId: string) {
      rpc.calls.push({ workspace: name, method: 'claimOwner', args: [userId] });
      const current = owners.get(name);

      if (current === undefined) {
        owners.set(name, userId);

        return { owner: userId, capabilityHash: null };
      }

      if (current !== userId) {
        throw new Error(
          `Agent owned by a different user (stored=${current.slice(0, 8)}…, caller=${userId.slice(0, 8)}…)`,
        );
      }

      return { owner: current, capabilityHash: null };
    },
    async cancelBackgroundJob(jobId: string) {
      if (behaviour.throws) throw new Error(behaviour.throws);
      rpc.calls.push({ workspace: name, method: 'cancelBackgroundJob', args: [jobId] });

      return behaviour.cancel ?? { ok: true };
    },
    async retryBackgroundJob(jobId: string) {
      rpc.calls.push({ workspace: name, method: 'retryBackgroundJob', args: [jobId] });

      return behaviour.retry ?? { ok: true, jobId };
    },
    async dismissBackgroundJob(jobId: string) {
      rpc.calls.push({ workspace: name, method: 'dismissBackgroundJob', args: [jobId] });

      return { ok: true };
    },
    async clearBackgroundJobs() {
      rpc.calls.push({ workspace: name, method: 'clearBackgroundJobs', args: [] });

      return behaviour.clear ?? { ok: true };
    },
    async decideDeferredApprovals(ids: string[], decision: DeferredApprovalAnswer) {
      rpc.calls.push({ workspace: name, method: 'decideDeferredApprovals', args: [ids, decision] });

      return { decided: behaviour.decided ?? ids };
    },
    async getShellApprovalGrants() {
      rpc.calls.push({ workspace: name, method: 'getShellApprovalGrants', args: [] });

      return behaviour.grants ?? { grants: [{ rule: 'git', executor: 'workspace' }] };
    },
    async revokeShellApprovalGrants(grants: ApprovalGrant[]) {
      rpc.calls.push({ workspace: name, method: 'revokeShellApprovalGrants', args: [grants] });

      return { grants: [] };
    },
    async getRunSummaries() {
      rpc.calls.push({ workspace: name, method: 'getRunSummaries', args: [] });

      return { status: 'end' as const, items: [] };
    },
    async getActivitySnapshot() {
      rpc.calls.push({ workspace: name, method: 'getActivitySnapshot', args: [] });

      return unrunActivity();
    },
    listBackgroundJobs: emptyListStub(name, 'listBackgroundJobs'),
    listDeferredApprovals: emptyListStub(name, 'listDeferredApprovals'),
    listPendingConsents: emptyListStub(name, 'listPendingConsents'),
    async getExecutors() {
      rpc.calls.push({ workspace: name, method: 'getExecutors', args: [] });
      throw new Error('the sandbox is not reachable');
    },
  });

  const userStub = (userId: string) => ({
    async hasWorkspace(_caller: UserCaller, name: string) {
      return (rosters.get(userId) ?? []).some((row) => row.name === name);
    },
    async ensureWorkspaceCapability(name: string, _hash: string | null) {
      if (!(rosters.get(userId) ?? []).some((row) => row.name === name)) {
        throw new Error(`Workspace ${name} not in your registry`);
      }
    },
    async listWorkspaces() {
      if (options.rosterError) throw new Error(options.rosterError);
      const entries = rosters.get(userId) ?? [];

      return { entries, total: entries.length, nextCursor: null };
    },
    async removeWorkspace(_caller: UserCaller, workspace: string, owner: string) {
      // `UserDO.removeWorkspace` tears the object down first; a teardown failure keeps the registry
      // row
      // (fail-closed).
      const stored = owners.get(workspace);
      rpc.calls.push({ workspace, method: 'destroyAgent', args: [owner] });

      if (stored !== owner) throw new Error('Agent owner mismatch; refusing to destroy.');
      owners.delete(workspace);
      rosters.set(userId, (rosters.get(userId) ?? []).filter((row) => row.name !== workspace));
      removed.push({ userId: owner, workspace });
    },
  });

  const namespace = <Value>(resolve: (name: string) => Value) => ({
    idFromName: (name: string) => name,
    get: (name: string) => resolve(name),
  });

  const env: ControlRoutesEnv = {
    CREDENTIAL_ENCRYPTION_KEY: SECRET,
    CONTROL_PLANE_ADMINS: options.admins ?? OPERATOR,
    ControlPlaneDO: namespace(() => controlPlane),
    OrchestratorAgent: namespace(workspaceStub),
    UserDO: namespace(userStub),
    MonitorDO: namespace(() => ({
      async listIncidents() {
        return [{ probe: 'health', detail: 'not 200', openedAt: 1, alertedAt: null, failures: 3 }];
      },
    })),
  };

  return { env, sql, rpc, removed, close: () => db.close() };
}

/** The production gate, so the harness cannot be more permissive than the deployed object. */
async function gate(caller: PresentedCaller, capability: ControlCapability): Promise<void> {
  await requireControl({ CREDENTIAL_ENCRYPTION_KEY: SECRET }, caller, capability);
}

function identity(over: Partial<AuthIdentity> = {}): AuthIdentity {
  return {
    userId: USER_ID, email: OPERATOR, sub: 'sub-1', provider: 'github',
    authTime: Date.now(), ...over,
  };
}

/** Defaults to the same address `identity()` carries, so inner-gate assertions are not answered
 *  by a mismatch. */
function access(over: Partial<AccessIdentity> = {}): AccessIdentity {
  return { email: OPERATOR, sub: 'access-uuid-1', ...over };
}

function handleControlRequest(
  request: Request,
  env: ControlRoutesEnv,
  who: AuthIdentity,
  outer: AccessIdentity = access(),
): Promise<Response | null> {
  return routeControlRequest(request, env, who, outer);
}

function get(path: string): Request {
  return new Request(`https://kinu.run/api/control${path}`);
}

function post(path: string, body: JsonValue): Request {
  return new Request(`https://kinu.run/api/control${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/** A `null` means the route declined a path it owns: a failure, not something to assert away. */
function answered(response: Response | null): Response {
  if (response === null) throw new Error('the control plane declined a path it owns');

  return response;
}

async function bodyOf(response: Response | null): Promise<JsonValue> {
  return v.parse(JsonValueSchema, await answered(response).json());
}

describe('the gate, over HTTP', () => {
  test('a path outside the control plane is declined, not answered', async () => {
    const h = harness();

    const answer = await handleControlRequest(
      new Request('https://kinu.run/api/user/profile'), h.env, identity(),
    );

    expect(answer).toBe(null);
    h.close();
  });

  test('an ordinary signed-in user gets a 404 and no data', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/users'), h.env, identity({ email: 'nobody@example.com' }));
    expect(answer?.status).toBe(404);
    expect(await bodyOf(answer)).toEqual({ error: 'Not found' });
    h.close();
  });

  test('a dev-synthesized identity is refused even when allowlisted', async () => {
    const h = harness({ admins: 'eval-service@kinu.run' });

    const answer = await handleControlRequest(
      get('/overview'), h.env, identity({ email: 'eval-service@kinu.run', provider: 'dev' }),
    );

    expect(answer?.status).toBe(404);
    h.close();
  });

  test('an unconfigured deployment says so instead of pretending the route is absent', async () => {
    const h = harness();
    const unconfigured: ControlRoutesEnv = { ...h.env, CREDENTIAL_ENCRYPTION_KEY: '' };
    const answer = await handleControlRequest(get('/overview'), unconfigured, identity());
    expect(answer?.status).toBe(503);
    h.close();
  });

  test('an operator reads the overview', async () => {
    const h = harness();
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });
    const answer = await handleControlRequest(get('/overview'), h.env, identity());
    expect(answer?.status).toBe(200);
    expect(await bodyOf(answer)).toMatchObject({ users: 1, workspaces: 0 });
    h.close();
  });

  test('an unknown control path is a 404 even for an operator', async () => {
    const h = harness();
    expect((await handleControlRequest(get('/nope'), h.env, identity()))?.status).toBe(404);
    expect((await handleControlRequest(
      new Request('https://kinu.run/api/control/overview', { method: 'DELETE' }), h.env, identity(),
    ))?.status).toBe(405);
    h.close();
  });

  test('an Access identity that is not the session identity is refused, and reads nothing', async () => {
    // Both gates valid but different people: what a borrowed session cookie looks like. Must
    // refuse.
    const h = harness();
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });

    const answer = await handleControlRequest(
      get('/overview'), h.env, identity(), access({ email: 'someone-else@kinu.run' }),
    );

    expect(answer?.status).toBe(404);
    expect(await bodyOf(answer)).toEqual({ error: 'Not found' });
    h.close();
  });

  test('an Access identity for a non-operator is still refused by the allowlist', async () => {
    // Access is an outer gate, never a substitute for the allowlist.
    const h = harness();

    const answer = await handleControlRequest(
      get('/overview'), h.env, identity({ email: 'colleague@kinu.run' }),
      access({ email: 'colleague@kinu.run' }),
    );

    expect(answer?.status).toBe(404);
    h.close();
  });

  test('a mutation still needs a fresh sign-in when both gates name the operator', async () => {
    // The step-up window is this deployment's own, shorter than an Access session: an assertion
    // must not satisfy it.
    const h = harness();

    const answer = await handleControlRequest(
      post('/actions', { action: 'jobs.clear', userId: USER_ID, workspace: 'alpha' }),
      h.env, identity({ authTime: Date.now() - 6 * 60 * 1000 }), access(),
    );

    expect(answer?.status).toBe(403);
    expect(h.rpc.calls).toEqual([]);
    h.close();
  });
});

describe('mutations', () => {
  test('a stale sign-in is refused AND audited', async () => {
    const h = harness();
    const stale = identity({ authTime: Date.now() - 6 * 60 * 1000 });

    const answer = await handleControlRequest(
      post('/actions', { action: 'jobs.clear', userId: USER_ID, workspace: 'alpha' }), h.env, stale,
    );

    expect(answer?.status).toBe(403);
    expect(h.rpc.calls).toEqual([]);
    const audit = store.listAudit(h.sql).items;
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      operation: 'jobs_clear', outcome: 'denied', actorEmail: OPERATOR,
      detail: 'refused: the sign-in was not fresh',
    });
    h.close();
  });

  test('a body the schema does not recognize is refused AND audited', async () => {
    const h = harness();

    const answer = await handleControlRequest(
      post('/actions', { action: 'setModel', userId: USER_ID, workspace: 'alpha', model: 'anything' }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(400);
    expect(h.rpc.calls).toEqual([]);
    expect(store.listAudit(h.sql).items[0]).toMatchObject({
      operation: 'action_rejected', outcome: 'denied', targetKind: 'request',
    });
    h.close();
  });

  test('a fresh operator action reaches the existing RPC and is audited as ok', async () => {
    const h = harness();

    const answer = await handleControlRequest(
      post('/actions', { action: 'job.cancel', userId: USER_ID, workspace: 'alpha', jobId: 'job-7' }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(200);
    // Proxied to the owner UI's own callable, only after the workspace object confirmed ownership.
    expect(h.rpc.calls.map((c) => c.method)).toEqual(['claimOwner', 'cancelBackgroundJob']);
    expect(store.listAudit(h.sql).items[0]).toMatchObject({
      operation: 'job_cancel', targetKind: 'job', target: `${USER_ID}/alpha/job-7`, outcome: 'ok',
    });
    h.close();
  });

  test('a refusal by the owning object is a 409, and its reason is the audited detail', async () => {
    const h = harness({ behaviour: { retry: { ok: false, error: 'that job already succeeded' } } });

    const answer = await handleControlRequest(
      post('/actions', { action: 'job.retry', userId: USER_ID, workspace: 'alpha', jobId: 'job-7' }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(409);
    expect(store.listAudit(h.sql).items[0]).toMatchObject({
      operation: 'job_retry', outcome: 'denied', detail: 'that job already succeeded',
    });
    h.close();
  });

  test('a throwing RPC is a 502 audited as failed, kept apart from a refusal', async () => {
    const h = harness({ behaviour: { throws: 'the workspace is evicted' } });

    const answer = await handleControlRequest(
      post('/actions', { action: 'job.cancel', userId: USER_ID, workspace: 'alpha', jobId: 'job-7' }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(502);
    const row = store.listAudit(h.sql).items[0];
    expect(row?.outcome).toBe('failed');
    // The analytics sink gets a closed word, covered by `unit-analytics-plane`.
    expect(row?.detail).toContain('the workspace is evicted');
    h.close();
  });

  test('revoking shell grants reads them first, so the audited count is real', async () => {
    const grants = [{ rule: 'git', executor: 'workspace' }, { rule: 'npm', executor: 'sandbox' }];
    const h = harness({ behaviour: { grants: { grants } } });
    await handleControlRequest(
      post('/actions', { action: 'shell_grants.revoke', userId: USER_ID, workspace: 'alpha' }),
      h.env, identity(),
    );
    expect(h.rpc.calls.map((c) => c.method)).toEqual([
      'claimOwner', 'getShellApprovalGrants', 'revokeShellApprovalGrants',
    ]);
    expect(store.listAudit(h.sql).items[0]?.detail).toBe('revoked 2, 0 remain');
    h.close();
  });

  test('revoking nothing is a refusal, not an "ok" with nothing revoked', async () => {
    const h = harness({ behaviour: { grants: { grants: [] } } });

    const answer = await handleControlRequest(
      post('/actions', { action: 'shell_grants.revoke', userId: USER_ID, workspace: 'alpha' }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(409);
    expect(h.rpc.calls.map((c) => c.method)).toEqual(['claimOwner', 'getShellApprovalGrants']);
    expect(store.listAudit(h.sql).items[0]?.outcome).toBe('denied');
    h.close();
  });

  test('removing a workspace needs the name retyped, and the refusal is audited', async () => {
    const h = harness({ rosters: { [OTHER_ID]: roster('alpha') }, owners: { alpha: OTHER_ID } });

    const answer = await handleControlRequest(
      post('/actions', {
        action: 'workspace.remove', workspace: 'alpha', userId: OTHER_ID, confirm: 'alpha-typo',
      }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(409);
    expect(h.removed).toEqual([]);
    expect(h.rpc.calls).toEqual([]);
    expect(store.listAudit(h.sql).items[0]).toMatchObject({
      operation: 'workspace_remove', outcome: 'denied', detail: 'the typed name did not match',
    });
    h.close();
  });

  test('a confirmed removal proxies to the registry and tombstones the index', async () => {
    const h = harness({ rosters: { [OTHER_ID]: roster('alpha') }, owners: { alpha: OTHER_ID } });
    store.observeWorkspace(h.sql, { userId: OTHER_ID, name: 'alpha', displayName: 'Alpha', at: 1_000 });

    const answer = await handleControlRequest(
      post('/actions', {
        action: 'workspace.remove', workspace: 'alpha', userId: OTHER_ID, confirm: 'alpha',
      }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(200);
    expect(h.removed).toEqual([{ userId: OTHER_ID, workspace: 'alpha' }]);
    expect(store.listWorkspaces(h.sql).items).toEqual([]);
    expect(store.listWorkspaces(h.sql, {}, { includeRemoved: true }).items[0]?.removedAt).not.toBe(null);
    expect(store.listAudit(h.sql).items[0]?.outcome).toBe('ok');
    h.close();
  });

  test('every mutation path this route accepts leaves exactly one settled audit row', async () => {
    // One attempt is one row, whatever the outcome, and none is left pending.
    const attempts: JsonValue[] = [
      { action: 'job.cancel', userId: USER_ID, workspace: 'alpha', jobId: 'j' },
      { action: 'job.retry', userId: USER_ID, workspace: 'alpha', jobId: 'j' },
      { action: 'job.dismiss', userId: USER_ID, workspace: 'alpha', jobId: 'j' },
      { action: 'jobs.clear', userId: USER_ID, workspace: 'alpha' },
      { action: 'approvals.decide', userId: USER_ID, workspace: 'alpha', ids: ['x'], decision: 'approved' },
      { action: 'shell_grants.revoke', userId: USER_ID, workspace: 'alpha' },
      { action: 'workspace.remove', userId: USER_ID, workspace: 'alpha', confirm: 'alpha' },
      { action: 'nonsense' },
    ];

    const h = harness();

    for (const attempt of attempts) {
      await handleControlRequest(post('/actions', attempt), h.env, identity());
    }

    const rows = store.listAudit(h.sql, { limit: 50 }).items;
    expect(rows.length).toBe(attempts.length);
    expect(store.listPendingAudit(h.sql)).toEqual([]);
    expect(new Set(rows.map((row) => row.operation))).toEqual(new Set([
      'job_cancel', 'job_retry', 'job_dismiss', 'jobs_clear',
      'approvals_decide', 'shell_grants_revoke', 'workspace_remove', 'action_rejected',
    ]));
    h.close();
  });
});

describe('the audit log is written before the action, not after', () => {
  test('an unavailable audit store runs NOTHING', async () => {
    // Defends: appending the row after the mutation let a mutation return 200 with no durable
    // record.
    const h = harness({ audit: 'append' });

    const attempts: JsonValue[] = [
      { action: 'job.cancel', userId: USER_ID, workspace: 'alpha', jobId: 'j' },
      { action: 'jobs.clear', userId: USER_ID, workspace: 'alpha' },
      { action: 'approvals.decide', userId: USER_ID, workspace: 'alpha', ids: ['x'], decision: 'approved' },
      { action: 'shell_grants.revoke', userId: USER_ID, workspace: 'alpha' },
      { action: 'workspace.remove', userId: USER_ID, workspace: 'alpha', confirm: 'alpha' },
      { action: 'nonsense' },
    ];

    for (const attempt of attempts) {
      const answer = await handleControlRequest(post('/actions', attempt), h.env, identity());
      expect(answer?.status).toBe(503);
    }

    expect(h.rpc.calls).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(store.listAudit(h.sql).items).toEqual([]);
    h.close();
  });

  test('a lost settlement leaves a pending row and does not answer success', async () => {
    const h = harness({ audit: 'settle' });

    const answer = await handleControlRequest(
      post('/actions', { action: 'job.cancel', userId: USER_ID, workspace: 'alpha', jobId: 'job-7' }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(500);
    expect(await bodyOf(answer)).toMatchObject({
      error: expect.stringContaining('still pending in the audit log'),
    });
    expect(h.rpc.calls.map((c) => c.method)).toEqual(['claimOwner', 'cancelBackgroundJob']);
    const pending = store.listPendingAudit(h.sql);
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({
      operation: 'job_cancel', outcome: 'pending', target: `${USER_ID}/alpha/job-7`,
      actorEmail: OPERATOR,
    });
    h.close();
  });
});

describe('cross-user isolation', () => {
  test("one account's list never contains another's workspace", async () => {
    const h = harness();
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });
    store.observeUser(h.sql, { userId: OTHER_ID, email: 'someone@example.com', at: 1_000 });
    store.observeWorkspace(h.sql, { userId: USER_ID, name: 'shared-name', displayName: 'Mine', at: 2_000 });
    store.observeWorkspace(h.sql, { userId: OTHER_ID, name: 'shared-name', displayName: 'Theirs', at: 3_000 });

    const answer = await handleControlRequest(get(`/workspaces?userId=${OTHER_ID}`), h.env, identity());
    const page = await bodyOf(answer);
    expect(page).toMatchObject({
      items: [{ userId: OTHER_ID, displayName: 'Theirs', email: 'someone@example.com' }],
    });
    h.close();
  });

  test('the user drilldown reconciles from the registry and says so', async () => {
    const h = harness();
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });
    store.observeWorkspace(h.sql, { userId: USER_ID, name: 'stale', displayName: 'Stale', at: 1_000 });

    const answer = await handleControlRequest(get(`/users/${USER_ID}`), h.env, identity());
    const detail = await bodyOf(answer);
    expect(detail).toMatchObject({ reconcile: { status: 'ok' }, viewer: OPERATOR });
    const rows = store.listWorkspaces(h.sql, {}, { userId: USER_ID }).items;
    expect(rows.map((row) => row.name)).toEqual(['alpha']);
    h.close();
  });

  test('a roster read that fails leaves the index alone and says the rows are its own belief', async () => {
    const h = harness({ rosterError: 'the user object is evicted' });
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });
    store.observeWorkspace(h.sql, { userId: USER_ID, name: 'kept', displayName: 'Kept', at: 1_000 });

    const answer = await handleControlRequest(get(`/users/${USER_ID}`), h.env, identity());
    const detail = await bodyOf(answer);
    expect(detail).toMatchObject({
      reconcile: { status: 'failed', reason: expect.stringContaining('the user object is evicted') },
    });
    // Nothing tombstoned on a failed read: a failure must not empty the list an operator acts on.
    expect(store.listWorkspaces(h.sql, {}, { userId: USER_ID }).items.map((r) => r.name)).toEqual(['kept']);
    h.close();
  });

  test('a user id that is not one is refused before any read', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/users/not-a-user-id'), h.env, identity());
    expect(answer?.status).toBe(400);
    h.close();
  });

  test('a workspace read without an owner is refused, because the name is not an address', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/workspaces/alpha'), h.env, identity());
    expect(answer?.status).toBe(400);
    expect(h.rpc.calls).toEqual([]);
    h.close();
  });
});

/**
 * `OrchestratorAgent` is addressed by name deployment-wide while roster rows are per-account:
 * two accounts can hold a row for one name, and only one owns the object.
 */
describe('a global-name collision between two accounts', () => {
  /** Reachable in production when a create registered its row and then lost the ownership claim. */
  const collided = () => harness({
    rosters: { [USER_ID]: roster('contested'), [OTHER_ID]: roster('contested') },
    owners: { contested: USER_ID },
  });

  test('the owner reaches the workspace and the other account does not', async () => {
    const h = collided();

    const mine = await handleControlRequest(
      get(`/workspaces/contested?userId=${USER_ID}`), h.env, identity(),
    );

    expect(mine?.status).toBe(200);
    expect(await bodyOf(mine)).toMatchObject({ workspace: 'contested', userId: USER_ID });

    h.rpc.calls.length = 0;

    const theirs = await handleControlRequest(
      get(`/workspaces/contested?userId=${OTHER_ID}`), h.env, identity(),
    );

    expect(theirs?.status).toBe(403);
    expect(h.rpc.calls.map((c) => c.method)).toEqual(['claimOwner']);
    h.close();
  });

  test('a stale roster row cannot mutate the account that really owns the name', async () => {
    const h = collided();

    const attempts: JsonValue[] = [
      { action: 'job.cancel', userId: OTHER_ID, workspace: 'contested', jobId: 'j' },
      { action: 'job.retry', userId: OTHER_ID, workspace: 'contested', jobId: 'j' },
      { action: 'job.dismiss', userId: OTHER_ID, workspace: 'contested', jobId: 'j' },
      { action: 'jobs.clear', userId: OTHER_ID, workspace: 'contested' },
      { action: 'approvals.decide', userId: OTHER_ID, workspace: 'contested', ids: ['x'], decision: 'approved' },
      { action: 'shell_grants.revoke', userId: OTHER_ID, workspace: 'contested' },
      { action: 'workspace.remove', userId: OTHER_ID, workspace: 'contested', confirm: 'contested' },
    ];

    for (const attempt of attempts) {
      const answer = await handleControlRequest(post('/actions', attempt), h.env, identity());
      expect(answer?.status, JSON.stringify(attempt)).not.toBe(200);
    }

    expect(new Set(h.rpc.calls.map((c) => c.method))).toEqual(new Set(['claimOwner', 'destroyAgent']));
    expect(h.removed).toEqual([]);
    const rows = store.listAudit(h.sql, { limit: 50 }).items;
    expect(rows.length).toBe(7);
    expect(store.listPendingAudit(h.sql)).toEqual([]);

    for (const row of rows) expect(row.outcome).not.toBe('ok');
    h.close();
  });

  test('a failed cross-user create leaves the loser no roster row and no index row', async () => {
    const h = harness({
      rosters: { [USER_ID]: roster('contested'), [OTHER_ID]: [] },
      owners: { contested: USER_ID },
    });

    store.observeUser(h.sql, { userId: OTHER_ID, email: 'loser@example.com', at: 1_000 });

    const answer = await handleControlRequest(get(`/users/${OTHER_ID}`), h.env, identity());
    expect(await bodyOf(answer)).toMatchObject({
      reconcile: { status: 'ok' },
      workspaces: { items: [] },
    });
    expect(store.listWorkspaces(h.sql, {}, { userId: USER_ID }).items).toEqual([]);
    h.close();
  });
});

describe('paging over HTTP', () => {
  test('250 accounts are walkable past the 200-row page ceiling', async () => {
    const h = harness();

    for (let i = 0; i < 250; i += 1) {
      store.observeUser(h.sql, {
        userId: `u${String(i).padStart(4, '0')}`, email: `u${String(i)}@x`, at: 1_000_000 - i,
      });
    }

    const PageSchema = v.variant('status', [
      v.object({ status: v.literal('more'), items: v.array(v.object({ userId: v.string() })), next: v.object({ after: v.string() }) }),
      v.object({ status: v.literal('end'), items: v.array(v.object({ userId: v.string() })) }),
    ]);

    const seen: string[] = [];
    let query = '?limit=200';

    for (let pages = 0; pages < 5; pages += 1) {
      const answer = await handleControlRequest(get(`/users${query}`), h.env, identity());
      expect(answer?.status).toBe(200);
      const page = v.parse(PageSchema, await answered(answer).json());

      for (const row of page.items) seen.push(row.userId);

      if (page.status === 'end') break;
      query = `?limit=200&cursor=${encodeURIComponent(page.next.after)}`;
    }

    expect(seen.length).toBe(250);
    expect(new Set(seen).size).toBe(250);
    h.close();
  });

  test('250 of one account\u2019s workspaces are walkable, and only page one reconciles', async () => {
    // Defends: the drilldown read exactly one `CONTROL_PAGE_MAX` page. The reconcile rewrites
    // `last_seen_at`, which the cursor orders on, so it must not run again mid-walk.
    const many = roster(...Array.from({ length: 250 }, (_, i) => `w${String(i).padStart(3, '0')}`));
    const h = harness({ rosters: { [USER_ID]: many }, owners: {} });
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });

    const DetailSchema = v.object({
      reconcile: v.union([
        v.object({ status: v.literal('ok') }),
        v.object({ status: v.literal('skipped'), reason: v.string() }),
        v.object({ status: v.literal('failed'), reason: v.string() }),
      ]),
      workspaces: v.variant('status', [
        v.object({
          status: v.literal('more'),
          items: v.array(v.object({ name: v.string() })),
          next: v.object({ after: v.string() }),
        }),
        v.object({ status: v.literal('end'), items: v.array(v.object({ name: v.string() })) }),
      ]),
    });

    const seen: string[] = [];
    const reconciles: string[] = [];
    let query = '?limit=200';

    for (let pages = 0; pages < 5; pages += 1) {
      const answer = await handleControlRequest(get(`/users/${USER_ID}${query}`), h.env, identity());
      expect(answer?.status).toBe(200);
      const detail = v.parse(DetailSchema, await answered(answer).json());
      reconciles.push(detail.reconcile.status);

      for (const row of detail.workspaces.items) seen.push(row.name);

      if (detail.workspaces.status === 'end') break;
      query = `?limit=200&cursor=${encodeURIComponent(detail.workspaces.next.after)}`;
    }

    expect(seen.length).toBe(250);
    expect(new Set(seen).size).toBe(250);
    expect(reconciles).toEqual(['ok', 'skipped']);
    h.close();
  });

  test('a cursor the plane did not issue is refused rather than restarting the walk', async () => {
    const h = harness();
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });
    const answer = await handleControlRequest(get('/users?cursor=forged'), h.env, identity());
    // A 500, not a silent first page: restarting a walk looks like success and repeats rows.
    expect(answer?.status).toBe(500);
    expect(JSON.stringify(await bodyOf(answer))).toContain('cursor');
    h.close();
  });
});

describe('reads that reach through', () => {
  test('the workspace drilldown reports a down panel instead of blanking the page', async () => {
    const h = harness();

    const answer = await handleControlRequest(
      get(`/workspaces/alpha?userId=${USER_ID}`), h.env, identity(),
    );

    const detail = await bodyOf(answer);
    expect(detail).toMatchObject({
      workspace: 'alpha',
      userId: USER_ID,
      runs: { status: 'ok' },
      jobs: { status: 'ok' },
      executors: { status: 'failed' },
    });
    h.close();
  });

  test('incidents are readable, which they never were before', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/incidents'), h.env, identity());
    expect(await bodyOf(answer)).toMatchObject({
      incidents: [{ probe: 'health', failures: 3, alertedAt: null }],
    });
    h.close();
  });

  test('metrics report themselves unconfigured rather than failing', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/metrics?hours=24'), h.env, identity());
    expect(answer?.status).toBe(200);
    expect(await bodyOf(answer)).toMatchObject({
      windowHours: 24,
      missing: ['CLOUDFLARE_ACCOUNT_ID', 'ANALYTICS_SQL_API_TOKEN'],
      panels: {},
    });
    h.close();
  });

  test('an out-of-range metrics window is rounded up to one the cache keys on', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/metrics?hours=12'), h.env, identity());
    expect(await bodyOf(answer)).toMatchObject({ windowHours: 24 });
    const wide = await handleControlRequest(get('/metrics?hours=99999'), h.env, identity());
    expect(await bodyOf(wide)).toMatchObject({ windowHours: 720 });
    h.close();
  });
});
