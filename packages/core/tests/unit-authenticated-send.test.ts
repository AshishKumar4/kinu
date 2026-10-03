/**
 * The one authenticated call every renewing transport makes (Claude, Codex, ChatGPT, the account's Cloudflare
 * endpoint): one renewal of the refused login, one resend, then the refusal for the vendor to word.
 */
import { describe, expect, test } from 'bun:test';
import { authenticatedSend } from '../src/providers/authenticated-send';
import type { AuthRequest, AuthResolution } from '../src/providers/types';

const login = (token: string): AuthResolution => ({ headers: { Authorization: `Bearer ${token}` } });

function account(logins: (AuthResolution | null)[], accepted: readonly string[]) {
  const asked: (string | null)[] = [];
  const sent: string[] = [];

  return {
    asked, sent,
    getAuth: async (_key: string, request?: AuthRequest) => {
      asked.push(request?.rejected?.Authorization ?? null);

      return logins.shift() ?? null;
    },
    send: async (auth: AuthResolution) => {
      const token = auth.headers.Authorization ?? '';
      sent.push(token);

      return new Response(token, { status: accepted.includes(token) ? 200 : 401 });
    },
  };
}

describe('authenticatedSend', () => {
  test('a refused login is renewed once, naming the token refused, and the call is sent again once', async () => {
    const wire = account([login('old'), login('new')], ['Bearer new']);
    const answer = await authenticatedSend({ key: 'claude.oauth', getAuth: wire.getAuth, send: wire.send });

    expect(answer).toMatchObject({ kind: 'answered', auth: login('new') });
    expect(wire.asked).toEqual([null, 'Bearer old']);
    expect(wire.sent).toEqual(['Bearer old', 'Bearer new']);
  });

  test('a renewal that is refused too, or none at all, is the refusal; no login is absent; nothing is sent a third time', async () => {
    const twice = account([login('old'), login('new')], []);
    expect(await authenticatedSend({ key: 'k', getAuth: twice.getAuth, send: twice.send })).toMatchObject({ kind: 'refused', reason: 'the renewed login was refused too' });
    expect(twice.sent).toHaveLength(2);

    const gone = account([login('old'), null], []);
    expect(await authenticatedSend({ key: 'k', getAuth: gone.getAuth, send: gone.send })).toMatchObject({ kind: 'refused', reason: 'the login was refused and could not be renewed' });
    expect(gone.sent).toEqual(['Bearer old']);

    const none = account([null], []);
    expect(await authenticatedSend({ key: 'k', getAuth: none.getAuth, send: none.send })).toEqual({ kind: 'absent' });
    expect(none.sent).toEqual([]);
  });
});
