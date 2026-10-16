import { describe, expect, test } from 'bun:test';
import { EffectApprovals, partCallVerdict, serverAuthority, type EffectCall, type LiveShareAuthority } from '../src/slates/share-policy';
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

  const read = { server: 'mcp.GitHub', root: { repo: 'board', owner: 'acme' }, tool: 'list_issues', effect: false };

  test('runs under a consent for its tool, root and revision, whatever order the root was written in', () => {
    expect(partCallVerdict(consent, read, 'r1', false)).toEqual({ kind: 'run' });
  });

  test('asks again after an edit, for another root, or for another tool', () => {
    expect(partCallVerdict(consent, read, 'r2', false)).toMatchObject({ kind: 'needs-consent', ask: { revision: 'r2', tools: ['list_issues'] } });
    expect(partCallVerdict(consent, { ...read, root: { owner: 'acme', repo: 'secrets' } }, 'r1', false)).toMatchObject({ kind: 'needs-consent' });
    expect(partCallVerdict(consent, { ...read, tool: 'get_file' }, 'r1', false)).toMatchObject({ kind: 'needs-consent', ask: { tools: ['list_issues', 'get_file'] } });
    expect(partCallVerdict(null, read, 'r1', false)).toMatchObject({ kind: 'needs-consent', ask: { tools: ['list_issues'], effects: false } });
  });

  test('acts only where effects were allowed, and then only once approved', () => {
    const merge = { ...read, tool: 'merge', effect: true };

    expect(partCallVerdict({ ...consent, tools: ['merge'] }, merge, 'r1', true)).toMatchObject({ kind: 'needs-consent', ask: { effects: true } });
    expect(partCallVerdict({ ...consent, tools: ['merge'], effects: true }, merge, 'r1', false)).toEqual({ kind: 'needs-approval' });
    expect(partCallVerdict({ ...consent, tools: ['merge'], effects: true }, merge, 'r1', true)).toEqual({ kind: 'run' });
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
