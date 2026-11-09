import { afterEach, describe, expect, test } from 'bun:test';
import { BUILTIN_PROFILE_CATALOG, DEV_IDENTITY_ACCOUNT_HEADER, EVAL_WORKSPACE_LEASE_MS, inheritedRows, parseEvalAccount, profileCatalogDigest } from '@kinu.run/core';
import { evalWorkspaceName, scratchDir } from '@kinu.run/test-utils';
import { evalMatrix } from './config';
import { onTrialBlock, prepareTrialAccount, trialAccounts, trialSlot, type SlotClaim } from './slot';
import { leaseBlock } from './lease';
import type { EvalTarget } from './workspace-roster';

const TASK_FILES = ['budget-board.eval.ts', 'chess.eval.ts', 'launch-prep.eval.ts', 'order-book.eval.ts'];

const MATRIX = { models: ['opencode-go/muse', 'openrouter/mercury', 'openrouter/ling'], arms: ['product'], trials: 10, firstSlot: 1, sequence: false };

describe('a trial\'s slot', () => {
  test('every trial of a run has a slot of its own, one to the matrix\'s size, each an eval account', () => {
    const slots = TASK_FILES.flatMap((file) => MATRIX.models.flatMap((model) => Array.from({ length: MATRIX.trials }, (_, at) =>
      trialSlot({ taskFiles: TASK_FILES, task: file, matrix: MATRIX, model, arm: 'product', trial: at + 1 }))));

    expect(new Set(slots).size).toBe(4 * 3 * 10);
    expect(slots.every((slot) => parseEvalAccount(slot) === slot)).toBe(true);
    expect(slots).toContain('trial-1');
    expect(slots).toContain('trial-120');
    expect(() => trialSlot({ taskFiles: TASK_FILES, task: 'freight.eval.ts', matrix: MATRIX, model: 'opencode-go/muse', arm: 'product', trial: 1 }))
      .toThrow();
  });

  test('a matrix past the accounts a deployment has fails at once, saying how many it needs', () => {
    expect(() => trialSlot({ taskFiles: TASK_FILES, task: 'order-book.eval.ts', matrix: { ...MATRIX, trials: 50 }, model: 'openrouter/ling', arm: 'product', trial: 50 }))
      .toThrow('needs 600 trial accounts from trial-1, and its half of a deployment\'s has trial-1 to trial-256');
  });

  // Staging deploy of c9fee59a0: its one-trial pass ran beside evals.yml's ten, and its task i took trial-(i+1), a slot of
  // the measured run's first tasks: three trials were refused as in use or inheriting that run's rows.
  test('a deploy\'s pass and the measured run beside it never share an account', () => {
    const accounts = (env: Record<string, string>, trials: string) => trialAccounts(TASK_FILES, evalMatrix({ ...env, KINU_EVAL_TRIALS: trials }, ['product']));
    const measured = accounts({}, '10');
    const pass = accounts({ KINU_EVAL_PASS: '1' }, '1');

    expect(pass).toHaveLength(TASK_FILES.length);
    expect(new Set(pass).size).toBe(pass.length);
    expect(measured.filter((account) => pass.includes(account))).toEqual([]);
  });

  test('a block placed past its half fails at once, saying which accounts the half has', () => {
    expect(() => trialSlot({ taskFiles: TASK_FILES, task: 'order-book.eval.ts', matrix: { ...MATRIX, firstSlot: 200 }, model: 'openrouter/ling', arm: 'product', trial: 10 }))
      .toThrow('its half of a deployment\'s has trial-1 to trial-256');
    expect(evalMatrix({ KINU_EVAL_FIRST_SLOT: '49' }, ['product']).firstSlot).toBe(49);
  });

});

test('a trial account may hold its provider keys and its own bookkeeping, and nothing else', () => {
  expect(inheritedRows({
    user_credentials: 2, user_credential_revisions: 2, 'account_epochs.credentials_revision': 1, user_profile: 1,
    // The session its sign-in made: a deleted trial account is made again only by signing in (review of 57d67686c).
    user_browser_sessions: 1,
    experience_library: 3, user_mcp_servers: 1, user_config: 0,
  })).toEqual({ experience_library: 3, user_mcp_servers: 1 });
});

// The account's fences share one row: its revocation and credentials counters are its own bookkeeping, but a credential
// floor set at any value, zero included, is an earlier sign-in history.
test('a trial account may hold its revocation and credentials fences, never a credential floor', () => {
  expect(inheritedRows({ 'account_epochs.auth_generation': 1, 'account_epochs.credentials_revision': 1 })).toEqual({});
  expect(inheritedRows({ 'account_epochs.auth_generation': 1, 'account_epochs.credential_floor': 1 })).toEqual({ 'account_epochs.credential_floor': 1 });
});

// 2026-10-19, the owner's plans: a model on a plan login runs every task in the one account that owns the login, so every
// renewal is that account's own; each task opens there in turn.
test('a sequence runs every task of a model, arm and trial in one account, and the run needs one account for each', () => {
  const matrix = { ...MATRIX, trials: 1, firstSlot: 7, sequence: true };
  const places = TASK_FILES.flatMap((task) => matrix.models.map((model) => trialSlot({ taskFiles: TASK_FILES, task, matrix, model, arm: 'product', trial: 1 })));

  expect([...new Set(places)].sort()).toEqual(['trial-7', 'trial-8', 'trial-9']);
  expect(TASK_FILES.map((task) => trialSlot({ taskFiles: TASK_FILES, task, matrix, model: 'openrouter/ling', arm: 'product', trial: 1 })))
    .toEqual(TASK_FILES.map(() => 'trial-9'));
  expect(trialAccounts(TASK_FILES, matrix)).toEqual(['trial-7', 'trial-8', 'trial-9']);
});

test('the stored model catalog is one provisioned row, not a waiver for other configuration or runtime rows', () => {
  expect(inheritedRows({ user_config: 1 }, { catalog: true, gateway: false })).toEqual({});
  expect(inheritedRows({ user_config: 1 })).toEqual({ user_config: 1 });
  expect(inheritedRows({ user_config: 2, experience_library: 3 }, { catalog: true, gateway: false })).toEqual({ user_config: 1, experience_library: 3 });
});

// Staging 2620e7c05, 2026-10-19: a trial account given the deployment's AI Gateway to run a gateway model held
// user_config 1, the selection, and the guard refused it as a row a trial would inherit.
test('the AI Gateway the provisioner selects is one provisioned row, beside the catalog, and nothing more', () => {
  expect(inheritedRows({ user_config: 1 }, { catalog: false, gateway: true })).toEqual({});
  expect(inheritedRows({ user_config: 2 }, { catalog: true, gateway: true })).toEqual({});
  expect(inheritedRows({ user_config: 3, experience_library: 1 }, { catalog: true, gateway: true })).toEqual({ user_config: 1, experience_library: 1 });
});

// Every trial's workspace registers on its account as a device-status watcher, and deleting the workspace leaves the
// row, which the account prunes only when a device moves: on staging f75f06932 the next run's trial on trial-4 refused
// to open on it (2026-10-01).
test("a removed workspace's device-status watcher is no row a trial inherits: it names a workspace no trial opens", () => {
  expect(inheritedRows({ user_profile: 1, device_status_watchers: 1, experience_library: 2 })).toEqual({ experience_library: 2 });
});

/** One deployment as the slot rules read it: the profile, the roster, workspace deletes and the held rows. */
function deployment(state: {
  workspaces: { name: string; lastVisited: number }[];
  readonly held?: Record<string, number>;
  readonly catalogVersion?: number;
  readonly gateway?: string;
}) {
  const deleted: string[] = [];

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER);

      if (url.pathname === '/api/user/workspaces') return Response.json({ entries: state.workspaces, nextCursor: null });

      if (url.pathname === '/api/user/held-rows') return Response.json(state.held ?? { user_credentials: 1, user_profile: 1 });

      if (url.pathname === '/api/user/profile-catalog') return Response.json({
        authority: { kind: 'account', accountId: account ?? 'eval-service' }, version: state.catalogVersion ?? 0,
        digest: profileCatalogDigest(BUILTIN_PROFILE_CATALOG), catalog: BUILTIN_PROFILE_CATALOG,
      });

      // As the product answers it (CredentialsStore.listAIGateways): the selection, read before any Cloudflare call.
      if (url.pathname === '/api/user/cloudflare/gateways') return Response.json({ connected: state.gateway !== undefined, selectedId: state.gateway ?? null, gateways: [], error: null });

      if (request.method === 'DELETE' && url.pathname.startsWith('/api/user/workspaces/')) {
        const name = decodeURIComponent(url.pathname.slice('/api/user/workspaces/'.length));

        deleted.push(name);
        state.workspaces = state.workspaces.filter((workspace) => workspace.name !== name);

        return Response.json({ ok: true });
      }

      return new Response('Not found', { status: 404 });
    },
  });

  const target: EvalTarget = { origin: server.url.origin, identity: { kind: 'loopback', account: 'trial-7' } };

  return { server, deleted, target };
}

const servers: { stop(force: boolean): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

describe('opening on a trial account', () => {
  const now = 10 * EVAL_WORKSPACE_LEASE_MS;

  test('a provisioned model catalog survives opening the trial; another configuration row still stops it', async () => {
    const configured = deployment({ workspaces: [], held: { user_config: 1 }, catalogVersion: 1 });
    const stale = deployment({ workspaces: [], held: { user_config: 2 }, catalogVersion: 1 });

    servers.push(configured.server, stale.server);
    await expect(prepareTrialAccount(configured.target, now)).resolves.toBeUndefined();
    await expect(prepareTrialAccount(stale.target, now)).rejects.toThrow('user_config 1');
  });

  test('a task of a sequence opens on what the sequence\'s earlier tasks left, and still never on a live run', async () => {
    const after = deployment({ workspaces: [], held: { experience_library: 4, workspace_overviews: 1 } });
    const busy = deployment({ workspaces: [{ name: 'eval-other-1-abcdef', lastVisited: now - 5_000 }], held: {} });

    servers.push(after.server, busy.server);
    await expect(prepareTrialAccount(after.target, now, { subject: 'chess-1', sequence: true })).resolves.toBeUndefined();
    await expect(prepareTrialAccount(after.target, now, { subject: 'chess-1', sequence: false })).rejects.toThrow('experience_library 4');
    await expect(prepareTrialAccount(busy.target, now, { subject: 'chess-1', sequence: true })).rejects.toThrow('in use by another run');
  });

  test('so does the AI Gateway a gateway model\'s run selects, beside the catalog', async () => {
    const gated = deployment({ workspaces: [], held: { user_config: 2 }, catalogVersion: 1, gateway: 'kinu-ai-gateway-staging' });
    const stale = deployment({ workspaces: [], held: { user_config: 2 }, catalogVersion: 1 });

    servers.push(gated.server, stale.server);
    await expect(prepareTrialAccount(gated.target, now)).resolves.toBeUndefined();
    await expect(prepareTrialAccount(stale.target, now)).rejects.toThrow('user_config 1');
  });

  // Staging 5c522f12d, 2026-10-19: armada ran a Minecraft trial again (attempt 2) while attempt 1's workspace on its
  // account, trial-33, was still marked live, and the retry was refused as another run's.
  test('a retried trial takes its account back from its own earlier attempt; another run\'s live workspace still stops it', async () => {
    const live = now - 126_000;
    const retried = deployment({ workspaces: [{ name: evalWorkspaceName('minecraft-3'), lastVisited: live }] });
    const rival = deployment({ workspaces: [{ name: evalWorkspaceName('chess-3'), lastVisited: live }] });

    servers.push(retried.server, rival.server);
    await expect(prepareTrialAccount(retried.target, now, { subject: 'minecraft-3', sequence: false })).resolves.toBeUndefined();
    expect(retried.deleted).toHaveLength(1);
    await expect(prepareTrialAccount(rival.target, now, { subject: 'minecraft-3', sequence: false })).rejects.toThrow('in use by another run');
    expect(rival.deleted).toEqual([]);
  });

});

/**
 * A deployment's account routes, as a run's teardown meets them: each request names its account in the dev identity
 * header, and is recorded against it in order. An account's delete is finished by its own jobs `lands` reads later,
 * answering 503 until then and 404 after, as the account object does (`UserDO.ensureProfile`).
 */
function accountsDeployment(holding: Readonly<Record<string, readonly string[]>>, lands = 0) {
  const calls: { account: string; call: string }[] = [];
  const deleted = new Set<string>();
  const deleting = new Map<string, number>();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER) ?? 'eval-service';
      const url = new URL(request.url);
      const call = `${request.method} ${url.pathname}${url.search}`;

      calls.push({ account, call: deleted.has(account) || deleting.has(account) ? `${call} AFTER DELETE` : call });
      const reads = deleting.get(account);

      if (reads !== undefined) {
        if (reads <= 0) {
          deleting.delete(account);
          deleted.add(account);
        } else deleting.set(account, reads - 1);
      }

      if (deleted.has(account)) return Response.json({ error: 'This account was deleted.', code: 'missing' }, { status: 404 });

      if (deleting.has(account)) return Response.json({ error: 'This account is being deleted.', code: 'unavailable' }, { status: 503 });

      if (url.pathname === '/api/user/profile') return Response.json({ email: `eval-service+${account}@kinu.run` });

      if (url.pathname === '/api/user/credentials') return Response.json((holding[account] ?? []).map((key) => ({ key })));

      if (request.method === 'DELETE' && url.pathname === '/api/user/account') deleting.set(account, lands);

      return Response.json({ ok: true });
    },
  });

  return { server, calls, deleted, deleting };
}

const STAGING = 'staging.kinu.run';

describe("a run's trial accounts", () => {
  const block = (origin: string, first: number, last: number) => ({
    targets: Array.from({ length: last - first + 1 }, (_, at) => parseEvalAccount(`trial-${String(first + at)}`))
      .filter((account) => account !== null).map((account) => ({ origin, identity: { kind: 'secret' as const, secret: 's', account } })),
  });

  /** A lease as `leaseBlock` gives it, which says when it was let go. */
  const leased = (first: number, last: number) => {
    const events: string[] = [];

    return {
      events, lease: { first, last, hosts: ['127.0.0.1'], release: async () => { events.push('released'); } },
    };
  };

  // The owner, 2026-11-09: 64 trial accounts left on production, 256 on staging.
  test('a run that ends, fails or is stopped leaves no account of its block, only reads its deletion after, then lets its lease go', async () => {
    const accounts = accountsDeployment({});
    const origin = accounts.server.url.origin;
    const said: string[] = [];
    const say = (line: string): void => { said.push(line); };

    const ended = leased(3, 5);
    const broke = leased(6, 7);

    try {
      expect(await onTrialBlock(ended.lease, block(origin, 3, 5), async () => 'measured', { say })).toBe('measured');
      await expect(onTrialBlock(broke.lease, block(origin, 6, 7), async () => { throw new Error('stopped by SIGTERM'); }, { say })).rejects.toThrow('stopped by SIGTERM');

      expect([...accounts.deleted].sort()).toEqual(['trial-3', 'trial-4', 'trial-5', 'trial-6', 'trial-7']);
      // After its delete, an account is only read for how its deletion stands, which neither makes it again nor notes it.
      expect(accounts.calls.filter(({ call }) => call.endsWith('AFTER DELETE') && call !== 'GET /api/user/profile AFTER DELETE')).toEqual([]);
      expect(said).toEqual(['evals: deleted 3 of the run\'s 3 trial accounts', 'evals: deleted 2 of the run\'s 2 trial accounts']);
      expect([ended.events, broke.events]).toEqual([['released'], ['released']]);
    } finally {
      await accounts.server.stop(true);
    }
  });

  // Its remote trials still acting as the block (a job that has not ended), or a renewal still landing: nothing is deleted.
  test('a teardown whose wait refuses deletes nothing, and still lets the lease go', async () => {
    const accounts = accountsDeployment({});
    const held = leased(1, 2);

    try {
      await expect(onTrialBlock(held.lease, block(accounts.server.url.origin, 1, 2), async () => {}, {
        say: () => {}, before: async () => { throw new Error('armada job j1 has not ended'); },
      })).rejects.toThrow('has not ended');

      expect({ calls: accounts.calls, events: held.events }).toEqual({ calls: [], events: ['released'] });
    } finally {
      await accounts.server.stop(true);
    }
  });

  // A trial account holds logins it does not own: OMP's plan login, the deployment's gateway token. An account's own delete
  // revokes what it holds at the provider, so each goes first, unrevoked.
  test('its logins are disconnected unrevoked before the account is deleted', async () => {
    const accounts = accountsDeployment({ 'trial-1': ['codex.oauth', 'cloudflare.oauth'] });

    try {
      await onTrialBlock(leased(1, 1).lease, block(accounts.server.url.origin, 1, 1), async () => {}, { say: () => {} });
      const writes = accounts.calls.filter(({ call }) => call.startsWith('DELETE')).map(({ call }) => call);

      expect(writes).toEqual(['DELETE /api/user/credentials/codex.oauth?revoke=0', 'DELETE /api/user/credentials/cloudflare.oauth?revoke=0', 'DELETE /api/user/account']);
    } finally {
      await accounts.server.stop(true);
    }
  });

  // Main, 2026-11-09: the account's delete answers once it is marked, and its jobs finish it later; a run that leased
  // the block meanwhile would be refused at its provisioning ("This account is being deleted").
  test("the block is not free again until every account's deletion has finished", async () => {
    const accounts = accountsDeployment({}, 3);
    const dir = scratchDir('trial-leases');
    const none = async (): Promise<SlotClaim[]> => [];
    const reads: (() => void)[] = [];
    const pause = async () => new Promise<void>((read) => { reads.push(read); });
    // The event loop's next turn: the teardown's reads, over a real socket, are answered on a later one.
    const turn = async () => new Promise<void>((next) => { setImmediate(next); });
    const lease = await leaseBlock({ size: 2, pass: false, hosts: [STAGING], liveClaims: none, dir });
    const targets = block(accounts.server.url.origin, 1, 2).targets;

    try {
      const tearing = onTrialBlock(lease, { targets }, async () => {}, { say: () => {}, pause });

      // Each account was deleted, and reads as being deleted: its block is still the run's.
      while (reads.length < 2) await turn();
      const meanwhile = await leaseBlock({ size: 2, pass: false, hosts: [STAGING], liveClaims: none, dir });

      expect({ first: meanwhile.first, deleting: [...accounts.deleting.keys()].sort() }).toEqual({ first: 3, deleting: ['trial-1', 'trial-2'] });
      await meanwhile.release();

      // Its jobs land; the run's teardown reads them deleted and lets the block go.
      while (accounts.deleting.size > 0 || reads.length > 0) {
        for (const read of reads.splice(0)) read();
        await turn();
      }

      await tearing;
      const after = await leaseBlock({ size: 2, pass: false, hosts: [STAGING], liveClaims: none, dir });

      expect({ first: after.first, deleted: [...accounts.deleted].sort() }).toEqual({ first: 1, deleted: ['trial-1', 'trial-2'] });
      await after.release();
    } finally {
      await accounts.server.stop(true);
    }
  });
});
