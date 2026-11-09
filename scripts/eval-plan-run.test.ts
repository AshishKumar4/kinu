import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { DEV_IDENTITY_ACCOUNT_HEADER } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { claimedAccounts, giveAgain, modelsNamed, ompGrant, planLogins, trialSelection, whileRenewing } from './eval-plan-run';
import { RENEWING_MARK, TEARDOWN_MARK } from '../evals/src/slot';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const held = new Map<string, string[]>([
  ['eval-service', ['opencode-go.bearer']], ['trial-1', ['opencode-go.bearer', 'claude.oauth', 'chatgpt.oauth@compare']], ['trial-2', ['codex.oauth']],
]);

const deleted: string[] = [];

const posted: string[] = [];

// A deployment's credential routes as the product answers them: the keys an account holds, and a delete by key.
const deployment = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER) ?? 'eval-service';
    const keys = held.get(account) ?? [];

    if (request.method === 'GET') return Response.json(keys.map((key) => ({ key })));
    const key = decodeURIComponent(url.pathname.slice('/api/user/credentials/'.length));

    if (request.method === 'POST') {
      posted.push(`${account} ${key}`);

      return Response.json({ ok: true });
    }

    held.set(account, keys.filter((each) => each !== key));
    deleted.push(`${account} ${key} revoke=${url.searchParams.get('revoke') ?? ''}`);

    return Response.json({ unrevoked: null });
  },
});

afterAll(async () => { await deployment.stop(true); });

// A store laid out as OMP's: a login row whose data holds its tokens.
function ompStore(rows: readonly { readonly id: number; readonly provider: string; readonly disabled: string | null; readonly data: object }[]): string {
  const path = join(scratchDir('omp-store'), 'agent.db');
  const db = new Database(path);

  db.run('CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, disabled_cause TEXT, data TEXT)');

  for (const row of rows) db.run('INSERT INTO auth_credentials VALUES (?, ?, ?, ?)', [row.id, row.provider, row.disabled, JSON.stringify(row.data)]);
  db.close();

  return path;
}

// The run uses OMP's logins as they are: the access token and its end, never the refresh token, and only the row named.
test('a plan grant from OMP carries its access token and its end, and nothing else of the row', () => {
  const store = ompStore([
    { id: 55, provider: 'anthropic', disabled: null, data: { access: 'at-55', refresh: 'rt-55', expires: 1_800_000_000_000 } },
    { id: 7, provider: 'anthropic', disabled: 'revoked', data: { access: 'at-7', refresh: 'rt-7', expires: 1 } },
  ]);

  expect(ompGrant(store, { id: 55, provider: 'anthropic' })).toEqual({ kind: 'oauth', accessToken: 'at-55', expiresAt: 1_800_000_000_000 });
  expect(() => ompGrant(store, { id: 55, provider: 'openai-codex' })).toThrow();
  expect(() => ompGrant(store, { id: 7, provider: 'anthropic' })).toThrow();
});

test('a run measures Muse and each model named, and refuses a name it does not have', () => {
  expect(modelsNamed(['--models=haiku']).map((each) => each.slug)).toEqual(['muse', 'haiku']);
  expect(modelsNamed(['--models=haiku,luna']).map((each) => each.model)).toEqual([expect.any(String), 'claude/claude-haiku-5-5', 'codex/gpt-6-luna']);
  expect(() => modelsNamed(['--models=opus'])).toThrow('no model is named opus');
  // The owner, 2026-10-23: trajectory reviews on Haiku alone.
  expect(modelsNamed(['--models=haiku', '--without-muse']).map((each) => each.slug)).toEqual(['haiku']);
});

test('a run passes its tasks and trials to each sequence, and its effort to the trial accounts', () => {
  expect(trialSelection(['--models=haiku'])).toEqual({ on: 'staging', map: ['--staging-only', '--trials=1'], effort: null });
  expect(trialSelection(['--models=haiku', '--tasks=chat-app,office', '--trials=2', '--effort=low', '--on=production']))
    .toEqual({ on: 'production', map: ['--daily', '--suite=fast', '--on=production', '--trials=2', '--tasks=chat-app,office'], effort: 'low' });
  expect(() => trialSelection(['--on=prod'])).toThrow('--on is staging or production');
});

// A token OMP renewed reaches the account using the old one, and no other.
test('a renewed token is given again to the account holding its key alone', async () => {
  const origin = deployment.url.origin;
  const holders = await planLogins(origin, 'secret', ['eval-service', 'trial-1', 'trial-2']);

  expect(await giveAgain({ origin, secret: 'secret', holders, key: 'codex.oauth', grant: { kind: 'oauth', accessToken: 'renewed', expiresAt: 2 } })).toEqual(['trial-2']);
  expect(posted).toEqual(['trial-2 codex.oauth']);
});

// A read finds each copy of a plan login among the accounts named, and leaves every one as it was.
test('a read finds every copy of a plan login among the accounts it names, and deletes none', async () => {
  const origin = deployment.url.origin;

  expect(await planLogins(origin, 'secret', ['eval-service', 'trial-1', 'trial-2'])).toEqual(['trial-1 claude.oauth', 'trial-1 chatgpt.oauth@compare', 'trial-2 codex.oauth']);
  expect(deleted).toEqual([]);
});

// The owner, 2026-11-09: staging held 256 trial accounts no run used. Every read of an account records it as one of the
// deployment's, and the run read trial-1 to trial-256 for plan logins; it reads only the blocks its sequences' jobs claim.
test("the accounts a run reads are its sequences' claimed blocks on its deployment, and no other", () => {
  const claims = [
    { job: 'mine', first: 3, last: 4, hosts: ['staging.kinu.run'], createdAt: 1 },
    { job: 'mine', first: 9, last: 9, hosts: ['kinu.run'], createdAt: 1 },
    { job: 'theirs', first: 5, last: 6, hosts: ['staging.kinu.run'], createdAt: 2 },
  ];

  expect(claimedAccounts(claims, new Set(['mine']), 'staging.kinu.run')).toEqual(['trial-3', 'trial-4']);
});

// A renewal landing after a sequence disconnected its accounts' logins would be revoked by the accounts' delete. Each side
// marks itself before reading the other's: a sequence tearing down gets no renewal, and one under way is marked until done.
test('a renewal reaches no sequence tearing down, and marks itself while it runs into one that is not', async () => {
  const sequence = join(scratchDir('plan-run-renewal'), 'haiku');
  let marked = false;

  mkdirSync(sequence, { recursive: true });
  expect(await whileRenewing(sequence, async () => {
    marked = existsSync(join(sequence, RENEWING_MARK));

    return ['trial-3'];
  })).toEqual(['trial-3']);
  expect({ marked, after: existsSync(join(sequence, RENEWING_MARK)) }).toEqual({ marked: true, after: false });

  writeFileSync(join(sequence, TEARDOWN_MARK), '1\n');
  expect(await whileRenewing(sequence, async () => ['trial-3'])).toBeNull();
  expect(existsSync(join(sequence, RENEWING_MARK))).toBe(false);
});
