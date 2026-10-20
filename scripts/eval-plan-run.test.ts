import { afterAll, expect, test } from 'bun:test';
import { CHATGPT_PASTE_REDIRECT, DEV_IDENTITY_ACCOUNT_HEADER } from '@kinu.run/core';
import { planLogins, planOf } from './eval-plan-run';

const held = new Map<string, string[]>([['eval-service', ['opencode-go.bearer']], ['trial-1', ['opencode-go.bearer', 'claude.oauth', 'chatgpt.oauth@compare']]]);

const deleted: string[] = [];

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

    held.set(account, keys.filter((each) => each !== key));
    deleted.push(`${account} ${key} revoke=${url.searchParams.get('revoke') ?? ''}`);

    return Response.json({ unrevoked: null });
  },
});

afterAll(async () => { await deployment.stop(true); });

test('a pasted address is ChatGPT\'s when it returns to its paste redirect, and Claude\'s otherwise', () => {
  expect(planOf(`${CHATGPT_PASTE_REDIRECT}?code=c&state=s`)).toBe('chatgpt');
  expect(planOf('http://localhost:54545/callback?code=c&state=s')).toBe('claude');
  expect(planOf('a-claude-code#its-state')).toBe('claude');
});

// The run's plan logins end with it: every eval account's copy found, deleted, and ChatGPT's revoked by its holder.
test('a read finds every copy of a plan login and leaves it; a clear deletes each, revoking ChatGPT\'s', async () => {
  const accounts = ['eval-service', 'trial-1', 'trial-2'];
  const origin = deployment.url.origin;

  expect(await planLogins(origin, 'secret', accounts, false)).toEqual(['trial-1 claude.oauth', 'trial-1 chatgpt.oauth@compare']);
  expect(deleted).toEqual([]);
  expect(await planLogins(origin, 'secret', accounts, true)).toEqual(['trial-1 claude.oauth', 'trial-1 chatgpt.oauth@compare']);
  expect(deleted).toEqual(['trial-1 claude.oauth revoke=0', 'trial-1 chatgpt.oauth@compare revoke=1']);
  expect(held.get('trial-1')).toEqual(['opencode-go.bearer']);
});
