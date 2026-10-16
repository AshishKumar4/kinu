import './helpers/ui-module-globals';
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { canonicalRoot, EffectAskSchema, slateApprovalPath, slateConsentsPath, SlateConsentSchema, SlateConsentsAnswerSchema, type SlateConsent } from '@kinu.run/core/slates';
import { consentRoutes, type ConsentRoutesEnv } from '../src/slates/consent-routes';
import { serveFamily } from './helpers/api';
import { appProbe, PROBE_ORIGIN } from './helpers/app-probe';
import { createTestUserDO, testOwner, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO } from './helpers/user-do';
import { resetRecordedMcp, seedConfiguredMcpServer, seedMcpTools } from './helpers/agents-sdk';

const { api } = await import('../src/api/app');

const VIEWER = '0123456789abcdef0123456789abcdef';

const IDENTITY = { userId: VIEWER, email: 'viewer@example.test', sub: 'viewer-sub' };

const CONSENT: SlateConsent = {
  workspace: 'another-persons-workspace', slate: 'issues', server: 'mcp.github', root: { owner: 'viewer', repo: 'kinu' },
  tools: ['list_issues', 'create_issue'], effects: true, revision: 'source-a',
};

const PATH = slateConsentsPath(CONSENT.workspace, CONSENT.slate);

const users: TestUserDO[] = [];

afterEach(() => {
  for (const user of users) user.close();
  users.length = 0;
  resetRecordedMcp();
});

function fixture() {
  const viewer = createTestUserDO({ durableObjectId: VIEWER });
  users.push(viewer);
  const selected: string[] = [];

  const env: ConsentRoutesEnv<string> = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: {
      idFromName: (name) => name,
      get: (id) => {
        selected.push(id);

        return viewer.userDO;
      },
    },
  };

  return { viewer, selected, env, serve: serveFamily(consentRoutes, { identity: IDENTITY }) };
}

function request(path: string, method = 'GET', body?: JsonValue): Request {
  return new Request(`${PROBE_ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json', origin: PROBE_ORIGIN }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

describe('the viewer\'s slate consent routes', () => {
  test('every route is session-authenticated, including reads', async () => {
    const { env, ctx } = await appProbe();

    for (const [path, method] of [[PATH, 'GET'], [PATH, 'POST'], [PATH, 'DELETE'], [slateApprovalPath(CONSENT.workspace, CONSENT.slate, 'approval'), 'POST']]) {
      const response = await api.fetch(request(path, method), env, ctx);

      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
  });

  test('cross-site writes are refused before the signed-in account is called', async () => {
    const { env, ctx, cookie, accountCalls } = await appProbe();

    for (const [path, method] of [[PATH, 'POST'], [PATH, 'DELETE'], [slateApprovalPath(CONSENT.workspace, CONSENT.slate, 'approval'), 'POST']]) {
      const response = await api.fetch(new Request(`${PROBE_ORIGIN}${path}`, { method, headers: { cookie, origin: 'https://attacker.example' } }), env, ctx);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'CROSS_SITE' });
      expect(response.headers.get('cache-control')).toContain('no-store');
    }

    expect(accountCalls.every((method) => method === 'verifyBrowserSession')).toBe(true);
  });

  test('GET, POST, replacement and DELETE round-trip only through the viewer\'s own UserDO', async () => {
    const { serve, env, selected, viewer } = fixture();
    const empty = await serve(request(PATH), env);
    expect(v.parse(SlateConsentsAnswerSchema, await empty?.json())).toEqual({ consents: [] });
    const stored = await serve(request(PATH, 'POST', CONSENT), env);
    expect(stored?.status).toBe(200);
    expect(v.parse(SlateConsentSchema, await stored?.json())).toEqual(CONSENT);
    const replacement = { ...CONSENT, revision: 'source-b', tools: ['list_issues'], effects: false };
    const updated = await serve(request(PATH, 'POST', replacement), env);
    expect(v.parse(SlateConsentSchema, await updated?.json())).toEqual(replacement);
    const listed = await serve(request(PATH), env);
    expect(v.parse(SlateConsentsAnswerSchema, await listed?.json())).toEqual({ consents: [replacement] });
    expect(listed?.headers.get('cache-control')).toContain('no-store');
    const query = new URLSearchParams({ server: CONSENT.server, root: canonicalRoot(CONSENT.root) });
    const withdrawn = await serve(request(`${PATH}?${query}`, 'DELETE'), env);
    expect(v.parse(v.object({ withdrawn: v.boolean() }), await withdrawn?.json())).toEqual({ withdrawn: true });
    const again = await serve(request(`${PATH}?${query}`, 'DELETE'), env);
    expect(v.parse(v.object({ withdrawn: v.boolean() }), await again?.json())).toEqual({ withdrawn: false });
    const final = await serve(request(PATH), env);
    expect(v.parse(SlateConsentsAnswerSchema, await final?.json())).toEqual({ consents: [] });
    expect(await viewer.userDO.slateConsents(await testOwner(), CONSENT)).toEqual([]);
    expect(selected).toHaveLength(7);
    expect(new Set(selected)).toEqual(new Set([VIEWER]));
  });

  test('consent bodies must match the path and malformed bodies or withdrawal roots never reach the account', async () => {
    const { serve, env, selected } = fixture();

    for (const consent of [{ ...CONSENT, workspace: 'wrong' }, { ...CONSENT, slate: 'wrong' }, { ...CONSENT, revision: '' }, { ...CONSENT, tools: [7] }]) {
      expect((await serve(request(PATH, 'POST', consent), env))?.status).toBe(400);
    }

    for (const query of ['', '?server=mcp.github', '?server=mcp.github&root=not-json', '?server=mcp.github&root=null', '?server=mcp.github&root=[]', '?server=mcp.github&root={"repo":7}']) {
      expect((await serve(request(`${PATH}${query}`, 'DELETE'), env))?.status).toBe(400);
    }

    expect(selected).toEqual([]);
  });

  test('encoded workspace and slate names are decoded once and matched to the consent body', async () => {
    const { serve, env, selected } = fixture();
    const consent = { ...CONSENT, workspace: 'a workspace', slate: 'percent%name' };
    const path = slateConsentsPath(consent.workspace, consent.slate);
    expect((await serve(request(path, 'POST', consent), env))?.status).toBe(200);
    const response = await serve(request(path), env);

    expect(v.parse(SlateConsentsAnswerSchema, await response?.json())).toEqual({ consents: [consent] });
    expect(selected).toEqual([VIEWER, VIEWER]);
  });

  test('an approval decision reaches only this viewer\'s pending effect, and can approve or decline', async () => {
    resetRecordedMcp();
    const { serve, env, viewer, selected } = fixture();
    const caller = await testOwner();
    await viewer.userDO.userMcp_list(caller);
    seedConfiguredMcpServer(viewer.sql, 'viewer-connection', { name: 'github', url: 'https://viewer-github.example/sse', transport: 'auto' });
    await viewer.userDO.userMcp_list(caller);
    seedMcpTools('viewer-connection', [{ name: 'create_issue', inputSchema: { type: 'object' } }]);
    await viewer.userDO.consentSlate(caller, CONSENT);
    const effect = { ...CONSENT, tool: 'create_issue', args: [{ ...CONSENT.root, title: 'one effect' }] };
    const answer = await viewer.userDO.slatePartTool(caller, effect);
    expect(answer.kind).toBe('needs-approval');
    const ask = v.parse(EffectAskSchema, 'ask' in answer ? answer.ask : null);
    const path = slateApprovalPath(CONSENT.workspace, CONSENT.slate, ask.id);
    const approved = await serve(request(path, 'POST', { decision: 'approve' }), env);

    expect(v.parse(v.object({ decided: v.boolean() }), await approved?.json())).toEqual({ decided: true });
    const declined = await serve(request(path, 'POST', { decision: 'decline' }), env);
    expect(v.parse(v.object({ decided: v.boolean() }), await declined?.json())).toEqual({ decided: true });
    const forgotten = await serve(request(path, 'POST', { decision: 'approve' }), env);
    expect(v.parse(v.object({ decided: v.boolean() }), await forgotten?.json())).toEqual({ decided: false });
    expect((await serve(request(path, 'POST', { decision: 'always' }), env))?.status).toBe(400);
    expect((await serve(request(path, 'POST', {}), env))?.status).toBe(400);
    expect(selected).toEqual([VIEWER, VIEWER, VIEWER]);
  });
});
