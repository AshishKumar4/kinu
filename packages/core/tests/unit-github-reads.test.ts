// `github.read`: a GET of GitHub's REST API made by the account with its GitHub connection's token, never off
// api.github.com, conditional on `If-Modified-Since`; a 304 is an answer (nothing changed), any other refusal is said in
// GitHub's words. The assistant's GitHub check reads its notifications this way, at no model call.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { callOperation, createGitHubCodemodeProvider, GitHubReadSchema, readGitHub, type GitHubAnswer, type JsonValue } from '../src/index';

/** GitHub as `fetch` reaches it, recording each request and answering `answer`. */
function gitHub(answer: Response) {
  const asked: Request[] = [];

  const fetchFn: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(new Request(input, init));

    return answer.clone();
  }, { preconnect: fetch.preconnect });

  return { asked, fetchFn };
}

test('a read goes to api.github.com with its query and If-Modified-Since, and answers with what it is paced by', async () => {
  const { asked, fetchFn } = gitHub(new Response('[]', { status: 200, headers: { 'last-modified': 'Fri, 24 Oct 2026 10:40:00 GMT', 'x-poll-interval': '60' } }));

  const answer = await readGitHub(
    { path: '/notifications', query: { all: false, since: '2026-10-24T09:00:00Z' }, ifModifiedSince: 'Fri, 24 Oct 2026 09:00:00 GMT' }, async () => 'gho_token', fetchFn,
  );

  expect(answer).toEqual({ status: 200, body: [], headers: { lastModified: 'Fri, 24 Oct 2026 10:40:00 GMT', pollInterval: 60 } });
  expect(asked.map((request) => ({ method: request.method, url: request.url, authorization: request.headers.get('authorization'), since: request.headers.get('if-modified-since') }))).toEqual([{
    method: 'GET', url: 'https://api.github.com/notifications?all=false&since=2026-10-24T09%3A00%3A00Z', authorization: 'Bearer gho_token', since: 'Fri, 24 Oct 2026 09:00:00 GMT',
  }]);
});

test('a path off api.github.com, or one that climbs, is no read', () => {
  for (const path of ['//evil.example/x', 'https://evil.example/', 'notifications', '/repos/../user', '/notifications?all=true']) {
    expect({ path, read: v.safeParse(GitHubReadSchema, { path }).success }).toEqual({ path, read: false });
  }
});

test('with no GitHub connection a read is refused, and GitHub is never asked', async () => {
  const { asked, fetchFn } = gitHub(new Response('[]'));

  await expect(readGitHub({ path: '/notifications' }, async () => null, fetchFn)).rejects.toThrow('GitHub is not connected');
  expect(asked).toEqual([]);
});

test("a program's github.read answers a 304 as unchanged, and a refusal in GitHub's words", async () => {
  const answers: GitHubAnswer[] = [
    { status: 304, body: null, headers: { lastModified: 'L1' } },
    { status: 404, body: { message: 'Not Found' }, headers: {} },
  ];

  const provider = createGitHubCodemodeProvider({ read: async () => answers.shift() ?? { status: 500, body: null, headers: {} } });
  const read = async (input: Record<string, JsonValue>) => (await callOperation([provider], 'github.read', input, { callId: 'call-read' })).value;

  expect(await read({ path: '/notifications', ifModifiedSince: 'L1' })).toEqual({ status: 304, body: null, lastModified: 'L1' });
  await expect(read({ path: '/repos/kinu/gone' })).rejects.toThrow('GitHub refused it: Not Found');
});
