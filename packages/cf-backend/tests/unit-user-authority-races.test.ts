// Authority that was WITHDRAWN, against calls that were already in flight.
//
// Every case here is an interleaving, not a state: a Durable Object serializes
// nothing across an await, so between a call's read and its write another call
// runs to completion. Each test drives that second call at the exact point the
// first is waiting — on a workspace teardown, on a provider's token endpoint, on
// a device-code approval, on a websocket frame — and asserts that the authority
// the owner took away cannot act, cannot be re-issued, and cannot be written
// back by a reply that was already in the air.
//
// The doubles here are the real objects wherever the race lives in one: a real
// UserDO over bun:sqlite, and (for the socket cases) a real OrchestratorAgent
// holding the capability token that UserDO actually minted for it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CODEX_CRED_KEY,
  CODEX_TOKEN_URL,
  asFetchFunction,
} from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import {
  createTestUserDO,
  createdWorkspace,
  provisionTestWorkspace,
  testOwner,
  TEST_CREDENTIAL_ENCRYPTION_KEY,
  type TestUserDO,
} from './helpers/user-do';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { CapabilityDeniedError, type UserCaller } from '../src/user/workspace-capability';
import { cliBearerConnectionTag, cliBearerFromTags } from '../src/cli/rpc-gate';
import { sha256Hex } from '../src/lib/crypto';
import type { Connection } from 'agents';

const USER_ID = '0123456789abcdef0123456789abcdef';
const AUTHORIZATION = 'c'.repeat(64);

const realFetch = globalThis.fetch;
beforeEach(() => { setDiagnosticsSink(createRecordingLogger()); });
afterEach(() => { globalThis.fetch = realFetch; });

/** One OAuth token-endpoint body, as the provider returns it. */
interface CodexTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** One device-code start body. */
interface CodexUserCode {
  user_code: string;
  device_auth_id: string;
  interval: number;
}

/** One device-code poll body: the approval, ready to exchange. */
interface CodexApproval {
  authorization_code: string;
  code_verifier: string;
}

/** A promise a test resolves by hand — how a teardown or a token endpoint is
 *  held open at the exact instant another call has to run. */
function gate() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => { open = () => resolve(); });
  return { promise, open };
}

function capabilityRows(harness: TestUserDO): string[] {
  return harness.db.prepare<{ workspace_name: string }, []>(
    `SELECT workspace_name FROM workspace_capability_tokens ORDER BY workspace_name`,
  ).all().map((row) => row.workspace_name);
}

describe('a workspace whose delete has begun', () => {
  test('has already lost its authority when the teardown is still in flight', async () => {
    const held = gate();
    const harness = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceGate: () => held.promise,
    });
    const owner = await testOwner();
    const token = await provisionTestWorkspace(harness, 'doomed');
    const survivor = await provisionTestWorkspace(harness, 'survivor');

    const deleting = harness.userDO.removeWorkspace(owner, 'doomed', USER_ID);
    // The delete is now parked on the destroy — the window in which the old
    // order (revoke AFTER the teardown) left the dying workspace holding a
    // token its own registry still honoured.
    await Promise.resolve();

    const doomedCaller: UserCaller = { workspaceToken: token };
    await expect(harness.userDO.listWorkspaces(doomedCaller)).rejects.toThrow(CapabilityDeniedError);
    await expect(harness.userDO.getAuthHeaders(doomedCaller, 'openai.bearer'))
      .rejects.toThrow(CapabilityDeniedError);
    await expect(harness.userDO.deviceRpc(doomedCaller, 'exec', ['ls'])).rejects.toThrow(CapabilityDeniedError);
    // Fenced, not broken: the workspace beside it is untouched. Read through
    // the exact listing, which is the one roster read that does NOT drive the
    // pending-teardown retry — the retry is parked on the gate this test holds.
    expect((await harness.userDO.listActiveWorkspaces({ workspaceToken: survivor })).map((row) => row.name))
      .toEqual(['survivor']);
    // And no identity remains that a same-name recreate could inherit.
    expect(capabilityRows(harness)).toEqual(['survivor']);

    held.open();
    await deleting;
    expect(harness.destroyedWorkspaces).toEqual(['doomed']);
    harness.close();
  });

  test('cannot be issued a fresh identity while its teardown is outstanding', async () => {
    const harness = createTestUserDO({
      durableObjectId: USER_ID,
      destroyWorkspaceError: 'the container refused to go',
    });
    const owner = await testOwner();
    const token = await provisionTestWorkspace(harness, 'doomed');

    await expect(harness.userDO.removeWorkspace(owner, 'doomed', USER_ID)).rejects.toThrow('refused to go');

    // The row survives because the teardown is still owed — but the authority
    // does not, which is what a fail-closed teardown used to get backwards: the
    // marked row kept its live capability token indefinitely.
    expect(harness.db.prepare<{ delete_pending: number }, []>(
      `SELECT delete_pending FROM user_workspaces WHERE name = 'doomed'`,
    ).all()).toEqual([{ delete_pending: 1 }]);
    await expect(harness.userDO.listWorkspaces({ workspaceToken: token }))
      .rejects.toThrow(CapabilityDeniedError);
    expect(capabilityRows(harness)).toEqual([]);

    // Nothing re-mints it, either: the front door refuses the name, and the
    // refusal writes nothing a later commit could authenticate against.
    await expect(harness.userDO.ensureWorkspaceCapability('doomed', null))
      .rejects.toThrow(/not in your registry|being deleted/);
    expect(capabilityRows(harness)).toEqual([]);
    expect(harness.installed.get('doomed')).toBe(token);
    harness.close();
  });

  test('gets one identity, not two, when concurrent first-touches race', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.registerWorkspace(owner, 'fresh');

    await Promise.all([
      harness.userDO.ensureWorkspaceCapability('fresh', null),
      harness.userDO.ensureWorkspaceCapability('fresh', null),
      harness.userDO.ensureWorkspaceCapability('fresh', null),
    ]);

    // The surviving stored hash and the surviving installed token are from ONE
    // mint, which is the only way the workspace can authenticate at all.
    const installed = harness.installed.get('fresh');
    expect(installed).toMatch(/^pwc_/);
    expect(harness.db.prepare<{ token_hash: string }, []>(
      `SELECT token_hash FROM workspace_capability_tokens WHERE workspace_name = 'fresh'`,
    ).all()).toEqual([{ token_hash: await sha256Hex(installed ?? '') }]);
    expect((await harness.userDO.listWorkspaces({ workspaceToken: installed ?? '' })).entries)
      .toHaveLength(1);
    harness.close();
  });
});

describe('a credential the owner moved while a provider was answering', () => {
  /** A stored Codex login, as the device flow leaves one. */
  async function connectedCodex(harness: TestUserDO): Promise<void> {
    await harness.userDO.setCredential(await testOwner(), CODEX_CRED_KEY, {
      kind: 'oauth', accessToken: 'access-original', refreshToken: 'refresh-original',
    });
  }

  /** A token endpoint that runs `during` before it answers — the interleaving
   *  every test in this block is about. */
  function tokenEndpoint(during: () => Promise<void>, body: CodexTokens): void {
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL) => {
      if (String(input) !== CODEX_TOKEN_URL) throw new Error(`unexpected fetch: ${String(input)}`);
      await during();
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
  }

  test('a rotation that lands after a disconnect does not reconnect the account', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await connectedCodex(harness);
    tokenEndpoint(
      () => harness.userDO.disconnectCodex(owner),
      { access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 },
    );

    const headers = await harness.userDO.getAuthHeaders(owner, CODEX_CRED_KEY, { forceRefresh: true });

    // The owner disconnected mid-flight, so the reply is dropped rather than
    // written back. Pre-fix this rewrote the row and the account came back
    // connected with freshly rotated tokens nobody had asked for.
    expect(headers).toBeNull();
    expect((await harness.userDO.listCredentials(owner)).map((row) => row.key)).toEqual([]);
    expect((await harness.userDO.getCodexStatus(owner)).connected).toBe(false);
    harness.close();
  });

  test('a rotation that lands after a replacement does not clobber it', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await connectedCodex(harness);
    tokenEndpoint(
      () => harness.userDO.setCredential(owner, CODEX_CRED_KEY, {
        kind: 'oauth', accessToken: 'access-from-owner', refreshToken: 'refresh-from-owner',
      }),
      { access_token: 'access-rotated', refresh_token: 'refresh-rotated', expires_in: 3600 },
    );

    const headers = await harness.userDO.getAuthHeaders(owner, CODEX_CRED_KEY, { forceRefresh: true });

    // The store is the authority: the answer is the credential the OWNER wrote,
    // and the rotation derived from its predecessor is discarded.
    expect(headers).toMatchObject({ Authorization: 'Bearer access-from-owner' });
    expect(JSON.stringify(headers)).not.toContain('access-rotated');
    expect((await harness.userDO.getCodexStatus(owner)).connected).toBe(true);
  });

  test('a provider rejection does not delete the login that replaced the rejected one', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await connectedCodex(harness);
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL) => {
      if (String(input) !== CODEX_TOKEN_URL) throw new Error(`unexpected fetch: ${String(input)}`);
      await harness.userDO.setCredential(owner, CODEX_CRED_KEY, {
        kind: 'oauth', accessToken: 'access-from-owner', refreshToken: 'refresh-from-owner',
      });
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    });

    await harness.userDO.getAuthHeaders(owner, CODEX_CRED_KEY, { forceRefresh: true });

    // `invalid_grant` retires the credential it was refused for — never the one
    // the owner signed in with while the refusal was travelling. Read through
    // the status, which reports the stored credential without asking the
    // provider again: a second refresh against this stub would be a second,
    // legitimate rejection of the credential that is now current.
    expect((await harness.userDO.listCredentials(owner)).map((row) => row.key)).toEqual([CODEX_CRED_KEY]);
    expect((await harness.userDO.getCodexStatus(owner)).connected).toBe(true);
    harness.close();
  });
});

describe('a device-code sign-in the owner superseded', () => {
  const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
  const POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';

  /** The provider, answering a device-code flow. `duringExchange` runs at the
   *  final token exchange — the last await a poll makes before it would write. */
  function codexProvider(options: {
    userCode: () => string;
    duringExchange?: () => Promise<void>;
  }): void {
    globalThis.fetch = asFetchFunction(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: CodexTokens | CodexUserCode | CodexApproval): Response => new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      if (url === USERCODE_URL) {
        return json({ user_code: options.userCode(), device_auth_id: `auth-${options.userCode()}`, interval: 5 });
      }
      if (url === POLL_URL) return json({ authorization_code: 'code', code_verifier: 'verifier' });
      if (url === CODEX_TOKEN_URL) {
        await options.duringExchange?.();
        return json({ access_token: 'access-approved', refresh_token: 'refresh-approved', expires_in: 3600 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  test('cannot connect the account after a disconnect closed it', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    codexProvider({
      userCode: () => 'AAAA-BBBB',
      duringExchange: () => harness.userDO.disconnectCodex(owner),
    });
    await harness.userDO.startCodexDeviceFlow(owner);

    const polled = await harness.userDO.pollCodexDeviceFlow(owner);

    expect(polled.connected).toBe(false);
    expect(polled.error).toContain('superseded');
    expect((await harness.userDO.getCodexStatus(owner)).connected).toBe(false);
    expect((await harness.userDO.listCredentials(owner)).map((row) => row.key)).toEqual([]);
    harness.close();
  });

  test('cannot land its tokens on the attempt that replaced it', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    let code = 'AAAA-BBBB';
    codexProvider({
      userCode: () => code,
      duringExchange: async () => {
        // The owner gave up on the first code and asked for another one; that
        // second attempt is the only one they are looking at now.
        code = 'CCCC-DDDD';
        await harness.userDO.startCodexDeviceFlow(owner);
      },
    });
    await harness.userDO.startCodexDeviceFlow(owner);

    const polled = await harness.userDO.pollCodexDeviceFlow(owner);

    expect(polled.connected).toBe(false);
    expect(polled.error).toContain('superseded');
    // The newer attempt is still open and still the one on screen — pre-fix the
    // stale reply wrote its own tokens and deleted this row out from under it.
    expect((await harness.userDO.getCodexStatus(owner)).startedFlow)
      .toMatchObject({ userCode: 'CCCC-DDDD' });
    expect((await harness.userDO.listCredentials(owner)).map((row) => row.key)).toEqual([]);
    harness.close();
  });

  test('a sign-in nothing superseded still connects, once', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    codexProvider({ userCode: () => 'AAAA-BBBB' });
    await harness.userDO.startCodexDeviceFlow(owner);

    expect(await harness.userDO.pollCodexDeviceFlow(owner)).toMatchObject({ connected: true });
    expect((await harness.userDO.getCodexStatus(owner)).connected).toBe(true);
    // The settled attempt is no longer a portal page the owner is being sent to.
    expect((await harness.userDO.getCodexStatus(owner)).startedFlow).toBeNull();
    // And a second poll of the same attempt cannot mint a second credential.
    expect(await harness.userDO.pollCodexDeviceFlow(owner))
      .toMatchObject({ connected: false, error: expect.stringContaining('No device flow in progress') });
    harness.close();
  });
});

describe('one browser approval mints one CLI token', () => {
  test('a second redemption of the same authorization is refused', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();

    const first = await harness.userDO.mintCliToken(owner, USER_ID, AUTHORIZATION, 'terminal');
    await expect(harness.userDO.mintCliToken(owner, USER_ID, AUTHORIZATION, 'terminal'))
      .rejects.toThrow('already been redeemed');

    expect((await harness.userDO.listCliTokens(owner)).map((row) => row.tokenHash))
      .toEqual([first.tokenHash]);
    harness.close();
  });

  test('two polls racing on one approval produce exactly one token', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();

    // The KV record both polls read said `approved`; the claim that decides is
    // the mint's own, in the object that owns CLI tokens.
    const settled = await Promise.allSettled([
      harness.userDO.mintCliToken(owner, USER_ID, AUTHORIZATION, 'terminal'),
      harness.userDO.mintCliToken(owner, USER_ID, AUTHORIZATION, 'terminal'),
    ]);

    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await harness.userDO.listCliTokens(owner)).toHaveLength(1);
    harness.close();
  });

  test('a different approval still mints its own token', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();

    await harness.userDO.mintCliToken(owner, USER_ID, AUTHORIZATION, 'laptop');
    await harness.userDO.mintCliToken(owner, USER_ID, 'd'.repeat(64), 'desktop');

    expect((await harness.userDO.listCliTokens(owner)).map((row) => row.label).sort())
      .toEqual(['desktop', 'laptop']);
    harness.close();
  });
});

describe('a CLI bearer revoked under a live websocket', () => {
  /** The connection the platform hands `onMessage`: tags and a wire, which is
   *  all a restored-from-hibernation connection has. */
  interface FakeConnection {
    tags: string[];
    sent: string[];
    closed: Array<{ code: number; reason: string }>;
  }

  function connection(tags: string[]) {
    const fake: FakeConnection = { tags, sent: [], closed: [] };
    const partial: Partial<Connection> = {};
    Object.assign(partial, {
      id: 'conn-1',
      tags,
      send: (data: string) => { fake.sent.push(data); },
      close: (code: number, reason: string) => { fake.closed.push({ code, reason }); },
    });
    // SAFETY: every member the frame gate touches is constructed above — the
    // platform's contract for a hibernated connection carries its tags and its
    // wire and nothing else, so no other part of Connection is reachable from
    // the code under test.
    const wire = partial as Connection;
    return { fake, wire };
  }

  interface Rail {
    user: TestUserDO;
    actor: ActorHarness<HarnessOrchestratorAgent>;
    tokenHash: string;
    bearerTag: string;
  }

  async function rail(): Promise<Rail> {
    const user = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const capability = await provisionTestWorkspace(user, 'harness-actor');
    const minted = await user.userDO.mintCliToken(owner, USER_ID, AUTHORIZATION, 'ci runner');
    const actor = orchestratorHarness(undefined, {
      userDO: user.userDO, workspace: 'harness-actor', ownerUserId: USER_ID,
    });
    actor.agent.harnessHoldsCapability(capability);
    const bearerTag = cliBearerConnectionTag(`${minted.tokenHash}:0`) ?? '';
    return { user, actor, tokenHash: minted.tokenHash, bearerTag };
  }

  /** A frame the SCOPE gate refuses on a scoped connection. It is the probe for
   *  the ordering under test: the bearer gate runs FIRST, so a live bearer
   *  reaches this refusal (an rpc-error frame, socket intact) and a revoked one
   *  never gets that far (a close, with the revocation's own words). Refusing
   *  the frame downstream is also what keeps this off the agents-SDK dispatcher,
   *  which under bun is a stub the real Agent constructor would have installed. */
  const scopedFrame = JSON.stringify({ type: 'rpc', id: 'r1', method: 'destroyAgent', args: [] });
  const scopedTags = (bearerTag: string): string[] => [bearerTag, 'cli-scopes:workspace.read'];

  test('the bearer rides the connection tags, and an unreadable one fails closed', () => {
    const tag = cliBearerConnectionTag(`${'a'.repeat(64)}:7`);
    expect(cliBearerFromTags([tag ?? ''])).toEqual({
      readable: true, tokenHash: 'a'.repeat(64), generation: 7,
    });
    // No CLI bearer at all — a browser session, which pays for nothing.
    expect(cliBearerFromTags(['cli-scopes:workspace.read'])).toBeNull();
    // A bearer header that does not parse is still a CLI connection, and one
    // whose authority cannot be read is refused rather than waved through.
    expect(cliBearerFromTags([cliBearerConnectionTag('garbage') ?? ''])).toEqual({ readable: false });
    expect(cliBearerConnectionTag(null)).toBeNull();
  });

  test('a live bearer is let through, and a revoked one is refused and closed', async () => {
    const { user, actor, tokenHash, bearerTag } = await rail();
    const owner = await testOwner();
    const live = connection(scopedTags(bearerTag));

    await actor.agent.onMessage(live.wire, scopedFrame);

    // Past the bearer gate: the socket is intact and the answer came from the
    // scope gate downstream of it.
    expect(live.fake.closed).toEqual([]);
    expect(JSON.parse(live.fake.sent[0] ?? '{}')).toMatchObject({
      type: 'rpc', id: 'r1', success: false, error: expect.stringContaining('not remotely invokable'),
    });

    // The owner revokes it. Nothing about the socket changes — it is the same
    // connection, with the same tags, mid-session.
    expect(await user.userDO.revokeCliTokenHash(owner, tokenHash)).toEqual({ ok: true });

    const after = connection(scopedTags(bearerTag));
    await actor.agent.onMessage(after.wire, scopedFrame);

    expect(after.fake.closed).toEqual([
      { code: 1008, reason: 'This CLI authorization is no longer valid. Sign in again with: kinu auth' },
    ]);
    // The pending call is answered rather than left hanging on a socket that is
    // about to disappear — and answered by the BEARER gate, not the scope one.
    expect(JSON.parse(after.fake.sent[0] ?? '{}')).toMatchObject({
      type: 'rpc', id: 'r1', success: false, error: expect.stringContaining('no longer valid'),
    });
    user.close();
  });

  test('hibernation does not launder it: the same tags refuse on a fresh activation', async () => {
    const { user, actor, tokenHash, bearerTag } = await rail();
    const owner = await testOwner();
    await user.userDO.revokeCliTokenHash(owner, tokenHash);

    // A connection restored from its attachment carries tags and nothing else,
    // which is exactly why the bearer had to be ON the tags: before that, a
    // woken socket had its scopes and no identity to check at all.
    const restored = connection(scopedTags(bearerTag));
    await actor.agent.onMessage(restored.wire, scopedFrame);

    expect(restored.fake.closed).toHaveLength(1);
    user.close();
  });

  test('a revocation closes the sockets it predates without waiting for a frame', async () => {
    const { user, actor, bearerTag } = await rail();
    const stale = connection([bearerTag]);
    const admittedAfter = connection([cliBearerConnectionTag(`${'b'.repeat(64)}:5`) ?? '']);
    const browser = connection(['cli-scopes:workspace.read']);
    // SAFETY: the platform supplies the connection set; the mocked Agent base
    // under bun has none, so the sockets this test is about are supplied here.
    Object.defineProperty(actor.agent, 'getConnections', {
      configurable: true,
      value: () => [stale.wire, admittedAfter.wire, browser.wire],
    });

    expect(await actor.agent.closeRevokedCliSockets(5)).toEqual({ closed: 1 });

    // A socket that never speaks would otherwise keep receiving this
    // workspace's stream for as long as it liked.
    expect(stale.fake.closed).toHaveLength(1);
    expect(admittedAfter.fake.closed).toEqual([]);
    expect(browser.fake.closed).toEqual([]);
    user.close();
  });

  test('the UserDO answers the frame-time question and pushes the close out', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await provisionTestWorkspace(harness, 'workspace-a');
    const minted = await harness.userDO.mintCliToken(owner, USER_ID, AUTHORIZATION, 'ci runner');

    expect(await harness.userDO.verifyCliSocketBearer(owner, minted.tokenHash))
      .toEqual({ live: true, generation: 0 });

    await harness.userDO.revokeCliTokenHash(owner, minted.tokenHash);

    const verified = await harness.userDO.verifyCliSocketBearer(owner, minted.tokenHash);
    expect(verified.live).toBe(false);
    expect(verified.generation).toBe(1);
    // The revocation reached the workspace holding the socket, under the
    // generation it must now beat.
    expect(harness.revokedSocketPushes).toEqual(['workspace-a:1']);

    // An access-token revocation moves the same counter, so one comparison
    // covers every kind of bearer.
    await harness.userDO.revokeAccessToken(owner, 'nothing-by-that-name');
    expect((await harness.userDO.verifyCliSocketBearer(owner, minted.tokenHash)).generation).toBe(2);
    harness.close();
  });
});

describe('creating a workspace whose name is already taken', () => {
  test('returns the workspace that is there, stably, and reinitializes nothing', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();

    const created = createdWorkspace(await harness.userDO.registerWorkspace(owner, 'jarvis', 'Jarvis'));
    const again = await harness.userDO.registerWorkspace(owner, 'jarvis', 'A different title', 'a new mission');
    const third = await harness.userDO.registerWorkspace(owner, 'jarvis');

    expect(again.status).toBe('active');
    expect(third.status).toBe('active');
    // The row's own identity, every time: same name, same birth, same title.
    // A fresh `createdAt` on the conflict branch also meant a rollback could
    // never match the row it was trying to release.
    expect(again).toMatchObject({ entry: { name: 'jarvis', displayName: 'Jarvis', createdAt: created.createdAt } });
    expect(third).toMatchObject({ entry: { displayName: 'Jarvis', createdAt: created.createdAt } });
    expect((await harness.userDO.getWorkspaceTitle(owner, 'jarvis')))
      .toEqual({ displayName: 'Jarvis', nameOrigin: 'user' });
    harness.close();
  });

  test('refuses a name an unfinished fork transfer is holding, and leaves it alone', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    const reserved = await harness.userDO.reserveWorkspace(owner, 'in-flight', 'Fork target');

    const registered = await harness.userDO.registerWorkspace(owner, 'in-flight', 'Hijacked', 'another mission');

    expect(registered).toEqual({ status: 'reserved' });
    // The reservation is untouched: same title, still unpublished, still the
    // transfer's to commit. Pre-fix this rewrote its title and let the create
    // run a whole birth sequence into the workspace being streamed into.
    expect(harness.db.prepare<{ display_name: string; create_pending: number }, []>(
      `SELECT display_name, create_pending FROM user_workspaces WHERE name = 'in-flight'`,
    ).all()).toEqual([{ display_name: 'Fork target', create_pending: 1 }]);
    await harness.userDO.publishWorkspaceReservation(owner, 'in-flight', reserved.entry.createdAt, null);
    expect(await harness.userDO.hasWorkspace(owner, 'in-flight')).toBe(true);
    harness.close();
  });
});

/** The harness env every socket test above reads. Declared here so the file
 *  fails loudly if the credential key it is built with ever drifts from the one
 *  the capability derivation uses. */
test('the suite drives the real owner capability derivation', () => {
  expect(TEST_CREDENTIAL_ENCRYPTION_KEY).toBe('test-credential-encryption-key-0123456789');
});
