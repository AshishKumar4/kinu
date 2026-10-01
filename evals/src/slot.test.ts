import { afterEach, describe, expect, test } from 'bun:test';
import { DEV_IDENTITY_ACCOUNT_HEADER, parseEvalAccount } from '@kinu.run/core';
import { WORKSPACE_LEASE_MS } from './session';
import { claimTrialAccount, inheritedRows, prepareTrialAccount, sharedAccounts, trialAccountsAt, trialSlot } from './slot';
import type { EvalTarget } from './target';

const TASK_FILES = ['budget-board.eval.ts', 'chess.eval.ts', 'launch-prep.eval.ts', 'order-book.eval.ts'];

const MATRIX = { models: ['opencode-go/muse', 'openrouter/mercury', 'openrouter/ling'], arms: ['product'], trials: 10 };

describe('a trial\'s slot', () => {
  test('every trial of a run has a slot of its own, one to the matrix\'s size, each an eval account', () => {
    const slots = TASK_FILES.flatMap((file) => MATRIX.models.flatMap((model) => Array.from({ length: MATRIX.trials }, (_, at) =>
      trialSlot({ taskFiles: TASK_FILES, task: file.replace('.eval.ts', ''), matrix: MATRIX, model, arm: 'product', trial: at + 1 }))));

    expect(new Set(slots).size).toBe(4 * 3 * 10);
    expect(slots.every((slot) => parseEvalAccount(slot) === slot)).toBe(true);
    expect(slots).toContain('trial-1');
    expect(slots).toContain('trial-120');
  });

  test('a matrix past the accounts a deployment has fails at once, saying how many it needs', () => {
    expect(() => trialSlot({ taskFiles: TASK_FILES, task: 'order-book', matrix: { ...MATRIX, trials: 50 }, model: 'openrouter/ling', arm: 'product', trial: 50 }))
      .toThrow('needs 600 trial accounts, and a deployment has trial-1 to trial-512');
  });

  test('a task not named after its file has no place in the matrix, and says so', () => {
    expect(() => trialSlot({ taskFiles: TASK_FILES, task: 'freight', matrix: MATRIX, model: 'opencode-go/muse', arm: 'product', trial: 1 }))
      .toThrow('task freight is not evals/tasks/freight.eval.ts');
  });
});

test('a trial account may hold its provider keys and its own bookkeeping, and nothing else', () => {
  expect(inheritedRows({
    user_credentials: 2, user_credential_revisions: 2, user_credentials_revision: 1, user_profile: 1, user_schema_meta: 1,
    experience_library: 3, user_mcp_servers: 1, user_config: 0,
  })).toEqual({ experience_library: 3, user_mcp_servers: 1 });
});

/** One deployment as the slot rules read it: the profile, the roster, workspace deletes and the held rows. */
function deployment(state: {
  readonly takesTrials: 'yes' | 'refuses' | 'ignores';
  workspaces: { name: string; lastVisited: number }[];
  readonly held?: Record<string, number>;
}) {
  const deleted: string[] = [];

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER);

      if (url.pathname === '/api/user/profile') {
        if (state.takesTrials === 'refuses' && account !== null) {
          return Response.json({ error: `Unknown eval account "${account}": one of devices, scripted` }, { status: 400 });
        }

        const plus = state.takesTrials === 'yes' && account !== null ? `+${account}` : '';

        return Response.json({ email: `eval-service${plus}@kinu.run` });
      }

      if (url.pathname === '/api/user/workspaces') return Response.json({ entries: state.workspaces, nextCursor: null });

      if (url.pathname === '/api/user/held-rows') return Response.json(state.held ?? { user_credentials: 1, user_profile: 1 });

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

describe('a deployment\'s trial accounts', () => {
  test('a deployment answers a trial account as a user of its own, refuses it, or ignores it, and each is told apart', async () => {
    const yes = deployment({ takesTrials: 'yes', workspaces: [] });
    const refuses = deployment({ takesTrials: 'refuses', workspaces: [] });
    const ignores = deployment({ takesTrials: 'ignores', workspaces: [] });

    servers.push(yes.server, refuses.server, ignores.server);
    expect(await trialAccountsAt({ origin: yes.target.origin, identity: { kind: 'loopback' } })).toEqual({ kind: 'trial' });
    expect(await trialAccountsAt({ origin: refuses.target.origin, identity: { kind: 'loopback' } }))
      .toEqual({ kind: 'shared', why: expect.stringContaining('refuses trial accounts') });
    expect(await trialAccountsAt({ origin: ignores.target.origin, identity: { kind: 'loopback' } }))
      .toEqual({ kind: 'shared', why: expect.stringContaining('answers trial-1 as eval-service@kinu.run') });
  });
});

describe('opening on a trial account', () => {
  const now = 10 * WORKSPACE_LEASE_MS;

  test('a workspace a stopped run left is deleted, and an account holding nothing inheritable is opened on', async () => {
    const { server, deleted, target } = deployment({ takesTrials: 'yes', workspaces: [{ name: 'eval-order-book-3-old111', lastVisited: now - WORKSPACE_LEASE_MS }] });

    servers.push(server);
    await prepareTrialAccount(target, now);
    expect(deleted).toEqual(['eval-order-book-3-old111']);
  });

  test('a workspace another run marks live means the account is in use: nothing is deleted, and it is named', async () => {
    const { server, deleted, target } = deployment({
      takesTrials: 'yes',
      workspaces: [{ name: 'eval-order-book-3-old111', lastVisited: now - WORKSPACE_LEASE_MS }, { name: 'eval-order-book-3-live22', lastVisited: now - 5_000 }],
    });

    servers.push(server);
    expect(prepareTrialAccount(target, now)).rejects.toThrow('trial-7 is in use by another run: its workspace eval-order-book-3-live22 was marked live 5s ago');
    expect(deleted).toEqual([]);
  });

  test('a row a trial could inherit stops the trial, naming each table and its rows', async () => {
    const { server, target } = deployment({
      takesTrials: 'yes', workspaces: [], held: { user_credentials: 1, experience_library: 2, user_mcp_servers: 1 },
    });

    servers.push(server);
    expect(prepareTrialAccount(target, now)).rejects.toThrow('trial-7 holds rows a trial would inherit: experience_library 2, user_mcp_servers 1');
  });

  test('two runs that open on one account at once: the earlier workspace name keeps it, the later one gives it up', async () => {
    const { server, target } = deployment({
      takesTrials: 'yes',
      workspaces: [{ name: 'eval-order-book-3-aaaaaa', lastVisited: now }, { name: 'eval-order-book-3-bbbbbb', lastVisited: now }],
    });

    servers.push(server);
    await claimTrialAccount(target, 'eval-order-book-3-aaaaaa', now);
    expect(claimTrialAccount(target, 'eval-order-book-3-bbbbbb', now))
      .rejects.toThrow('trial-7 was opened on by another run at the same moment (eval-order-book-3-aaaaaa)');
  });
});

test('a report names the account its trials shared, when they did not each act as their own', () => {
  const report = (accounts: (string | undefined)[]) => JSON.stringify({ testResults: [{ assertionResults: accounts.map((account) => ({
    status: 'passed', meta: { harness: { run: { session: { metadata: account === undefined ? {} : { account } } } } },
  })) }] });

  expect(sharedAccounts(report(['trial-1', 'trial-2']))).toBeUndefined();
  expect(sharedAccounts(report(['trial-1', 'eval-service (https://kinu.run refuses trial accounts, so its trials share eval-service)'])))
    .toBe('its trials shared eval-service (https://kinu.run refuses trial accounts, so its trials share eval-service), so they could reach each other');
  expect(sharedAccounts(report([undefined]))).toBe('its trials shared eval-service, so they could reach each other');
});
