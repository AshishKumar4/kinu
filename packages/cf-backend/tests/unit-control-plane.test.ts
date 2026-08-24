/**
 * The admin control plane: who may reach it, what the index actually holds, and
 * whether an operator action can happen without leaving a record.
 *
 * The store runs against a real SQLite database rather than a fake of the Durable
 * Object that hosts it, which is why `store.ts` is a module of functions over
 * `SqlExec` — the same split `monitor/incidents.ts` has from `MonitorDO`. What is
 * asserted here is our own logic: cursor anchors, tombstones, the capability
 * attenuation and the audit append. The one PLATFORM claim — that a denial thrown
 * inside a Durable Object crosses the real RPC boundary as a rejection — lives in
 * `tests/workerd/do-control-plane.test.ts`, because `bun test` has no actor.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Page, PageRequest } from '@kinu.run/core';
import type { ControlPlaneSql } from '../src/control-plane/sql';
import type { AuthIdentity } from '../src/auth/session';
import {
  adminCaller, adminDenialStatus, authorizeAdmin, ControlDeniedError, internalCaller,
  requireControl,
} from '../src/control-plane/admin-caller';
import * as store from '../src/control-plane/store';
import { MalformedCursorError } from '../src/control-plane/store';
import * as v from 'valibot';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { sqlExec } from './helpers/user-do';

mockAgentsSdk();
// `actions.ts` imports `getAgentByName` from `agents`, which reaches
// `cloudflare:email` at module load, so it is imported after the mock is
// registered — the same ordering `unit-agents-codemode.test.ts` documents.
const { ControlActionSchema, describeAction } = await import('../src/control-plane/actions');

const SECRET = 'control-plane-test-secret-0123456789';
const ENV = { CREDENTIAL_ENCRYPTION_KEY: SECRET, CONTROL_PLANE_ADMINS: 'ops@kinu.run, second@kinu.run' };

/** A signed-in browser identity. `authTime` is `now` by default, so a test that
 *  cares about staleness has to say so — the opposite default would make every
 *  step-up assertion pass by accident. */
function identity(over: Partial<AuthIdentity> = {}): AuthIdentity {
  return {
    userId: 'a'.repeat(32),
    email: 'ops@kinu.run',
    sub: 'sub-1',
    provider: 'github',
    authTime: Date.now(),
    ...over,
  };
}

/** A schema'd store over a real SQLite database, and the handle that closes it. */
interface StoreUnderTest {
  sql: ControlPlaneSql;
  close: () => void;
}

function freshStore(): StoreUnderTest {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  store.initControlPlaneSchema(sql);
  return { sql, close: () => db.close() };
}

describe('who may reach the control plane', () => {
  test('an ordinary signed-in user is refused, and the refusal is a 404', () => {
    const answer = authorizeAdmin(ENV, identity({ email: 'someone@example.com' }), { mutating: false });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('not_admin');
    // Not 403: a 403 confirms the path exists, and whether this deployment has an
    // admin surface is not something an ordinary user needs to learn.
    expect(adminDenialStatus(answer.denial)).toBe(404);
  });

  test('a dev-synthesized identity is refused even with its email on the list', () => {
    // `env.staging` sets DEV_USER_EMAIL, so `authenticateRequest` answers every
    // request there with ONE identity carrying a fresh authTime. If the allowlist
    // alone decided, that would be permanent operator authority for any
    // unauthenticated caller who can reach the staging origin.
    const answer = authorizeAdmin(
      { ...ENV, CONTROL_PLANE_ADMINS: 'eval-service@kinu.run' },
      identity({ email: 'eval-service@kinu.run', provider: 'dev' }),
      { mutating: false },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('dev_identity');
  });

  test('a scoped CLI access token is refused', () => {
    // A long-lived non-interactive credential. Step-up over it means nothing and
    // the admin plane is in no CLI scope.
    const answer = authorizeAdmin(ENV, identity({ cliScopes: [] }), { mutating: false });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('token_identity');
  });

  test('an empty allowlist admits nobody, including a would-be operator', () => {
    const answer = authorizeAdmin(
      { ...ENV, CONTROL_PLANE_ADMINS: '' }, identity(), { mutating: false },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('no_admins_configured');
  });

  test('an operator is matched case-insensitively', () => {
    const answer = authorizeAdmin(ENV, identity({ email: 'OPS@Kinu.RUN' }), { mutating: false });
    expect(answer.ok).toBe(true);
  });

  test('a deployment with no root secret says so, rather than answering 404', () => {
    const answer = authorizeAdmin(
      { CONTROL_PLANE_ADMINS: 'ops@kinu.run' }, identity(), { mutating: false },
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('unreachable');
    expect(answer.denial).toBe('unconfigured');
    expect(adminDenialStatus(answer.denial)).toBe(503);
  });

  test('a mutation needs a fresh sign-in; a read does not', () => {
    const stale = identity({ authTime: Date.now() - 6 * 60 * 1000 });

    const read = authorizeAdmin(ENV, stale, { mutating: false });
    expect(read.ok).toBe(true);
    // Authorized to READ, and carrying the fact that it may not write — which is
    // what lets the route audit an attempted mutation instead of dropping it.
    if (!read.ok) throw new Error('unreachable');
    expect(read.admin.fresh).toBe(false);

    const write = authorizeAdmin(ENV, stale, { mutating: true });
    expect(write.ok).toBe(false);
    if (write.ok) throw new Error('unreachable');
    expect(write.denial).toBe('stale_auth');
    // 403 here, not 404: the caller IS a known operator and the remedy is to sign
    // in again, so telling them is the point.
    expect(adminDenialStatus(write.denial)).toBe(403);
  });

  test('a sign-in inside the window may mutate', () => {
    const answer = authorizeAdmin(ENV, identity({ authTime: Date.now() - 60_000 }), { mutating: true });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('unreachable');
    expect(answer.admin.fresh).toBe(true);
  });
});

describe('capability attenuation', () => {
  test('the ingest caller may feed the index and may not read across users', async () => {
    const caller = await internalCaller(ENV);
    expect(await requireControl(ENV, caller, 'index.observe')).toBe('ingest');
    expect(await requireControl(ENV, caller, 'feedback.write')).toBe('ingest');
    // The whole point of two grades. A bug in the feedback endpoint — which any
    // signed-in user can reach — must not be one import away from every account's
    // workspaces.
    await expect(requireControl(ENV, caller, 'users.read')).rejects.toThrow(ControlDeniedError);
    await expect(requireControl(ENV, caller, 'audit.write')).rejects.toThrow(ControlDeniedError);
  });

  test('the admin caller holds both grades', async () => {
    const authorization = authorizeAdmin(ENV, identity(), { mutating: true });
    if (!authorization.ok) throw new Error('the fixture operator should be authorized');
    const caller = await adminCaller(ENV, authorization.admin);
    expect(await requireControl(ENV, caller, 'users.read')).toBe('admin');
    expect(await requireControl(ENV, caller, 'audit.write')).toBe('admin');
    // A grade above the requirement is still a pass: `admin` subsumes `ingest`.
    expect(await requireControl(ENV, caller, 'index.observe')).toBe('admin');
  });

  test('an unrecognized caller is refused rather than defaulted', async () => {
    for (const caller of [undefined, null, {}, { controlToken: '' }, { controlToken: 'guess' }]) {
      await expect(requireControl(ENV, caller, 'index.observe')).rejects.toThrow(ControlDeniedError);
    }
  });

  test('a token derived from a different root secret is refused', async () => {
    // The authority is the deployment's secret, not the string's shape. A token
    // minted against another key is a well-formed value with no authority here.
    const foreign = await internalCaller({ CREDENTIAL_ENCRYPTION_KEY: 'a-different-secret-000000' });
    await expect(requireControl(ENV, foreign, 'index.observe')).rejects.toThrow(ControlDeniedError);
  });
});

describe('the index', () => {
  test('a second observation advances last-seen and keeps first-seen', () => {
    const { sql, close } = freshStore();
    store.observeUser(sql, { userId: 'u1', email: 'a@x', at: 1_000 });
    store.observeUser(sql, { userId: 'u1', email: 'a@x', displayName: 'Ada', at: 5_000 });
    const row = store.getUser(sql, 'u1');
    expect(row).toEqual({
      userId: 'u1', email: 'a@x', displayName: 'Ada',
      firstSeenAt: 1_000, lastSeenAt: 5_000, workspaces: 0,
    });
    close();
  });

  test('an out-of-order observation never moves last-seen backwards', () => {
    const { sql, close } = freshStore();
    store.observeUser(sql, { userId: 'u1', email: 'a@x', at: 5_000 });
    store.observeUser(sql, { userId: 'u1', email: 'a@x', at: 1_000 });
    expect(store.getUser(sql, 'u1')?.lastSeenAt).toBe(5_000);
    close();
  });

  test('two accounts owning the same workspace name are two rows', () => {
    // A workspace name is unique within a UserDO and nowhere else. Keying the
    // index on the name alone would have one account's row overwrite another's,
    // which is a cross-user leak inside an admin list.
    const { sql, close } = freshStore();
    store.observeUser(sql, { userId: 'u1', email: 'one@x', at: 1_000 });
    store.observeUser(sql, { userId: 'u2', email: 'two@x', at: 1_000 });
    store.observeWorkspace(sql, { userId: 'u1', name: 'research', displayName: 'One\u2019s', at: 2_000 });
    store.observeWorkspace(sql, { userId: 'u2', name: 'research', displayName: 'Two\u2019s', at: 3_000 });

    const all = store.listWorkspaces(sql);
    expect(all.items.length).toBe(2);
    expect(new Set(all.items.map((w) => w.userId))).toEqual(new Set(['u1', 'u2']));

    const onlyOne = store.listWorkspaces(sql, {}, { userId: 'u1' });
    expect(onlyOne.items.map((w) => w.displayName)).toEqual(['One\u2019s']);
    expect(store.getUser(sql, 'u1')?.workspaces).toBe(1);
    close();
  });

  test('a workspace indexed before its owner reads with an empty owner, not a wrong one', () => {
    const { sql, close } = freshStore();
    store.observeWorkspace(sql, { userId: 'u9', name: 'early', displayName: 'Early', at: 1_000 });
    expect(store.listWorkspaces(sql).items[0]?.email).toBe('');
    close();
  });

  test('forgetting a workspace tombstones it, and it stays readable', () => {
    const { sql, close } = freshStore();
    store.observeWorkspace(sql, { userId: 'u1', name: 'gone', displayName: 'Gone', at: 1_000 });
    store.forgetWorkspace(sql, { userId: 'u1', name: 'gone', at: 9_000 });

    expect(store.listWorkspaces(sql).items).toEqual([]);
    const withRemoved = store.listWorkspaces(sql, {}, { includeRemoved: true });
    expect(withRemoved.items[0]?.removedAt).toBe(9_000);
    close();
  });

  test('a same-name recreate resurrects the row rather than leaving it removed', () => {
    const { sql, close } = freshStore();
    store.observeWorkspace(sql, { userId: 'u1', name: 'again', displayName: 'v1', at: 1_000 });
    store.forgetWorkspace(sql, { userId: 'u1', name: 'again', at: 2_000 });
    store.observeWorkspace(sql, { userId: 'u1', name: 'again', displayName: 'v2', at: 3_000 });

    const rows = store.listWorkspaces(sql).items;
    expect(rows.length).toBe(1);
    expect(rows[0]?.removedAt).toBe(null);
    expect(rows[0]?.displayName).toBe('v2');
    close();
  });

  test('reconciling against the registry tombstones what the registry no longer has', () => {
    const { sql, close } = freshStore();
    for (const name of ['keep', 'drop']) {
      store.observeWorkspace(sql, { userId: 'u1', name, displayName: name, at: 1_000 });
    }
    const outcome = store.replaceUserWorkspaces(sql, 'u1', [
      { name: 'keep', displayName: 'Keep', createdAt: 500, lastVisited: 7_000 },
    ], 9_000);

    expect(outcome).toEqual({ present: 1, tombstoned: 1 });
    expect(store.listWorkspaces(sql).items.map((w) => w.name)).toEqual(['keep']);
    close();
  });

  test('an account whose last workspace was removed stops showing rows', () => {
    // The empty roster is deliberately not an early return: it is the case where
    // the index would otherwise keep displaying a workspace that no longer exists.
    const { sql, close } = freshStore();
    store.observeWorkspace(sql, { userId: 'u1', name: 'only', displayName: 'Only', at: 1_000 });
    expect(store.replaceUserWorkspaces(sql, 'u1', [], 9_000)).toEqual({ present: 0, tombstoned: 1 });
    expect(store.listWorkspaces(sql).items).toEqual([]);
    close();
  });

  test('reconciling one account never touches another', () => {
    const { sql, close } = freshStore();
    store.observeWorkspace(sql, { userId: 'u1', name: 'mine', displayName: 'Mine', at: 1_000 });
    store.observeWorkspace(sql, { userId: 'u2', name: 'theirs', displayName: 'Theirs', at: 1_000 });
    store.replaceUserWorkspaces(sql, 'u1', [], 9_000);
    expect(store.listWorkspaces(sql, {}, { userId: 'u2' }).items.map((w) => w.name)).toEqual(['theirs']);
    close();
  });
});

describe('paging', () => {
  test('250 accounts are all reachable, past the 200-row page ceiling', () => {
    const { sql, close } = freshStore();
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      // Descending last-seen so the walk order is deterministic and the ids are
      // NOT in the same order as the sort key — a cursor that accidentally paged
      // by id would still look right on an accidentally-aligned fixture.
      store.observeUser(sql, { userId: `u${String(i).padStart(4, '0')}`, email: `u${String(i)}@x`, at: 1_000_000 - i });
    }

    const seen: string[] = [];
    let cursor: { after: string } | undefined;
    let pages = 0;
    for (;;) {
      // Built in statements: an absent cursor means "start at the beginning",
      // and a spread producing `cursor: undefined` would read as a present
      // cursor the store then refuses.
      const request: PageRequest = { limit: 200 };
      if (cursor !== undefined) request.cursor = cursor;
      const page: Page<store.ControlUserRow> = store.listUsers(sql, request);
      pages += 1;
      for (const row of page.items) seen.push(row.userId);
      if (page.status === 'end') break;
      cursor = page.next;
      if (pages > 10) throw new Error('the walk did not terminate');
    }

    expect(pages).toBe(2);
    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    close();
  });

  test('a request for more than the ceiling is clamped, not honoured', () => {
    const { sql, close } = freshStore();
    for (let i = 0; i < 250; i += 1) {
      store.observeUser(sql, { userId: `u${String(i).padStart(4, '0')}`, email: `u${String(i)}@x`, at: 1_000_000 - i });
    }
    const page = store.listUsers(sql, { limit: 10_000 });
    expect(page.items.length).toBe(store.CONTROL_PAGE_MAX);
    expect(page.status).toBe('more');
    close();
  });

  test('rows sharing a millisecond are neither skipped nor repeated across a page boundary', () => {
    // The tiebreak in the anchor. A feed observing a batch writes many rows in
    // one millisecond, and a boundary landing inside that tie is the paging defect
    // hardest to notice after the fact.
    const { sql, close } = freshStore();
    for (let i = 0; i < 5; i += 1) {
      store.observeUser(sql, { userId: `same${String(i)}`, email: `s${String(i)}@x`, at: 4_000 });
    }
    const first = store.listUsers(sql, { limit: 2 });
    expect(first.status).toBe('more');
    if (first.status !== 'more') throw new Error('unreachable');
    const second = store.listUsers(sql, { limit: 2, cursor: first.next });
    // A third page only when the second reported one. `EMPTY_PAGE` is a real
    // `Page`, not an ad-hoc object, so the spread below reads one shape.
    const third: Page<store.ControlUserRow> = second.status === 'more'
      ? store.listUsers(sql, { limit: 2, cursor: second.next })
      : { status: 'end', items: [] };

    const seen = [...first.items, ...second.items, ...third.items].map((row) => row.userId);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
    close();
  });

  test('`end` is reported about a query that ran off the end, not a full page', () => {
    const { sql, close } = freshStore();
    for (let i = 0; i < 4; i += 1) {
      store.observeUser(sql, { userId: `u${String(i)}`, email: `u${String(i)}@x`, at: 1_000 - i });
    }
    // Exactly as many rows as the limit. Comparing `rows.length` to `limit` would
    // report `more` here and hand out a cursor onto nothing.
    expect(store.listUsers(sql, { limit: 4 }).status).toBe('end');
    expect(store.listUsers(sql, { limit: 3 }).status).toBe('more');
    close();
  });

  test('a malformed cursor is refused rather than silently restarting the walk', () => {
    const { sql, close } = freshStore();
    store.observeUser(sql, { userId: 'u1', email: 'a@x', at: 1_000 });
    expect(() => store.listUsers(sql, { cursor: { after: 'nonsense' } })).toThrow(MalformedCursorError);
    expect(() => store.listUsers(sql, { cursor: { after: 'x\u0000u1' } })).toThrow(MalformedCursorError);
    close();
  });

  test('feedback and audit page by their own clocks', () => {
    const { sql, close } = freshStore();
    for (let i = 0; i < 5; i += 1) {
      store.recordFeedback(sql, {
        id: `f${String(i)}`, createdAt: 1_000 + i, userId: 'u1', email: 'a@x',
        note: `note ${String(i)}`, route: '/workspace/x', workspace: 'x',
        objectKey: null, contentType: null, bytes: null, userAgent: null,
      });
      store.appendAudit(sql, {
        id: `a${String(i)}`, at: 1_000 + i, actorEmail: 'ops@kinu.run', actorUserId: 'u1',
        operation: 'job_cancel', targetKind: 'job', target: `x/${String(i)}`,
        outcome: 'ok', detail: 'cancelled',
      });
    }
    const feedback = store.listFeedback(sql, { limit: 2 });
    expect(feedback.status).toBe('more');
    expect(feedback.items.map((row) => row.id)).toEqual(['f4', 'f3']);

    const audit = store.listAudit(sql, { limit: 2 });
    expect(audit.status).toBe('more');
    expect(audit.items.map((row) => row.id)).toEqual(['a4', 'a3']);
    close();
  });
});

describe('feedback rows', () => {
  test('a note-only report is a first-class row', () => {
    const { sql, close } = freshStore();
    store.recordFeedback(sql, {
      id: 'f1', createdAt: 1_000, userId: 'u1', email: 'a@x',
      note: 'the sidebar overlaps at 640px', route: '/workspace/alpha', workspace: 'alpha',
      objectKey: null, contentType: null, bytes: null, userAgent: 'Mozilla/5.0',
    });
    const row = store.listFeedback(sql).items[0];
    expect(row?.objectKey).toBe(null);
    expect(row?.bytes).toBe(null);
    expect(row?.note).toBe('the sidebar overlaps at 640px');
    close();
  });

  test('the store declines to hold a row wider than its declared shape', () => {
    const { sql, close } = freshStore();
    store.recordFeedback(sql, {
      id: 'f2', createdAt: 1_000, userId: 'u1', email: 'a@x',
      note: 'x'.repeat(9_000), route: 'y'.repeat(2_000), workspace: null,
      objectKey: 'feedback/u1/f2.png', contentType: 'image/png', bytes: 12_345,
      userAgent: 'z'.repeat(2_000),
    });
    const row = store.listFeedback(sql).items[0];
    expect(row?.note.length).toBe(4_000);
    expect(row?.route.length).toBe(512);
    expect(row?.userAgent?.length).toBe(512);
    close();
  });

  test('a resubmitted id does not duplicate the report', () => {
    const { sql, close } = freshStore();
    const row = {
      id: 'f3', createdAt: 1_000, userId: 'u1', email: 'a@x', note: 'once',
      route: '/', workspace: null, objectKey: null, contentType: null, bytes: null, userAgent: null,
    };
    store.recordFeedback(sql, row);
    store.recordFeedback(sql, { ...row, note: 'twice' });
    const rows = store.listFeedback(sql).items;
    expect(rows.length).toBe(1);
    expect(rows[0]?.note).toBe('once');
    close();
  });
});

describe('the audit log', () => {
  test('the store exposes no way to change or remove an entry', () => {
    // Append-only stated as an API-surface fact rather than as a comment. The
    // reachable set is what an operator's word against the log rests on.
    const auditNames = Object.keys(store).filter((name) => /audit/i.test(name));
    expect(auditNames.sort()).toEqual(['appendAudit', 'listAudit']);
  });

  test('a refusal is recorded as such, and read back as such', () => {
    const { sql, close } = freshStore();
    store.appendAudit(sql, {
      at: 2_000, actorEmail: 'ops@kinu.run', actorUserId: 'u1',
      operation: 'workspace_remove', targetKind: 'workspace', target: 'alpha',
      outcome: 'denied', detail: 'the typed name did not match',
    });
    const row = store.listAudit(sql).items[0];
    expect(row?.outcome).toBe('denied');
    expect(row?.detail).toBe('the typed name did not match');
    expect(row?.actorEmail).toBe('ops@kinu.run');
    close();
  });

  test('an outcome nothing wrote reads as failed rather than as itself', () => {
    const { sql, close } = freshStore();
    sql.exec(
      `INSERT INTO cp_audit (id, at, actor_email, actor_user, operation, target_kind, target, outcome, detail)
       VALUES ('x', 1, 'a@x', 'u1', 'op', 'k', 't', 'something-else', 'd')`,
    );
    expect(store.listAudit(sql).items[0]?.outcome).toBe('failed');
    close();
  });

  test('the overview reports the newest action', () => {
    const { sql, close } = freshStore();
    expect(store.overview(sql).lastAdminActionAt).toBe(null);
    store.appendAudit(sql, {
      at: 7_000, actorEmail: 'ops@kinu.run', actorUserId: 'u1',
      operation: 'jobs_clear', targetKind: 'workspace', target: 'alpha',
      outcome: 'ok', detail: 'cleared',
    });
    const summary = store.overview(sql);
    expect(summary.auditEntries).toBe(1);
    expect(summary.lastAdminActionAt).toBe(7_000);
    close();
  });

  test('the overview counts live and removed workspaces apart', () => {
    const { sql, close } = freshStore();
    const now = 10_000_000;
    store.observeUser(sql, { userId: 'recent', email: 'r@x', at: now - 1_000 });
    store.observeUser(sql, { userId: 'older', email: 'o@x', at: now - 3 * 24 * 60 * 60 * 1000 });
    store.observeUser(sql, { userId: 'ancient', email: 'a@x', at: now - 30 * 24 * 60 * 60 * 1000 });
    store.observeWorkspace(sql, { userId: 'recent', name: 'live', displayName: 'Live', at: now });
    store.observeWorkspace(sql, { userId: 'recent', name: 'dead', displayName: 'Dead', at: now });
    store.forgetWorkspace(sql, { userId: 'recent', name: 'dead', at: now });

    const summary = store.overview(sql, now);
    expect(summary).toMatchObject({
      users: 3, workspaces: 1, workspacesRemoved: 1, activeUsers24h: 1, activeUsers7d: 2,
    });
    close();
  });
});

describe('the admin action surface', () => {
  test('every action names a snake_case operation the audit log can group on', () => {
    // A dot in the operation would split one operation across two group keys in
    // the analytics sink, which groups on the tail after the first dot.
    const actions = [
      { action: 'job.cancel', workspace: 'alpha', jobId: 'j1' },
      { action: 'job.retry', workspace: 'alpha', jobId: 'j1' },
      { action: 'job.dismiss', workspace: 'alpha', jobId: 'j1' },
      { action: 'jobs.clear', workspace: 'alpha' },
      { action: 'approvals.decide', workspace: 'alpha', ids: ['x'], decision: 'approved' },
      { action: 'shell_grants.revoke', workspace: 'alpha' },
      { action: 'workspace.remove', workspace: 'alpha', userId: 'b'.repeat(32), confirm: 'alpha' },
    ] as const;

    for (const raw of actions) {
      const parsed = v.parse(ControlActionSchema, raw);
      const described = describeAction(parsed);
      expect(described.operation).not.toContain('.');
      expect(described.operation).toMatch(/^[a-z_]+$/);
      expect(described.target.length).toBeGreaterThan(0);
      expect(['job', 'approval', 'workspace']).toContain(described.targetKind);
    }
  });

  test('the action set is closed — an unlisted verb does not parse', () => {
    // The reach of the whole surface. A generic method bridge would have made the
    // orchestrator's ~90 callables reachable under one authorization.
    for (const raw of [
      { action: 'setModel', workspace: 'alpha', model: 'anything' },
      { action: 'destroyAgent', workspace: 'alpha' },
      { action: 'job.cancel', workspace: 'alpha' },
      { action: 'workspace.remove', workspace: 'alpha', userId: 'not-a-user-id', confirm: 'alpha' },
      { action: 'approvals.decide', workspace: 'alpha', ids: [], decision: 'approved' },
      { action: 'approvals.decide', workspace: 'alpha', ids: ['x'], decision: 'maybe' },
    ]) {
      expect(v.safeParse(ControlActionSchema, raw).success).toBe(false);
    }
  });

  test('the approval decisions are exactly the ones the store accepts', () => {
    // `DeferredApprovalAnswer` is 'approved' | 'denied' | 'always'. A picklist
    // that drifted from it would refuse a legal answer or forward an illegal one.
    for (const decision of ['approved', 'denied', 'always']) {
      const parsed = v.safeParse(ControlActionSchema, {
        action: 'approvals.decide', workspace: 'alpha', ids: ['x'], decision,
      });
      expect(parsed.success).toBe(true);
    }
  });
});
