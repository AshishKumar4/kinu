// Defends: an overview that names the wrong agent, loses who touched an issue, shows a stale state over what GitHub
// said since, or forgets a repository the workspace only has as a git remote.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeExecRaw, makeSql } from './helpers';
import { Effect } from 'effect';
import { initGitHubActivityTable, readGitHubActivity, recordGitHubActivity, recordGitHubObservations, type WorkspaceGitHub } from '../src/github/activity';
import { refreshGitHub } from '../src/github/refresh';
import { readGitHubRemotes } from '../src/github/remotes';
import type { JsonValue } from '../src/utils/json';

function workspace() {
  const db = new Database(':memory:');
  const sql = makeSql(db);

  initGitHubActivityTable(makeExecRaw(db));

  return { sql };
}

describe('the workspace\'s GitHub record, as the overview reads it', () => {
  test('an issue keeps every agent that acted on it; one through a seam that cannot name it reads as unattributed', () => {
    const { sql } = workspace();

    recordGitHubActivity(sql, [{ action: 'opened', subject: 'issue', repo: 'acme/checkout', number: 41, title: 'SAVE20 500s', state: 'open' }],
      { actorId: 'main', source: 'mcp', at: 1 });
    recordGitHubActivity(sql, [{ action: 'touched', subject: 'issue', repo: 'acme/checkout', number: 41 }], { actorId: 'scout', source: 'mcp', at: 2 });
    recordGitHubActivity(sql, [{ action: 'touched', subject: 'issue', repo: 'acme/checkout', number: 41 }], { actorId: 'main', source: 'mcp', at: 3 });
    recordGitHubActivity(sql, [{ action: 'closed', subject: 'issue', repo: 'acme/checkout', number: 41, state: 'closed' }], { actorId: null, source: 'egress', at: 4 });

    expect(readGitHubActivity(sql, []).items).toEqual([{
      subject: 'issue', repo: 'acme/checkout', number: 41, title: 'SAVE20 500s', url: 'https://github.com/acme/checkout/issues/41',
      state: 'closed', actors: ['main', 'scout'], unattributed: true, lastAt: 4,
    }]);
  });

  test('what GitHub says on a refresh wins over what was recorded, without counting as an agent\'s act', () => {
    const { sql } = workspace();

    recordGitHubActivity(sql, [{ action: 'opened', subject: 'pr', repo: 'acme/checkout', number: 42, title: 'Guard archived coupons', ref: 'fix/guard' }],
      { actorId: 'main', source: 'egress', at: 10 });
    recordGitHubObservations(sql, [{ subject: 'pr', repo: 'acme/checkout', number: 42, state: 'merged', title: 'Guard archived coupons (#42)' }], 20);

    const [pr] = readGitHubActivity(sql, []).items;

    expect(pr).toMatchObject({ state: 'merged', title: 'Guard archived coupons (#42)', actors: ['main'], unattributed: false, lastAt: 10 });
    expect(readGitHubActivity(sql, []).observedAt).toBe(20);
  });

  test('a repository shows its last push, its CI and whether it is a remote; one only cloned or only a remote still shows', () => {
    const { sql } = workspace();

    recordGitHubActivity(sql, [{ action: 'fetched', subject: 'repo', repo: 'acme/checkout' }], { actorId: null, source: 'egress', at: 1 });
    recordGitHubActivity(sql, [{ action: 'pushed', subject: 'repo', repo: 'acme/checkout', ref: 'fix/guard' }], { actorId: null, source: 'egress', at: 5 });
    recordGitHubObservations(sql, [{ subject: 'repo', repo: 'acme/checkout', ref: 'fix/guard', ci: 'failure' }], 6);
    recordGitHubActivity(sql, [{ action: 'fetched', subject: 'repo', repo: 'acme/docs' }], { actorId: null, source: 'egress', at: 7 });
    recordGitHubObservations(sql, [{ subject: 'repo', repo: 'acme/docs', ref: 'main', ci: 'success' }], 8);

    expect(readGitHubActivity(sql, ['acme/checkout', 'acme/infra']).repos).toEqual([
      { repo: 'acme/checkout', remote: true, lastPush: { ref: 'fix/guard', at: 5 }, fetchedAt: 1, branch: 'fix/guard', ci: { state: 'failure', at: 6 } },
      { repo: 'acme/infra', remote: true, lastPush: null, fetchedAt: null, branch: null, ci: null },
      { repo: 'acme/docs', remote: false, lastPush: null, fetchedAt: 7, branch: 'main', ci: { state: 'success', at: 8 } },
    ]);
  });
});

describe('a refresh reads what GitHub says now, with the account\'s token', () => {
  const activity: WorkspaceGitHub = {
    items: [
      { subject: 'pr', repo: 'acme/checkout', number: 42, title: 'Guard', url: 'https://github.com/acme/checkout/pull/42', state: 'open', actors: ['main'], unattributed: false, lastAt: 2 },
      { subject: 'issue', repo: 'acme/checkout', number: 41, title: 'SAVE20', url: 'https://github.com/acme/checkout/issues/41', state: 'open', actors: [], unattributed: true, lastAt: 1 },
    ],
    repos: [
      { repo: 'acme/checkout', remote: true, lastPush: { ref: 'fix/guard', at: 3 }, fetchedAt: null, branch: 'fix/guard', ci: null },
      { repo: 'acme/infra', remote: true, lastPush: null, fetchedAt: null, branch: null, ci: null },
    ],
    observedAt: null,
  };

  /** GitHub's answers by path; anything else is a 404, as GitHub answers a path it does not know. */
  const github = (answers: Readonly<Record<string, JsonValue>>, status = 200) => {
    const asked: string[] = [];

    const fetch = async (url: string, init: RequestInit) => {
      asked.push(`${new URL(url).pathname}${new URL(url).search} ${new Headers(init.headers).get('authorization') ?? ''}`);
      const body = answers[new URL(url).pathname];

      return body === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(body), { status });
    };

    return { asked, fetch };
  };

  test('a merged pull request, a closed issue, a failing check and a default branch\'s green status come back as observations', async () => {
    const { asked, fetch } = github({
      '/repos/acme/checkout/issues/42': { title: 'Guard archived coupons', state: 'closed' },
      '/repos/acme/checkout/pulls/42': { merged_at: '2026-10-05T10:00:00Z' },
      '/repos/acme/checkout/issues/41': { title: 'SAVE20 500s', state: 'closed' },
      '/repos/acme/checkout/commits/fix%2Fguard/check-runs': { total_count: 2, check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] },
      '/repos/acme/checkout/commits/fix%2Fguard/status': { state: 'pending', total_count: 0 },
      '/repos/acme/infra': { default_branch: 'main' },
      '/repos/acme/infra/commits/main/check-runs': { total_count: 0, check_runs: [] },
      '/repos/acme/infra/commits/main/status': { state: 'success', total_count: 1 },
    });

    const refreshed = await Effect.runPromise(refreshGitHub({ authorization: 'Bearer gho_1', activity, fetch }));

    expect(refreshed.outcome).toBe('refreshed');
    expect(refreshed.observed).toEqual([
      { subject: 'pr', repo: 'acme/checkout', number: 42, title: 'Guard archived coupons', state: 'merged' },
      { subject: 'issue', repo: 'acme/checkout', number: 41, title: 'SAVE20 500s', state: 'closed' },
      { subject: 'repo', repo: 'acme/checkout', ref: 'fix/guard', ci: 'failure' },
      { subject: 'repo', repo: 'acme/infra', ref: 'main', ci: 'success' },
    ]);
    expect(asked.every((line) => line.endsWith(' Bearer gho_1'))).toBe(true);
  });

  test('a token GitHub refuses says so, and records nothing it did not read', async () => {
    const { fetch } = github({ '/repos/acme/checkout/issues/42': { message: 'Bad credentials' } }, 401);
    const refreshed = await Effect.runPromise(refreshGitHub({ authorization: 'Bearer expired', activity, fetch }));

    expect(refreshed).toEqual({ observed: [], outcome: 'denied' });
  });
});

describe('the workspace\'s git remotes', () => {
  test('each repository a config names on github.com, once', async () => {
    const config = [
      '[core]', '\trepositoryformatversion = 0',
      '[remote "origin"]', '\turl = https://github.com/acme/checkout.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "fork"]', '\turl = git@github.com:someone/checkout.git', '\tpushurl = git@github.com:acme/checkout.git',
      '[remote "mirror"]', '\turl = https://gitlab.com/acme/checkout.git',
    ].join('\n');

    const vfs = {
      readdir: async (path: string) => (path === '/w' ? [{ name: '.git', type: 'directory' as const }] : []),
      readFile: async () => new TextEncoder().encode(config),
    };

    expect(await readGitHubRemotes(vfs, '/w')).toEqual(['acme/checkout', 'someone/checkout']);
  });

  test('found in each repository up to four folders down, past hidden folders and node_modules, and past a folder that cannot be read', async () => {
    const dirs = new Map<string, { name: string; type: 'directory' | 'file' }[]>(Object.entries({
      '/home/main': [{ name: 'checkout', type: 'directory' }, { name: 'node_modules', type: 'directory' }, { name: '.cache', type: 'directory' }, { name: 'locked', type: 'directory' }],
      '/home/main/checkout': [{ name: '.git', type: 'directory' }, { name: 'packages', type: 'directory' }],
      '/home/main/checkout/packages': [{ name: 'infra', type: 'directory' }],
      '/home/main/checkout/packages/infra': [{ name: '.git', type: 'directory' }],
      '/home/main/node_modules': [{ name: '.git', type: 'directory' }],
      '/home/main/.cache': [{ name: '.git', type: 'directory' }],
    }));

    const configs = new Map(Object.entries({
      '/home/main/checkout/.git/config': '[remote "origin"]\n\turl = https://github.com/acme/checkout.git\n',
      '/home/main/checkout/packages/infra/.git/config': '[remote "origin"]\n\turl = git@github.com:acme/infra.git\n',
      '/home/main/node_modules/.git/config': '[remote "origin"]\n\turl = https://github.com/someone/dependency.git\n',
    }));

    const vfs = {
      readdir: async (path: string) => {
        const entries = dirs.get(path);

        if (entries === undefined) throw new Error(`EACCES: ${path}`);

        return entries;
      },
      readFile: async (path: string) => new TextEncoder().encode(configs.get(path) ?? ''),
    };

    expect(await readGitHubRemotes(vfs, '/home/main')).toEqual(['acme/checkout', 'acme/infra']);
  });
});
