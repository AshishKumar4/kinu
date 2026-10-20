import { afterEach, describe, expect, test } from 'bun:test';
import { BUILTIN_PROFILE_CATALOG, DEV_IDENTITY_ACCOUNT_HEADER, EVAL_WORKSPACE_LEASE_MS, inheritedRows, parseEvalAccount, profileCatalogDigest } from '@kinu.run/core';
import { evalWorkspaceName } from '@kinu.run/test-utils';
import { evalMatrix } from './config';
import { claimLabel, claimOf, freeBlock, prepareTrialAccount, trialAccounts, trialSlot } from './slot';
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

  // Staging 5c522f12d, 2026-10-19: a deploy's runs and an operator's ran on trial accounts each chose alone, and only the
  // per-trial guard kept them apart. A run now takes a block no open run's claim holds on the same deployment.
  test('a run takes the lowest block of its half that no open run on its deployment claims', () => {
    const staging = 'staging.kinu.run';
    const held = [claimOf(claimLabel('5c522f12d44f', { first: 1, last: 48, hosts: [staging] }))].filter((claim) => claim !== null);

    expect(held).toEqual([{ first: 1, last: 48, hosts: [staging] }]);
    expect(freeBlock(40, false, [staging], held)).toBe(49);
    expect(freeBlock(40, false, ['kinu.run'], held)).toBe(1);
    expect(freeBlock(8, true, [staging, 'kinu.run'], held)).toBe(257);
    expect(freeBlock(40, false, [staging], [...held, { first: 49, last: 230, hosts: [staging] }])).toBeNull();
    expect(claimOf('rc21')).toBeNull();
  });

  test('a block placed past its half fails at once, saying which accounts the half has', () => {
    expect(() => trialSlot({ taskFiles: TASK_FILES, task: 'order-book.eval.ts', matrix: { ...MATRIX, firstSlot: 200 }, model: 'openrouter/ling', arm: 'product', trial: 10 }))
      .toThrow('its half of a deployment\'s has trial-1 to trial-256');
    expect(evalMatrix({ KINU_EVAL_FIRST_SLOT: '49' }, ['product']).firstSlot).toBe(49);
  });

});

test('a trial account may hold its provider keys and its own bookkeeping, and nothing else', () => {
  expect(inheritedRows({
    user_credentials: 2, user_credential_revisions: 2, user_credentials_revision: 1, user_profile: 1,
    experience_library: 3, user_mcp_servers: 1, user_config: 0,
  })).toEqual({ experience_library: 3, user_mcp_servers: 1 });
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
