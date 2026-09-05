/**
 * The preview sanitizer strips exactly the authority the app itself minted.
 *
 * A preview request crosses into agent-controlled guest code, and the strip
 * list decides which of the browser's cookies and which bearer go with it. The
 * list used to be a hand-kept copy of two other modules' enumerations, and it
 * drifted in both directions: it stripped a cookie no setter in the tree
 * writes, and it let a cookie `cli/routes.ts` does set through. So the list is
 * derived here from the modules that own it, and this file holds the two sides
 * of that derivation to the same set.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizePreviewRequestHeaders } from '../src/lib/preview-request';
import {
  CLI_APPROVAL_CSRF_COOKIE_NAME, KINU_COOKIE_NAMES, OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME,
} from '../src/auth/session';
import { parseCliBearer } from '../src/cli/auth-store';

const USER_ID = '0123456789abcdef0123456789abcdef';
/** 44 characters of the alphabet `nanoid` mints from: what a real token
 *  carries after its user id. */
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdef';

function forwarded(headers: Record<string, string>): Headers {
  return sanitizePreviewRequestHeaders(new Headers(headers));
}

describe('cookies: the strip set is the set of cookies the app sets', () => {
  test('every cookie the app sets is stripped, and only those', () => {
    // Parametric over the owner's set: a cookie registered in auth/session.ts
    // is covered here the moment it is registered.
    const guest = 'guest_session=guest';
    const cookie = [...KINU_COOKIE_NAMES.map((name) => `${name}=owner`), guest].join('; ');

    expect(forwarded({ cookie }).get('cookie')).toBe(guest);
  });

  test('the approval CSRF cookie the CLI sign-in page sets is one of them', () => {
    // The drift the hand-kept copy had: `cli/routes.ts` sets this cookie on the
    // browser approval page, and the copy did not know it.
    expect(KINU_COOKIE_NAMES.includes(CLI_APPROVAL_CSRF_COOKIE_NAME)).toBe(true);
    expect(forwarded({ cookie: `${CLI_APPROVAL_CSRF_COOKIE_NAME}=csrf; guest=1` }).get('cookie')).toBe('guest=1');
  });

  test('the two authority cookies are among them', () => {
    expect(KINU_COOKIE_NAMES.includes(SESSION_COOKIE_NAME)).toBe(true);
    expect(KINU_COOKIE_NAMES.includes(OAUTH_STATE_COOKIE_NAME)).toBe(true);
  });

  test('a Kinu-looking cookie nothing here sets is a guest cookie', () => {
    // The other direction of the same drift: the copy stripped a bookmark
    // cookie no setter in the tree writes. A name outside the owner's set is
    // the guest's, whatever it is called.
    const forged = '__Host-kinu_d1_bookmark=bookmark';
    expect(KINU_COOKIE_NAMES.includes('__Host-kinu_d1_bookmark')).toBe(false);
    expect(forwarded({ cookie: forged }).get('cookie')).toBe(forged);
  });

  test('a request whose only cookies were the app\'s carries none', () => {
    expect(forwarded({ cookie: `${SESSION_COOKIE_NAME}=owner` }).get('cookie')).toBeNull();
  });
});

describe('bearer: stripped exactly when the CLI authenticator would route it', () => {
  const candidates = [
    `ptc_${USER_ID}_${SECRET}`,
    `pta_${USER_ID}_${SECRET}`,
    // Prefix alone is not a token: the authenticator refuses these as
    // malformed, so they carry no authority and belong to the guest.
    'ptc_not-a-token',
    `pta_${USER_ID}`,
    // A device token travels in the body of `/pc/connect-ticket`, never as a
    // bearer; no authenticator reads one from this header.
    `pdt_${SECRET}`,
    'guest-token',
  ];

  test('the strip decision is the authenticator\'s own parse', () => {
    for (const token of candidates) {
      const stripped = forwarded({ authorization: `Bearer ${token}` }).get('authorization') === null;
      expect({ token, stripped }).toEqual({ token, stripped: parseCliBearer(token) !== null });
    }
  });

  test('both token kinds the authenticator mints are stripped', () => {
    expect(parseCliBearer(`ptc_${USER_ID}_${SECRET}`)).toEqual({ userId: USER_ID, kind: 'session' });
    expect(parseCliBearer(`pta_${USER_ID}_${SECRET}`)).toEqual({ userId: USER_ID, kind: 'access' });
    expect(forwarded({ authorization: `bearer ptc_${USER_ID}_${SECRET}` }).get('authorization')).toBeNull();
    expect(forwarded({ authorization: `Bearer  pta_${USER_ID}_${SECRET}` }).get('authorization')).toBeNull();
  });

  test('a guest bearer and a non-bearer scheme go through untouched', () => {
    expect(forwarded({ authorization: 'Bearer guest-token' }).get('authorization')).toBe('Bearer guest-token');
    expect(forwarded({ authorization: 'Basic Zm9vOmJhcg==' }).get('authorization')).toBe('Basic Zm9vOmJhcg==');
  });
});

describe('the rest of the strip', () => {
  test('proxy credentials and every x-kinu-* header never reach guest code', () => {
    const out = forwarded({
      'proxy-authorization': 'Basic c2VjcmV0',
      'x-kinu-user-id': USER_ID,
      'X-Kinu-Auth-Scope': 'owner',
      'x-guest-header': 'kept',
    });
    expect(out.get('proxy-authorization')).toBeNull();
    expect(out.get('x-kinu-user-id')).toBeNull();
    expect(out.get('x-kinu-auth-scope')).toBeNull();
    expect(out.get('x-guest-header')).toBe('kept');
  });

  test('the input headers are left as they were', () => {
    const input = new Headers({ cookie: `${SESSION_COOKIE_NAME}=owner`, authorization: `Bearer ptc_${USER_ID}_${SECRET}` });
    sanitizePreviewRequestHeaders(input);
    expect(input.get('cookie')).toBe(`${SESSION_COOKIE_NAME}=owner`);
    expect(input.get('authorization')).toBe(`Bearer ptc_${USER_ID}_${SECRET}`);
  });
});
