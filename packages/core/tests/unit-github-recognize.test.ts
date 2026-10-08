// Defends: an issue, a pull request or a push an agent made never reaching the workspace overview, and a read, a
// failed write or another host's traffic recorded as something an agent did on GitHub.
import { describe, expect, test } from 'bun:test';
import { githubRepoOfRemote, recognizeGitHubHttp, recognizeGitHubMcp } from '../src/github/recognize';
import type { JsonValue } from '../src/utils/json';

const ok = (body: JsonValue, status = 201) => ({ status, body: JSON.stringify(body) });

/** A pkt-line: four hex digits of length, counting themselves, then the payload. */
const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

const NEW = 'b'.repeat(40);

describe('GitHub REST, as the devbox egress sees it', () => {

  test('a pull request created names its branch; a merge and a comment are recorded against it', () => {
    const created = recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/repos/acme/checkout/pulls' },
      ok({ number: 42, title: 'Guard archived coupons', state: 'open', html_url: 'https://github.com/acme/checkout/pull/42', head: { ref: 'fix/coupon-guard' } }),
    );

    expect(created).toEqual([{
      action: 'opened', subject: 'pr', repo: 'acme/checkout', number: 42, url: 'https://github.com/acme/checkout/pull/42',
      title: 'Guard archived coupons', state: 'open', ref: 'fix/coupon-guard',
    }]);

    expect(recognizeGitHubHttp(
      { method: 'PUT', url: 'https://api.github.com/repos/acme/checkout/pulls/42/merge' },
      ok({ sha: NEW, merged: true, message: 'Pull Request successfully merged' }, 200),
    )).toEqual([{ action: 'merged', subject: 'pr', repo: 'acme/checkout', number: 42, state: 'merged' }]);

    // Issue comments serve pull requests too; the comment's own page says which it was.
    expect(recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/repos/acme/checkout/issues/42/comments' },
      ok({ id: 9, html_url: 'https://github.com/acme/checkout/pull/42#issuecomment-9' }),
    )).toEqual([{ action: 'touched', subject: 'pr', repo: 'acme/checkout', number: 42 }]);

    expect(recognizeGitHubHttp(
      { method: 'PATCH', url: 'https://api.github.com/repos/acme/checkout/issues/41' },
      ok({ number: 41, title: 'SAVE20 500s at checkout', state: 'closed', html_url: 'https://github.com/acme/checkout/issues/41' }, 200),
    )).toEqual([{
      action: 'closed', subject: 'issue', repo: 'acme/checkout', number: 41,
      url: 'https://github.com/acme/checkout/issues/41', title: 'SAVE20 500s at checkout', state: 'closed',
    }]);
  });

  test('gh\'s GraphQL mutations are read from what GitHub answered', () => {
    // Captured from `gh pr create`: mutation PullRequestCreate, answered with the new pull request's id and url.
    const query = 'mutation PullRequestCreate($input:CreatePullRequestInput!){createPullRequest(input: $input){pullRequest{id,url}}}';

    const facts = recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/graphql', body: JSON.stringify({ query, variables: { input: { repositoryId: 'R_1', baseRefName: 'main', headRefName: 'fix/coupon-guard', title: 'Guard archived coupons' } } }) },
      ok({ data: { createPullRequest: { pullRequest: { id: 'PR_1', url: 'https://github.com/acme/checkout/pull/42' } } } }, 200),
    );

    expect(facts).toEqual([{
      action: 'opened', subject: 'pr', repo: 'acme/checkout', number: 42, url: 'https://github.com/acme/checkout/pull/42',
      title: 'Guard archived coupons', ref: 'fix/coupon-guard',
    }]);

    // A query, not a mutation, changes nothing.
    expect(recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/graphql', body: JSON.stringify({ query: 'query { repository(owner:"acme",name:"checkout"){ pullRequest(number:42){ url } } }' }) },
      ok({ data: { repository: { pullRequest: { url: 'https://github.com/acme/checkout/pull/42' } } } }, 200),
    )).toEqual([]);
  });

  test('a mutation\'s subject is its structured url, never a link written in a title', () => {
    const query = 'mutation IssueCreate($input:CreateIssueInput!){createIssue(input: $input){issue{title,url}}}';
    const hostile = 'https://github.com/evil/elsewhere/issues/9';

    expect(recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/graphql', body: JSON.stringify({ query, variables: { input: { repositoryId: 'R_1', title: hostile } } }) },
      ok({ data: { createIssue: { issue: { title: hostile, url: 'https://github.com/acme/checkout/issues/41' } } } }, 200),
    )).toEqual([{ action: 'opened', subject: 'issue', repo: 'acme/checkout', number: 41, url: 'https://github.com/acme/checkout/issues/41', title: hostile }]);

    // An answer whose only link is in a title records nothing.
    expect(recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/graphql', body: JSON.stringify({ query: 'mutation { updateIssue(input: $input){ issue { title } } }' }) },
      ok({ data: { updateIssue: { issue: { title: hostile } } } }, 200),
    )).toEqual([]);
  });

  test('`gh issue close` answers with a node id only, which the lookup before it names', () => {
    // Captured from `gh issue close 41`: a lookup by number, then closeIssue answered with the issue's id.
    const lookup = recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/graphql', body: JSON.stringify({ query: 'query IssueByNumber($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id,title,url}}}' }) },
      ok({ data: { repository: { issue: { id: 'I_kw41', title: 'https://github.com/evil/elsewhere/issues/9', url: 'https://github.com/acme/checkout/issues/41' } } } }, 200),
    );

    const closed = recognizeGitHubHttp(
      { method: 'POST', url: 'https://api.github.com/graphql', body: JSON.stringify({ query: 'mutation IssueClose($input:CloseIssueInput!){closeIssue(input: $input){issue{id}}}', variables: { input: { issueId: 'I_kw41' } } }) },
      ok({ data: { closeIssue: { issue: { id: 'I_kw41' } } } }, 200),
    );

    expect(lookup).toEqual([{ action: 'identified', subject: 'issue', repo: 'acme/checkout', number: 41, node: 'I_kw41' }]);
    expect(closed).toEqual([{ action: 'closed', subject: 'issue', node: 'I_kw41', state: 'closed' }]);
  });

  test('reads, refusals and other hosts record nothing', () => {
    expect(recognizeGitHubHttp({ method: 'GET', url: 'https://api.github.com/repos/acme/checkout/issues/41' }, ok({ number: 41 }, 200))).toEqual([]);
    expect(recognizeGitHubHttp({ method: 'POST', url: 'https://api.github.com/repos/acme/checkout/issues' }, ok({ message: 'Validation Failed' }, 422))).toEqual([]);
    expect(recognizeGitHubHttp({ method: 'POST', url: 'https://gitlab.com/api/v4/projects/1/issues' }, ok({ iid: 1 }))).toEqual([]);
    expect(recognizeGitHubHttp({ method: 'POST', url: 'https://api.github.com/repos/acme/checkout/issues' }, { status: 201, body: '<html>' })).toEqual([]);
  });
});

describe('git over smart HTTP', () => {
  test('a push records each branch GitHub accepted, read from its report; a refused branch is no push', () => {
    // report-status inside side-band-64k, as GitHub answers `git push` (band 1 carries the report's own pkt-lines).
    // The second line's length is 002a: a pkt length can end in a letter.
    const report = `${pkt('unpack ok\n')}${pkt('ok refs/heads/fix/coupon-guard\n')}${pkt('ok refs/heads/feature/checkout-coupon\n')}${pkt('ng refs/heads/main protected branch hook declined\n')}0000`;
    const answer = `${pkt(`\u0001${report}`)}0000`;

    expect(recognizeGitHubHttp(
      { method: 'POST', url: 'https://github.com/acme/checkout.git/git-receive-pack' },
      { status: 200, body: answer },
    )).toEqual([
      { action: 'pushed', subject: 'repo', repo: 'acme/checkout', ref: 'fix/coupon-guard' },
      { action: 'pushed', subject: 'repo', repo: 'acme/checkout', ref: 'feature/checkout-coupon' },
    ]);

    expect(recognizeGitHubHttp({ method: 'POST', url: 'https://github.com/acme/checkout.git/git-receive-pack' }, { status: 403, body: answer })).toEqual([]);
  });

  test('a clone or fetch links the repository; the ref advertisement before it does not', () => {
    expect(recognizeGitHubHttp({ method: 'POST', url: 'https://github.com/acme/checkout/git-upload-pack' }, { status: 200 }))
      .toEqual([{ action: 'fetched', subject: 'repo', repo: 'acme/checkout' }]);
    expect(recognizeGitHubHttp({ method: 'GET', url: 'https://github.com/acme/checkout.git/info/refs?service=git-upload-pack' }, { status: 200 })).toEqual([]);
  });
});

describe('the GitHub MCP server', () => {
  /** An MCP tool result as `userMcp_callTool` returns it: the content array, its text the server's JSON. */
  const result = (payload: JsonValue) => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

  test('create_issue and create_pull_request map to the same facts as the HTTP seam', () => {
    expect(recognizeGitHubMcp('create_issue', { owner: 'acme', repo: 'checkout', title: 'SAVE20 500s at checkout' },
      result({ id: '1', url: 'https://github.com/acme/checkout/issues/41' }))).toEqual([{
      action: 'opened', subject: 'issue', repo: 'acme/checkout', number: 41, url: 'https://github.com/acme/checkout/issues/41', title: 'SAVE20 500s at checkout',
    }]);

    expect(recognizeGitHubMcp('create_pull_request', { owner: 'acme', repo: 'checkout', title: 'Guard archived coupons', head: 'fix/coupon-guard', base: 'main' },
      result({ number: 42, html_url: 'https://github.com/acme/checkout/pull/42', state: 'open' }))).toEqual([{
      action: 'opened', subject: 'pr', repo: 'acme/checkout', number: 42, url: 'https://github.com/acme/checkout/pull/42',
      title: 'Guard archived coupons', state: 'open', ref: 'fix/coupon-guard',
    }]);
  });

  test('a merge, a pushed file and a comment are recorded; a read or a failed call is not', () => {
    expect(recognizeGitHubMcp('merge_pull_request', { owner: 'acme', repo: 'checkout', pullNumber: 42 }, result({ merged: true })))
      .toEqual([{ action: 'merged', subject: 'pr', repo: 'acme/checkout', number: 42, state: 'merged' }]);
    expect(recognizeGitHubMcp('push_files', { owner: 'acme', repo: 'checkout', branch: 'fix/coupon-guard', files: [] }, result({ ref: 'refs/heads/fix/coupon-guard' })))
      .toEqual([{ action: 'pushed', subject: 'repo', repo: 'acme/checkout', ref: 'fix/coupon-guard' }]);
    expect(recognizeGitHubMcp('add_issue_comment', { owner: 'acme', repo: 'checkout', issue_number: 41, body: 'Fixed in #42' }, result({ html_url: 'https://github.com/acme/checkout/issues/41#issuecomment-3' })))
      .toEqual([{ action: 'touched', subject: 'issue', repo: 'acme/checkout', number: 41 }]);

    expect(recognizeGitHubMcp('get_issue', { owner: 'acme', repo: 'checkout', issue_number: 41 }, result({ number: 41 }))).toEqual([]);
    expect(recognizeGitHubMcp('create_issue', { owner: 'acme', repo: 'checkout', title: 'x' },
      JSON.stringify({ isError: true, content: [{ type: 'text', text: 'failed to create issue: 403' }] }))).toEqual([]);
  });
});

describe('a git remote names its repository', () => {
  test('https, ssh and scp forms of github.com, and nothing else', () => {
    expect(githubRepoOfRemote('https://github.com/acme/checkout.git')).toBe('acme/checkout');
    expect(githubRepoOfRemote('https://x-access-token:ghs_1@github.com/acme/checkout')).toBe('acme/checkout');
    expect(githubRepoOfRemote('git@github.com:acme/checkout.git')).toBe('acme/checkout');
    expect(githubRepoOfRemote('ssh://git@github.com/acme/checkout.git')).toBe('acme/checkout');
    expect(githubRepoOfRemote('https://gitlab.com/acme/checkout.git')).toBeNull();
    expect(githubRepoOfRemote('/srv/git/checkout.git')).toBeNull();
  });
});
