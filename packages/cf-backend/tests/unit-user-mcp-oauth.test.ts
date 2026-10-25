/**
 * An account's OAuth MCP server in a real UserDO, signed in through the product's callback as a person signs in,
 * against the tiers' own OAuth-protected server (scripts/scripted-mcp-oauth.ts), whose access tokens expire, whose
 * refresh tokens rotate, and which revokes a grant whose refresh token is presented twice, as many providers do.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { McpToolSurfaceSchema, type JsonObject, type UserCaller } from '@kinu.run/core';
import { renderThrownChain, setDiagnosticsSink, type LogFields } from '@kinu.run/core/obs';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';
import { kvOf } from './helpers/platform-context';
import { consented, scriptedOAuthNetwork, scriptedOAuthServer } from './helpers/mcp-server';
import { SCRIPTED_MCP_TOOL } from '../../../scripts/scripted-mcp';

let restore = (): void => undefined;

afterEach(() => {
  restore();
  setSystemTime();
});

/** The tiers' OAuth server reached in this process, until the test ends. */
function network(options: { readonly issuer?: string } = {}) {
  const net = scriptedOAuthNetwork(options);

  restore = net.restore;

  return net;
}

async function readSurface(h: TestUserDO, owner: UserCaller) {
  return v.parse(McpToolSurfaceSchema, await h.userDO.userMcp_toolDescriptors(owner));
}

/** Why `made` was refused, its whole cause chain. */
async function failureOf(made: Promise<string>): Promise<string> {
  const [outcome] = await Promise.allSettled([made]);

  if (outcome?.status !== 'rejected') throw new Error('the call was not refused');

  return renderThrownChain({ cause: outcome.reason });
}

async function call(h: TestUserDO, serverId: string, args: JsonObject = {}): Promise<string> {
  return h.userDO.userMcp_callTool(await testOwner(), { serverId, name: SCRIPTED_MCP_TOOL, args, id: crypto.randomUUID() });
}

/** The server added, and signed in to as a person does: the sign-in begun from a page, authorized at the issuer, and
 *  ended at the product's callback. */
async function signedIn(h: TestUserDO, ttl: number): Promise<string> {
  const owner = await testOwner();
  const added = await h.userDO.userMcp_add(owner, { name: 'scripted', serverUrl: scriptedOAuthServer(ttl) }, 'https://kinu.example');

  expect(added.signIn).toBe(true);
  const run = crypto.randomUUID();
  const callback = await consented((await h.userDO.userMcp_beginConnect(owner, added.id, run)).authUrl);

  expect(new URL(callback).pathname).toBe('/api/user/mcp/callback');
  expect(await h.userDO.userMcp_handleOAuthCallback(owner, callback)).toEqual({ run, service: 'scripted', error: null });

  return added.id;
}

describe('an OAuth MCP server, signed in at its add', () => {
  test('waits for its sign-in, then connects through the callback; its tools are listed, offered and called, and a wake keeps them', async () => {
    network();
    const h = createTestUserDO();
    const owner = await testOwner();

    try {
      const id = await signedIn(h, 3600);

      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.name, s.status, s.toolsCount, s.signIn])).toEqual([['scripted', 'connected', 1, false]]);
      expect((await readSurface(h, owner)).descriptors.map((d) => d.toolKey)).toEqual(['mcp_scripted_session']);
      expect(JSON.parse(await call(h, id))).toMatchObject({ content: [{ type: 'text' }] });
      // Its login is kept in the account's storage sealed, as every credential is.
      const kept = [...kvOf(h.db)].filter(([key]) => key.startsWith(`/kinu-user-mcp/${id}/`));

      expect({ kept: kept.length > 0, sealed: kept.every(([, value]) => typeof value === 'string' && value.startsWith('pce1.')) }).toEqual({ kept: true, sealed: true });

      const woken = createTestUserDO({ storage: h.db });

      try {
        expect(JSON.parse(await call(woken, id))).toMatchObject({ content: [{ type: 'text' }] });
      } finally {
        woken.close();
      }
    } finally {
      h.close();
    }
  });
});

describe("an OAuth login's renewal", () => {
  test('a login about to expire is renewed before the calls that need it, once for calls made together', async () => {
    const net = network();
    const h = createTestUserDO();

    try {
      const id = await signedIn(h, 3600);

      setSystemTime(new Date(Date.now() + 3570 * 1000));
      await Promise.all([1, 2, 3].map(async () => call(h, id)));
      expect(net.refreshes).toHaveLength(1);

      // The grant was not revoked: an hour on, it renews again.
      setSystemTime(new Date(Date.now() + 2 * 3600 * 1000));
      await call(h, id);
      expect(net.refreshes).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  // Calls arriving together after the server expired a token each met a 401, and each refreshed the same refresh token:
  // the server revoked the grant on the second (the owner, 2026-10-08: "MCP seems to feel a bit unreliable?").
  test('calls refused together for a token the server expired renew it once, and each is sent again', async () => {
    const net = network();
    const h = createTestUserDO();

    try {
      const id = await signedIn(h, 3600);

      await call(h, id, { expire: true });
      const answers = await Promise.all([1, 2, 3].map(async () => call(h, id)));

      // No refresh token was presented twice, so the grant still renews.
      expect({ answered: answers.every((answer) => answer.includes('session')), once: new Set(net.refreshes).size === net.refreshes.length }).toEqual({ answered: true, once: true });
      await call(h, id, { expire: true });
      expect(await call(h, id)).toContain('session');
    } finally {
      h.close();
    }
  });

  test('a renewal that fails for now leaves the server connected: a token still valid is used, an expired one fails the call, and the next call renews', async () => {
    const net = network();
    const h = createTestUserDO();
    const owner = await testOwner();
    const statuses: string[] = [];
    const noted = (name: string, fields: LogFields | undefined): void => { if (name === 'mcp.status_changed') statuses.push(String(fields?.['to'])); };

    let quiet = (): void => undefined;

    try {
      const id = await signedIn(h, 3600);

      quiet = setDiagnosticsSink({ event: noted, failure: () => undefined });

      net.renewals = 'unreachable';
      setSystemTime(new Date(Date.now() + 3570 * 1000));
      expect(JSON.parse(await call(h, id))).toMatchObject({ content: [{ type: 'text' }] });

      setSystemTime(new Date(Date.now() + 60 * 1000));
      expect(await failureOf(call(h, id))).toContain('renewing the sign-in of MCP server scripted');
      expect((await h.userDO.userMcp_list(owner)).map((s) => s.status)).toEqual(['connected']);

      // A Reconnect asked for meanwhile says why it did not reconnect, and leaves the row as it was.
      const reconnected = await h.userDO.userMcp_reconnect(owner, id);

      expect({ status: reconnected.status, said: reconnected.error?.includes('renewing the sign-in of MCP server scripted') }).toEqual({ status: 'connected', said: true });

      net.renewals = 'serving';
      expect(JSON.parse(await call(h, id))).toMatchObject({ content: [{ type: 'text' }] });
      expect({ refreshes: net.refreshes.length, statuses }).toEqual({ refreshes: 1, statuses: [] });
    } finally {
      quiet();
      h.close();
    }
  });

  // Review, 2026-10-25: a renewal went to whatever authorization server the server's discovery named, so a server that
  // changed it could be handed the login's refresh token. A login renews only at the issuer that granted it (SEP-2352).
  test('a server that now names another issuer is never asked of, nor sent the login: it renews where it was granted', async () => {
    const net = network();
    const h = createTestUserDO();
    const owner = await testOwner();

    try {
      const id = await signedIn(h, 3600);

      net.issuerMovedTo = 'https://issuer.elsewhere.example';
      setSystemTime(new Date(Date.now() + 3570 * 1000));
      expect(JSON.parse(await call(h, id))).toMatchObject({ content: [{ type: 'text' }] });
      expect({ moved: net.moved, refreshes: net.refreshes.length, status: (await h.userDO.userMcp_list(owner)).map((s) => s.status) })
        .toEqual({ moved: [], refreshes: 1, status: ['connected'] });
    } finally {
      h.close();
    }
  });

  // Review, 2026-10-25: the SDK's discovery takes a protected-resource read that failed for the server's own origin, so,
  // with an issuer on another origin, a 503 there read as an issuer change and would have ended a good login.
  test('a protected-resource read that fails for now leaves a login on another origin to renew at its issuer', async () => {
    const net = network({ issuer: 'https://issuer.scripted.example' });
    const h = createTestUserDO();
    const owner = await testOwner();

    try {
      const id = await signedIn(h, 3600);

      net.resourceMetadataDown = true;
      setSystemTime(new Date(Date.now() + 3570 * 1000));
      expect(JSON.parse(await call(h, id))).toMatchObject({ content: [{ type: 'text' }] });
      expect({ refreshes: net.refreshes.length, status: (await h.userDO.userMcp_list(owner)).map((s) => s.status) }).toEqual({ refreshes: 1, status: ['connected'] });
    } finally {
      h.close();
    }
  });

  test('a login the issuer refuses to renew needs a sign-in: its server offers no tool and is sent no call until it has one', async () => {
    const net = network();
    const h = createTestUserDO();
    const owner = await testOwner();

    try {
      const id = await signedIn(h, 3600);

      net.renewals = 'refusing';
      setSystemTime(new Date(Date.now() + 3601 * 1000));
      expect(await failureOf(call(h, id))).toContain('needs a sign-in');
      expect((await h.userDO.userMcp_list(owner)).map((s) => [s.status, s.signIn])).toEqual([['needs_sign_in', true]]);
      expect((await readSurface(h, owner)).unavailable.map((u) => u.reason)).toEqual(['waiting for a sign-in: sign in to it again in Settings > MCP servers.']);
      await expect(call(h, id)).rejects.toThrow('waits for a sign-in, so the call was not sent');

      // Signed in again, it is connected and called.
      net.renewals = 'serving';
      const run = crypto.randomUUID();
      const callback = await consented((await h.userDO.userMcp_beginConnect(owner, id, run)).authUrl);

      expect(await h.userDO.userMcp_handleOAuthCallback(owner, callback)).toEqual({ run, service: 'scripted', error: null });
      expect(JSON.parse(await call(h, id))).toMatchObject({ content: [{ type: 'text' }] });
    } finally {
      h.close();
    }
  });
});
