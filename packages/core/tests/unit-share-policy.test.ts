import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '../src/utils/json';
import { containedTool, EffectApprovals, partCallRoot, partCallVerdict, plainData, serverAuthority, type EffectCall, type LiveShareAuthority } from '../src/slates/share-policy';
import type { ShareGrant } from '../src/slates/sharing';
import type { SlateConsent } from '../src/slates/share-modes';

const grant = (...members: string[]): ShareGrant => ({
  slates: ['board'], members: members.map((member) => ({ slate: 'board', namespace: 'mcp.GitHub', member, impact: 'observe' as const })),
});

const own: LiveShareAuthority = { mode: 'own', grant: grant('list_issues'), grantRevision: null };

const owner = (revision: string, ...members: string[]): LiveShareAuthority => ({ mode: 'owner', grant: grant(...members), grantRevision: revision });

describe('the shared server acts with', () => {
  test("the owner's own authority only while the slate is shared with no one", () => {
    expect(serverAuthority([], 'r1')).toEqual({ kind: 'owner' });
  });

  test('nothing while any share is their own access, an owner share beside it included', () => {
    expect(serverAuthority([own], 'r1')).toEqual({ kind: 'none' });
    expect(serverAuthority([owner('r1', 'list_issues'), own], 'r1')).toEqual({ kind: 'none' });
  });

  test("an owner share's members at the revision the owner approved, and nothing once the code changed", () => {
    expect(serverAuthority([owner('r1', 'list_issues')], 'r1')).toMatchObject({ kind: 'grant', grant: { members: [{ member: 'list_issues' }] } });
    expect(serverAuthority([owner('r1', 'list_issues')], 'r2')).toEqual({ kind: 'none' });
  });

  test('only what every owner share grants', () => {
    const both = serverAuthority([owner('r1', 'list_issues', 'merge'), owner('r1', 'list_issues')], 'r1');

    expect(both).toMatchObject({ kind: 'grant', grant: { members: [{ member: 'list_issues' }] } });
  });
});

describe("a personal part's call with its viewer's connection", () => {
  const consent: SlateConsent = {
    workspace: 'w', slate: 'board', server: 'mcp.GitHub', root: { owner: 'acme', repo: 'board' }, tools: ['list_issues'], effects: false, revision: 'r1',
  };

  const read = { server: 'mcp.GitHub', root: { repo: 'board', owner: 'acme' }, tool: 'list_issues', contained: true };

  test('runs under a consent for its tool, root and revision, whatever order the root was written in', () => {
    expect(partCallVerdict(consent, read, 'r1', false)).toEqual({ kind: 'run' });
  });

  test('asks again after an edit, for another root, or for another tool', () => {
    expect(partCallVerdict(consent, read, 'r2', false)).toMatchObject({ kind: 'needs-consent', ask: { revision: 'r2', tools: ['list_issues'] } });
    expect(partCallVerdict(consent, { ...read, root: { owner: 'acme', repo: 'secrets' } }, 'r1', false)).toMatchObject({ kind: 'needs-consent' });
    expect(partCallVerdict(consent, { ...read, tool: 'get_file' }, 'r1', false)).toMatchObject({ kind: 'needs-consent', ask: { tools: ['list_issues', 'get_file'] } });
    expect(partCallVerdict(null, read, 'r1', false)).toMatchObject({ kind: 'needs-consent', ask: { tools: ['list_issues'], effects: false } });
  });

  test('a call that is not contained asks only where they allowed it, and dispatches only once approved: a read as much as a send', () => {
    const fetchUrl = { server: 'mcp.Fetch', root: {}, tool: 'get', contained: false };

    expect(partCallVerdict({ ...consent, server: 'mcp.Fetch', root: {}, tools: ['get'] }, fetchUrl, 'r1', true)).toMatchObject({ kind: 'needs-consent', ask: { effects: true } });
    expect(partCallVerdict({ ...consent, server: 'mcp.Fetch', root: {}, tools: ['get'], effects: true }, fetchUrl, 'r1', false)).toEqual({ kind: 'needs-approval' });

    const merge = { ...read, tool: 'merge', contained: false };

    expect(partCallVerdict({ ...consent, tools: ['merge'] }, merge, 'r1', true)).toMatchObject({ kind: 'needs-consent', ask: { effects: true } });
    expect(partCallVerdict({ ...consent, tools: ['merge'], effects: true }, merge, 'r1', false)).toEqual({ kind: 'needs-approval' });
    expect(partCallVerdict({ ...consent, tools: ['merge'], effects: true }, merge, 'r1', true)).toEqual({ kind: 'run' });
  });
});

describe('a contained tool', () => {
  test('is read-only and closed-world by its own marks; either missing discloses', () => {
    expect(containedTool({ readOnly: true, closedWorld: true })).toBe(true);
    expect(containedTool({ readOnly: true })).toBe(false);
    expect(containedTool({ closedWorld: true })).toBe(false);
  });
});

describe('an approval', () => {
  const call: EffectCall = { workspace: 'w', slate: 'board', revision: 'r1', server: 'mcp.Mail', tool: 'send', root: {}, payload: { to: 'pat', body: 'hi' } };

  test('admits that one call once, and nothing before it is approved', () => {
    const approvals = new EffectApprovals();
    const ask = approvals.ask(call);

    expect(approvals.take(call)).toBe(false);
    expect(approvals.decide(ask.id, true)).toBe(true);
    expect(approvals.take(call)).toBe(true);
    expect(approvals.take(call)).toBe(false);
  });

  test('admits no other payload, and a declined one is gone', () => {
    const approvals = new EffectApprovals();
    const ask = approvals.ask(call);

    approvals.decide(ask.id, true);
    expect(approvals.take({ ...call, payload: { to: 'everyone', body: 'hi' } })).toBe(false);
    expect(approvals.decide(approvals.ask({ ...call, tool: 'other' }).id, false)).toBe(true);
    expect(approvals.take({ ...call, tool: 'other' })).toBe(false);
  });
});

describe('plain data', () => {
  test('is the one form an approval is keyed by: two different timestamps never share an approval, and neither is data', () => {
    // What the wire may hand over typed as data: an object holding something that is not (set past the type, as RPC does).
    const holding = (value: Date | Map<string, string>): JsonValue => {
      const payload: JsonValue = {};

      Reflect.set(payload, 'at', value);

      return payload;
    };

    const call = (when: Date): EffectCall => ({ workspace: 'w', slate: 's', revision: 'r1', server: 'mcp.Cal', tool: 'book', root: {}, payload: holding(when) });

    // A Date (or a Map, or any class instance) the wire handed in is refused, never hashed as an empty object.
    expect(() => EffectApprovals.idOf(call(new Date(0)))).toThrow('is not plain data');
    expect(() => plainData(holding(new Map()))).toThrow('is not plain data');
    expect(() => plainData([Number.NaN])).toThrow('not a finite number');
    // Plain data is copied as it is.
    expect(plainData({ at: '1970-01-01T00:00:00.000Z', n: [1, { b: null }] })).toEqual({ at: '1970-01-01T00:00:00.000Z', n: [1, { b: null }] });
  });
});

describe('a call\'s root', () => {
  test('R3-P1 roots. is a repository only where its tool\'s own contract chooses by owner and repo; else its whole connection', () => {
    const named = { owner: 'acme', repo: 'notes', query: 'anything at all' };

    expect(partCallRoot({ preset: 'github', tool: 'issue_read' }, named)).toEqual({ owner: 'acme', repo: 'notes' });
    // A search chooses by its query: the owner and repo it is handed are decoration.
    expect(partCallRoot({ preset: 'github', tool: 'search_issues' }, named)).toEqual({});
    // Another connection, or one no preset made, with the same fields: the whole connection.
    expect(partCallRoot({ preset: null, tool: 'issue_read' }, named)).toEqual({});
    expect(partCallRoot({ preset: 'cloudflare', tool: 'issue_read' }, named)).toEqual({});
    expect(partCallRoot(null, named)).toEqual({});
    expect(partCallRoot({ preset: 'github', tool: 'issue_read' }, { owner: 'acme' })).toEqual({});
  });

  test('R5-P1 roots by operation. an operation whose handler takes its target by a global ID has no repository root', () => {
    const at = { owner: 'acme', repo: 'notes' };
    const discussion = { preset: 'github', tool: 'discussion_comment_write' };
    const review = { preset: 'github', tool: 'pull_request_review_write' };

    // A comment or a review thread named by its node ID alone: the owner and repo it is handed are decoration.
    for (const method of ['update', 'delete', 'mark_answer', 'unmark_answer']) expect(partCallRoot(discussion, { ...at, method, commentNodeID: 'DC_x' })).toEqual({});

    for (const method of ['resolve_thread', 'unresolve_thread']) expect(partCallRoot(review, { ...at, method, threadId: 'PRRT_x' })).toEqual({});

    // Chosen inside the repository: rooted there.
    expect(partCallRoot(discussion, { ...at, method: 'add', discussionNumber: 1 })).toEqual(at);
    expect(partCallRoot(discussion, { ...at, method: 'reply', discussionNumber: 1, commentNodeID: 'DC_x' })).toEqual(at);
    expect(partCallRoot(review, { ...at, method: 'create', pullNumber: 1 })).toEqual(at);
    // No operation named, or an empty repository (its owner's organization's), roots nothing.
    expect(partCallRoot(discussion, at)).toEqual({});
    expect(partCallRoot({ preset: 'github', tool: 'list_discussions' }, { owner: 'acme', repo: '' })).toEqual({});
  });
});
