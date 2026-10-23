// The account's limits over HTTP (core limits/): Settings reads its report, and an operator's invite link is spent once,
// by the signed-in account that opens it, on the control plane's own store.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { LimitsReportSchema, type LimitsReport, type UserCaller } from '@kinu.run/core';
import * as cpStore from '@kinu.run/core/control-plane';
import type { PresentedCaller } from '@kinu.run/core/control-plane';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { AuthIdentity } from '../src/auth/session';
import { bootstrappedProfile, userAccount, workerContext, workspaceObject } from './helpers/bindings';
import { serveFamily } from './helpers/api';
import { sqlExec, TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const OTHER_ID = 'fedcba9876543210fedcba9876543210';

const FREE: LimitsReport = { class: 'free', suspended: null, limits: [], computerSizeCap: 'small' };

const identityOf = (userId: string): AuthIdentity => ({ userId, email: `${userId}@example.com`, sub: 'sub', provider: 'test', authTime: Date.now() });

/** One account's object, and the control plane over a real store: what each account's invite spent is kept here. */
function world() {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  const invitedBy = new Map<string, string>();

  cpStore.initControlPlaneSchema(sql);

  const account = (userId: string) => userAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async userMcp_warmConnections() { return { servers: 0 }; },
    async limits(): Promise<LimitsReport> { return invitedBy.has(userId) ? { ...FREE, class: 'invited', computerSizeCap: null } : FREE; },
    async limits_inviteRedeemed(_caller: UserCaller, by: string) { invitedBy.set(userId, by); },
  });

  const plane = {
    redeemInvite: (_caller: PresentedCaller, token: string, userId: string) => cpStore.redeemInvite(sql, token, userId, Date.now()),
    observeUser: async () => undefined,
    observeWorkspace: async () => undefined,
    touchWorkspace: async () => undefined,
    forgetWorkspace: async () => undefined,
  };

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: (name) => account(name) },
    ControlPlaneDO: { idFromName: (name) => name, get: () => plane },
    // No workspace is asked by these routes.
    OrchestratorAgent: { idFromName: (name) => name, get: () => workspaceObject({}) },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const ask = (userId: string, path: string, method = 'GET') =>
    serveFamily(userRoutes, { identity: identityOf(userId), ctx: workerContext() })(new Request(`https://kinu.example.com${path}`, { method }), env);

  return { sql, ask, invitedBy, close: () => { db.close(); } };
}

describe("the account's limits over HTTP", () => {
  test('Settings reads the report its object makes', async () => {
    const w = world();
    const answer = await w.ask(USER_ID, '/api/user/limits');

    expect(answer?.status).toBe(200);
    expect(v.parse(LimitsReportSchema, await answer?.json())).toEqual(FREE);
    w.close();
  });

  test('an invite link invites the account that opens it once; another account is refused it, and an unknown link is', async () => {
    const w = world();
    const { token } = await cpStore.createInvite(w.sql, 'operator@example.com', Date.now());

    const spent = await w.ask(USER_ID, `/api/user/invite/${token}`, 'POST');

    expect(spent?.status).toBe(200);
    expect(v.parse(LimitsReportSchema, await spent?.json()).class).toBe('invited');
    expect(w.invitedBy.get(USER_ID)).toBe('operator@example.com');

    // Opened again by its own account it answers as before; by another, it is spent.
    expect((await w.ask(USER_ID, `/api/user/invite/${token}`, 'POST'))?.status).toBe(200);
    expect((await w.ask(OTHER_ID, `/api/user/invite/${token}`, 'POST'))?.status).toBe(409);
    expect(w.invitedBy.has(OTHER_ID)).toBe(false);
    expect((await w.ask(OTHER_ID, '/api/user/invite/inv_none', 'POST'))?.status).toBe(404);
    w.close();
  });
});
