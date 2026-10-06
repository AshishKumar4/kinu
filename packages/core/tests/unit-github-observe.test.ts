// Defends: the devbox's GitHub traffic changed or held up by the recording of it, a read recorded as work, and a
// write GitHub answered never reaching the workspace's record.
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { observeGitHub, type GitHubRecorder } from '../src/github/observe';
import type { GitHubFact } from '../src/github/recognize';

function recorder() {
  const kept: Promise<unknown>[] = [];
  const recorded: GitHubFact[] = [];

  const held: GitHubRecorder = {
    waitUntil: (work) => { kept.push(work); },
    record: async (facts) => { recorded.push(...facts); },
  };

  return { held, recorded, settled: async () => { await Promise.all(kept); } };
}

const ISSUE = JSON.stringify({ number: 41, html_url: 'https://github.com/acme/checkout/issues/41', title: 'SAVE20 500s', state: 'open' });

describe('the devbox egress, watching GitHub', () => {
  test('a write goes out as sent and comes back as answered; its fact is recorded after', async () => {
    const watch = recorder();
    const request = new Request('https://api.github.com/repos/acme/checkout/issues', { method: 'POST', body: '{"title":"SAVE20 500s"}' });
    const observed = await Effect.runPromise(observeGitHub(request, new URL(request.url), watch.held));

    if (observed === null) throw new Error('a write to api.github.com was not watched');
    const answer = observed.answered(new Response(ISSUE, { status: 201, headers: { 'content-type': 'application/json' } }));

    expect(answer.status).toBe(201);
    expect(await answer.text()).toBe(ISSUE);
    await watch.settled();
    expect(watch.recorded).toEqual([{
      action: 'opened', subject: 'issue', repo: 'acme/checkout', number: 41, url: 'https://github.com/acme/checkout/issues/41', title: 'SAVE20 500s', state: 'open',
    }]);
  });

  test('a read, another host, or a refused write records nothing', async () => {
    const watch = recorder();
    const read = new Request('https://api.github.com/repos/acme/checkout/issues/41');
    const elsewhere = new Request('https://gitlab.com/api/v4/projects', { method: 'POST', body: '{}' });

    expect(await Effect.runPromise(observeGitHub(read, new URL(read.url), watch.held))).toBeNull();
    expect(await Effect.runPromise(observeGitHub(elsewhere, new URL(elsewhere.url), watch.held))).toBeNull();

    const refused = new Request('https://api.github.com/repos/acme/checkout/issues', { method: 'POST', body: '{}' });
    const observed = await Effect.runPromise(observeGitHub(refused, new URL(refused.url), watch.held));
    const answer = observed?.answered(new Response('{"message":"Bad credentials"}', { status: 401 }));

    expect(answer?.status).toBe(401);
    await watch.settled();
    expect(watch.recorded).toEqual([]);
  });
});
