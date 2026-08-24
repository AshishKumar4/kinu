/**
 * `/api/control/*` end to end, over the real gate, the real store and the real
 * action dispatcher.
 *
 * Only the TRANSPORT is stood in for: `ControlPlaneDO` is backed by the same
 * `store.ts` functions the deployed object calls, over a real SQLite database,
 * and each workspace stub records which existing `@callable` the action reached.
 * Everything the assertions are about — who is refused, what a refused mutation
 * leaves behind, which RPC an action proxies to, whether one account's rows can
 * appear in another's list — is production code running unmodified.
 *
 * The reason to test at this altitude rather than at the store's: the properties
 * that matter here are properties of the ROUTE. "Every mutation is audited" is
 * not a fact about a SQL function; it is a fact about the order of operations in
 * one handler, and a store test cannot see it.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AuthIdentity } from '../src/auth/session';
import * as store from '../src/control-plane/store';
import type { ControlCapability, PresentedCaller } from '../src/control-plane/capability';
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { sqlExec } from './helpers/user-do';

mockAgentsSdk();
// `routes.ts` reaches `agents` (and through it `cloudflare:email`) at module
// load, so it is imported after the mock is registered.
const { handleControlRequest } = await import('../src/control-plane/routes');
const { requireControl } = await import('../src/control-plane/capability');
/** The bindings the route reads. Named for its role rather than its structure:
 *  it is the environment these routes run in. */
type ControlRoutesEnv = Parameters<typeof handleControlRequest>[1];

const SECRET = 'routes-test-secret-0123456789';
const OPERATOR = 'ops@kinu.run';
const USER_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);

/** What each workspace stub was asked to do, so an assertion can say WHICH
 *  existing RPC an admin action proxied to rather than only that it succeeded. */
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

/** Answers the workspace stubs give. Overridden per test to drive the refusal
 *  arms, which are the ones an audit row has to distinguish. */
interface WorkspaceBehaviour {
  cancel?: { ok: boolean };
  retry?: { ok: boolean; jobId?: string; error?: string };
  grants?: { grants: { kind: string }[] };
  clear?: { ok: boolean };
  decided?: string[];
  throws?: string;
}

function harness(
  options: { admins?: string; behaviour?: WorkspaceBehaviour; rosterError?: string } = {},
): Harness {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  store.initControlPlaneSchema(sql);
  const rpc: RpcLog = { calls: [] };
  const removed: { userId: string; workspace: string }[] = [];
  const behaviour = options.behaviour ?? {};

  // The control-plane DO, backed by the real store. The capability gate is the
  // production one: the route derives a caller and this forwards it, so a route
  // that forgot to authorize would be refused here exactly as in production.
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
    async overview(caller: PresentedCaller) { await gate(caller, 'overview.read'); return store.overview(sql); },
    async listUsers(caller: PresentedCaller, request = {}) {
      await gate(caller, 'users.read'); return store.listUsers(sql, request);
    },
    async getUser(caller: PresentedCaller, userId: string) {
      await gate(caller, 'users.read'); return store.getUser(sql, userId);
    },
    async listWorkspaces(caller: PresentedCaller, request = {}, filter = {}) {
      await gate(caller, 'workspaces.read'); return store.listWorkspaces(sql, request, filter);
    },
    async listFeedback(caller: PresentedCaller, request = {}) {
      await gate(caller, 'feedback.read'); return store.listFeedback(sql, request);
    },
    async listAudit(caller: PresentedCaller, request = {}) {
      await gate(caller, 'audit.read'); return store.listAudit(sql, request);
    },
    async recordAudit(caller: PresentedCaller, entry: store.AuditDraft) {
      await gate(caller, 'audit.write'); return store.appendAudit(sql, entry);
    },
  };

  const workspaceStub = (name: string) => ({
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
    async decideDeferredApprovals(ids: string[], decision: string) {
      rpc.calls.push({ workspace: name, method: 'decideDeferredApprovals', args: [ids, decision] });
      return { decided: behaviour.decided ?? ids };
    },
    async getShellApprovalGrants() {
      rpc.calls.push({ workspace: name, method: 'getShellApprovalGrants', args: [] });
      return behaviour.grants ?? { grants: [{ kind: 'git' }] };
    },
    async revokeShellApprovalGrants(grants: unknown[]) {
      rpc.calls.push({ workspace: name, method: 'revokeShellApprovalGrants', args: [grants] });
      return { grants: [] };
    },
    async getRunSummaries() {
      rpc.calls.push({ workspace: name, method: 'getRunSummaries', args: [] });
      return { status: 'end', items: [] };
    },
    async getActivitySnapshot() {
      rpc.calls.push({ workspace: name, method: 'getActivitySnapshot', args: [] });
      return { spend: { usd: 0 } };
    },
    async listBackgroundJobs() {
      rpc.calls.push({ workspace: name, method: 'listBackgroundJobs', args: [] });
      return [];
    },
    async listDeferredApprovals() {
      rpc.calls.push({ workspace: name, method: 'listDeferredApprovals', args: [] });
      return [];
    },
    async listPendingConsents() {
      rpc.calls.push({ workspace: name, method: 'listPendingConsents', args: [] });
      return [];
    },
    async getExecutors() {
      rpc.calls.push({ workspace: name, method: 'getExecutors', args: [] });
      throw new Error('the sandbox is not reachable');
    },
  });

  const userStub = (userId: string) => ({
    async listWorkspaces() {
      if (options.rosterError) throw new Error(options.rosterError);
      return {
        entries: userId === USER_ID
          ? [{ name: 'alpha', displayName: 'Alpha', createdAt: 100, lastVisited: 900, archivedAt: null }]
          : [],
        total: userId === USER_ID ? 1 : 0,
        nextCursor: null,
      };
    },
    async removeWorkspace(_caller: PresentedCaller, workspace: string, owner: string) {
      removed.push({ userId: owner, workspace });
    },
  });

  const namespace = <Value>(resolve: (name: string) => Value) => ({
    idFromName: (name: string) => name,
    get: (name: string) => resolve(name),
  });

  const raw = {
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
  const partialEnv: Partial<ControlRoutesEnv> = {};
  Object.assign(partialEnv, raw);
  // SAFETY: the control-plane route contract reads only the locally constructed
  // CREDENTIAL_ENCRYPTION_KEY, CONTROL_PLANE_ADMINS, ControlPlaneDO,
  // OrchestratorAgent, UserDO and MonitorDO members in this harness. The
  // namespaces carry the platform's nominal DurableObjectNamespace brand, which
  // no locally built object can hold and which no route path reads.
  const env = partialEnv as ControlRoutesEnv;
  return { env, sql, rpc, removed, close: () => db.close() };
}

/** The production gate, so the harness cannot be more permissive than the
 *  deployed object. `capability` is the real closed union, so a harness method
 *  naming one the matrix does not declare is a type error here rather than a
 *  silently ungated stub. */
async function gate(caller: PresentedCaller, capability: ControlCapability): Promise<void> {
  await requireControl({ CREDENTIAL_ENCRYPTION_KEY: SECRET }, caller, capability);
}

function identity(over: Partial<AuthIdentity> = {}): AuthIdentity {
  return {
    userId: USER_ID, email: OPERATOR, sub: 'sub-1', provider: 'github',
    authTime: Date.now(), ...over,
  };
}

function get(path: string): Request {
  return new Request(`https://kinu.run/api/control${path}`);
}

/** A request body a test sends. `JsonValue` rather than `unknown` because a
 *  malformed-action test sends real JSON that the SCHEMA refuses — the point is
 *  the schema's refusal, not an unserializable value. */
function post(path: string, body: JsonValue): Request {
  return new Request(`https://kinu.run/api/control${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/** The response a control path produced. A `null` here means the route DECLINED
 *  a path it owns, which is a failure rather than something to assert away. */
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
    // The harness env with its root secret cleared. A spread of a value that
    // already has the type, so nothing is asserted here.
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
});

describe('mutations', () => {
  test('a stale sign-in is refused AND audited', async () => {
    // The row is the point. An attempted destructive action by a real operator
    // that left no trace would be the one gap an audit log may not have.
    const h = harness();
    const stale = identity({ authTime: Date.now() - 6 * 60 * 1000 });
    const answer = await handleControlRequest(
      post('/actions', { action: 'jobs.clear', workspace: 'alpha' }), h.env, stale,
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
      post('/actions', { action: 'setModel', workspace: 'alpha', model: 'anything' }),
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
      post('/actions', { action: 'job.cancel', workspace: 'alpha', jobId: 'job-7' }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(200);
    // The action proxied to the callable the owner's own UI calls — not to a
    // second implementation of cancelling a job.
    expect(h.rpc.calls).toEqual([
      { workspace: 'alpha', method: 'cancelBackgroundJob', args: ['job-7'] },
    ]);
    expect(store.listAudit(h.sql).items[0]).toMatchObject({
      operation: 'job_cancel', targetKind: 'job', target: 'alpha/job-7', outcome: 'ok',
    });
    h.close();
  });

  test('a refusal by the owning object is a 409, and its reason is the audited detail', async () => {
    const h = harness({ behaviour: { retry: { ok: false, error: 'that job already succeeded' } } });
    const answer = await handleControlRequest(
      post('/actions', { action: 'job.retry', workspace: 'alpha', jobId: 'job-7' }),
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
      post('/actions', { action: 'job.cancel', workspace: 'alpha', jobId: 'job-7' }),
      h.env, identity(),
    );
    expect(answer?.status).toBe(502);
    const row = store.listAudit(h.sql).items[0];
    expect(row?.outcome).toBe('failed');
    expect(row?.detail).toContain('the workspace is evicted');
    h.close();
  });

  test('revoking shell grants reads them first, so the audited count is real', async () => {
    const h = harness({ behaviour: { grants: { grants: [{ kind: 'git' }, { kind: 'npm' }] } } });
    await handleControlRequest(
      post('/actions', { action: 'shell_grants.revoke', workspace: 'alpha' }), h.env, identity(),
    );
    expect(h.rpc.calls.map((c) => c.method)).toEqual([
      'getShellApprovalGrants', 'revokeShellApprovalGrants',
    ]);
    expect(store.listAudit(h.sql).items[0]?.detail).toBe('revoked 2, 0 remain');
    h.close();
  });

  test('revoking nothing is a refusal, not an "ok" with nothing revoked', async () => {
    const h = harness({ behaviour: { grants: { grants: [] } } });
    const answer = await handleControlRequest(
      post('/actions', { action: 'shell_grants.revoke', workspace: 'alpha' }), h.env, identity(),
    );
    expect(answer?.status).toBe(409);
    expect(h.rpc.calls.map((c) => c.method)).toEqual(['getShellApprovalGrants']);
    expect(store.listAudit(h.sql).items[0]?.outcome).toBe('denied');
    h.close();
  });

  test('removing a workspace needs the name retyped, and the refusal is audited', async () => {
    const h = harness();
    const answer = await handleControlRequest(
      post('/actions', {
        action: 'workspace.remove', workspace: 'alpha', userId: OTHER_ID, confirm: 'alpha-typo',
      }),
      h.env, identity(),
    );
    expect(answer?.status).toBe(409);
    expect(h.removed).toEqual([]);
    expect(store.listAudit(h.sql).items[0]).toMatchObject({
      operation: 'workspace_remove', outcome: 'denied', detail: 'the typed name did not match',
    });
    h.close();
  });

  test('a confirmed removal proxies to the registry and tombstones the index', async () => {
    const h = harness();
    store.observeWorkspace(h.sql, { userId: OTHER_ID, name: 'alpha', displayName: 'Alpha', at: 1_000 });
    const answer = await handleControlRequest(
      post('/actions', {
        action: 'workspace.remove', workspace: 'alpha', userId: OTHER_ID, confirm: 'alpha',
      }),
      h.env, identity(),
    );

    expect(answer?.status).toBe(200);
    // UserDO.removeWorkspace tears the workspace's own DO down before dropping
    // the registry row, which is why the action proxies it rather than doing
    // either half.
    expect(h.removed).toEqual([{ userId: OTHER_ID, workspace: 'alpha' }]);
    expect(store.listWorkspaces(h.sql).items).toEqual([]);
    expect(store.listWorkspaces(h.sql, {}, { includeRemoved: true }).items[0]?.removedAt).not.toBe(null);
    expect(store.listAudit(h.sql).items[0]?.outcome).toBe('ok');
    h.close();
  });

  test('every mutation path this route accepts leaves exactly one audit row', async () => {
    // The property stated as a sweep rather than as seven separate assertions:
    // whatever the outcome, one attempt is one row.
    const attempts: JsonValue[] = [
      { action: 'job.cancel', workspace: 'alpha', jobId: 'j' },
      { action: 'job.retry', workspace: 'alpha', jobId: 'j' },
      { action: 'job.dismiss', workspace: 'alpha', jobId: 'j' },
      { action: 'jobs.clear', workspace: 'alpha' },
      { action: 'approvals.decide', workspace: 'alpha', ids: ['x'], decision: 'approved' },
      { action: 'shell_grants.revoke', workspace: 'alpha' },
      { action: 'workspace.remove', workspace: 'alpha', userId: OTHER_ID, confirm: 'alpha' },
      // Refused shapes count too: an unaudited rejected attempt is the gap.
      { action: 'nonsense' },
    ];
    const h = harness();
    for (const attempt of attempts) {
      await handleControlRequest(post('/actions', attempt), h.env, identity());
    }
    expect(store.listAudit(h.sql, { limit: 50 }).items.length).toBe(attempts.length);
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
    expect(detail).toMatchObject({ reconciled: true, viewer: OPERATOR });
    // `alpha` is what the fake registry holds; `stale` is what the index held.
    // The reconcile is what makes the second one a tombstone.
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
    expect(detail).toMatchObject({ reconciled: false });
    // Nothing tombstoned on a failed read: an operator deciding to remove a
    // workspace must not be shown a list that a failure emptied.
    expect(store.listWorkspaces(h.sql, {}, { userId: USER_ID }).items.map((r) => r.name)).toEqual(['kept']);
    h.close();
  });

  test('a user id that is not one is refused before any read', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/users/not-a-user-id'), h.env, identity());
    expect(answer?.status).toBe(400);
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

  test('a cursor the plane did not issue is refused rather than restarting the walk', async () => {
    const h = harness();
    store.observeUser(h.sql, { userId: USER_ID, email: OPERATOR, at: 1_000 });
    const answer = await handleControlRequest(get('/users?cursor=forged'), h.env, identity());
    // A 500 with the reason, not a silent first page: restarting a walk from the
    // top looks like success and repeats every row already seen.
    expect(answer?.status).toBe(500);
    expect(JSON.stringify(await bodyOf(answer))).toContain('cursor');
    h.close();
  });
});

describe('reads that reach through', () => {
  test('the workspace drilldown reports a down panel instead of blanking the page', async () => {
    const h = harness();
    const answer = await handleControlRequest(get('/workspaces/alpha'), h.env, identity());
    const detail = await bodyOf(answer);
    expect(detail).toMatchObject({
      workspace: 'alpha',
      runs: { status: 'ok' },
      jobs: { status: 'ok' },
      // The one stub that throws. A workspace whose sandbox is down still has
      // runs, jobs and approvals worth reading, and that is the workspace an
      // operator is looking at.
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
    // No analytics account id and no token on this deployment. The metrics view
    // is a sentence, and every other view is unaffected — a 500 here would send
    // an operator looking for an outage that does not exist.
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
