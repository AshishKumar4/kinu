// Built-in sign-in's security contracts, through its routes and the real UserDO that holds the accounts.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { builtinAccountRoutes, builtinAuthRoutes, type BuiltinAuthEnv } from '../src/auth/builtin';
import { authPageRoutes } from '../src/auth/routes';
import type { AuthIdentity } from '../src/auth/session';
import { deriveBuiltinUserId, deriveUserId, verifySession } from '../src/auth/store';
import { readCookie, SESSION_COOKIE_NAME } from '../src/auth/session';
import { serveFamily } from './helpers/api';
import { makeKv } from './helpers/kv';
import { createTestUserDO, TEST_CREDENTIAL_ENCRYPTION_KEY, type TestUserDO } from './helpers/user-do';
import { workspaceObject } from './helpers/bindings';
import type { JsonValue } from '@kinu.run/core';

const ORIGIN = 'https://kinu.example.com';

const SETUP_TOKEN = 'the deployer set this secret';

const harnesses: TestUserDO[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

/** A deployment with no OAuth app: every UserDO by name, the built-in accounts object among them. */
function deployment() {
  const objects = new Map<string, TestUserDO>();

  const objectFor = (name: string): TestUserDO => {
    const existing = objects.get(name);

    if (existing) return existing;
    const created = createTestUserDO();

    harnesses.push(created);
    objects.set(name, created);

    return created;
  };

  const unreachable = new Set<string>();

  const reach = (name: string): TestUserDO['userDO'] => {
    if (unreachable.has(name)) throw new Error(`${name} is unreachable`);

    return objectFor(name).userDO;
  };

  const env: BuiltinAuthEnv<string> = {
    AUTH_KV: makeKv(),
    UserDO: { idFromName: (name) => name, get: reach },
    OrchestratorAgent: { idFromName: (name) => name, get: () => workspaceObject({}) },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    KINU_SETUP_TOKEN: SETUP_TOKEN,
  };

  const post = async (path: string, body: JsonValue, identity?: AuthIdentity): Promise<Response> => {
    const request = new Request(`${ORIGIN}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body),
    });

    const answer = identity === undefined
      ? await serveFamily(builtinAuthRoutes)(request, env)
      : await serveFamily(builtinAccountRoutes, { identity })(request, env);

    if (!answer) throw new Error(`no route answered ${path}`);

    return answer;
  };

  const register = (email: string, invite?: string) =>
    post('/api/auth/builtin/password/register', { email, password: 'a long enough password', invite: invite ?? null });

  /** The owner's sign-up, with the deployer's setup token in the body. */
  const registerOwner = (email: string, setup: string | null = SETUP_TOKEN) =>
    post('/api/auth/builtin/password/register', { email, password: 'a long enough password', setup });

  const page = async (path: string): Promise<string> => {
    const answer = await serveFamily(authPageRoutes)(new Request(`${ORIGIN}${path}`), env);

    if (!answer) throw new Error(`no route answered ${path}`);

    return answer.text();
  };

  return { env, objectFor, page, post, register, registerOwner, unreachable };
}

const ErrorSchema = v.object({ error: v.string() });

const InviteSchema = v.object({ url: v.string() });

const ChallengeSchema = v.object({ challenge: v.string() });

async function identityOf(email: string): Promise<AuthIdentity> {
  return { userId: await deriveBuiltinUserId(email), email, sub: 'sub', provider: 'password', authTime: Date.now() };
}

describe('who may register', () => {
  test('after the first account, registration without a valid invite is refused', async () => {
    const { register, registerOwner } = deployment();

    expect((await registerOwner('owner@example.com')).status).toBe(200);
    const stranger = await register('stranger@example.com');
    const forged = await register('forger@example.com', 'not-an-invite');

    expect(stranger.status).toBe(403);
    expect(v.parse(ErrorSchema, await stranger.json()).error).toContain('Ask the owner');
    expect(forged.status).toBe(403);
  });

  test("an owner's invite admits its one address, once", async () => {
    const { post, register, registerOwner } = deployment();

    await registerOwner('owner@example.com');
    const made = await post('/api/user/builtin-auth/invites', { email: 'First@Example.com' }, await identityOf('owner@example.com'));
    const invite = new URL(v.parse(InviteSchema, await made.json()).url).searchParams.get('invite') ?? '';

    // The invite names its address: any other is refused, and the invite stays unspent for its own.
    const elsewhere = await register('victim@example.com', invite);

    expect(elsewhere.status).toBe(403);
    expect(v.parse(ErrorSchema, await elsewhere.json()).error).toContain('different email');
    expect((await register('first@example.com', invite)).status).toBe(200);
    const again = await register('first@example.com', invite);
    const another = await register('second@example.com', invite);

    expect(again.status).toBe(403);
    expect(another.status).toBe(403);
    expect(v.parse(ErrorSchema, await another.json()).error).toContain('not valid');
  });
});

describe('the owner seat and the namespace', () => {
  test('the owner seat needs the setup token, and a declared OAuth provider turns built-in sign-in off', async () => {
    const { env, registerOwner } = deployment();

    expect((await registerOwner('first@example.com', null)).status).toBe(403);
    expect((await registerOwner('first@example.com', 'a guess')).status).toBe(403);

    // A client id with no secret is a broken provider: sign-in is unavailable, never built-in.
    Object.assign(env, { GOOGLE_OAUTH_CLIENT_ID: 'declared-but-broken' });
    expect((await registerOwner('first@example.com')).status).toBe(404);
  });

  test('a sign-up no seat or invite admits is refused the same, whether or not its email has an account', async () => {
    const { register, registerOwner } = deployment();

    await registerOwner('owner@example.com');
    const known = await register('owner@example.com');
    const unknown = await register('nobody@example.com');

    expect([known.status, await known.text()]).toEqual([unknown.status, await unknown.text()]);
  });

  test("a built-in account is not its address's OAuth account, and its session ends once OAuth is declared", async () => {
    const { env, registerOwner } = deployment();
    const answer = await registerOwner('owner@example.com');
    const token = sessionOf(answer);

    const identity = await verifySession(env, token);

    expect(identity?.userId).toBe(await deriveBuiltinUserId('owner@example.com'));
    expect(identity?.userId).not.toBe(await deriveUserId('owner@example.com'));

    Object.assign(env, { GOOGLE_OAUTH_CLIENT_ID: 'now-oauth', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' });
    expect(await verifySession(env, token)).toBeNull();
  });
});

const sessionOf = (answer: Response): string =>
  readCookie(new Request(ORIGIN, { headers: { cookie: answer.headers.get('set-cookie') ?? '' } }), SESSION_COOKIE_NAME) ?? '';

describe('a reset link', () => {
  test("replaces a member's password once, and ends the sessions it had", async () => {
    const { env, post, register, registerOwner } = deployment();
    const owner = await identityOf('owner@example.com');

    await registerOwner('owner@example.com');
    const invited = await post('/api/user/builtin-auth/invites', { email: 'member@example.com' }, owner);
    const invite = new URL(v.parse(InviteSchema, await invited.json()).url).searchParams.get('invite') ?? '';
    const before = sessionOf(await register('member@example.com', invite));

    expect(await verifySession(env, before)).not.toBeNull();
    const made = await post('/api/user/builtin-auth/resets', { email: 'member@example.com' }, owner);
    const reset = new URL(v.parse(InviteSchema, await made.json()).url).searchParams.get('reset') ?? '';
    const used = await post('/api/auth/builtin/password/reset', { reset, password: 'a brand new password' });
    const again = await post('/api/auth/builtin/password/reset', { reset, password: 'yet another password' });

    expect(used.status).toBe(200);
    expect(again.status).toBe(403);
    expect(await verifySession(env, before)).toBeNull();
    expect(await verifySession(env, sessionOf(used))).not.toBeNull();
    expect((await post('/api/auth/builtin/password/sign-in', { email: 'member@example.com', password: 'a brand new password' })).status).toBe(200);
    expect((await post('/api/auth/builtin/password/sign-in', { email: 'member@example.com', password: 'a long enough password' })).status).toBe(401);
  });
});

describe('a reset and the sessions it ends are one transition', () => {
  const OWNER = 'owner@example.com';
  const reset = (post: ReturnType<typeof deployment>['post'], password: string) => post('/api/auth/builtin/password/reset', { setup: SETUP_TOKEN, password });
  const signIn = (post: ReturnType<typeof deployment>['post'], password: string) => post('/api/auth/builtin/password/sign-in', { email: OWNER, password });

  test("a reset whose session ending fails never leaves an old session beside the new password, and can be retried", async () => {
    const { env, post, registerOwner, unreachable } = deployment();
    const before = sessionOf(await registerOwner(OWNER));
    const owner = await deriveBuiltinUserId(OWNER);

    unreachable.add(owner);
    const [failed] = await Promise.allSettled([reset(post, 'a brand new password')]);

    unreachable.clear();
    const newPasswordWorks = (await signIn(post, 'a brand new password')).status === 200;

    expect(failed?.status === 'fulfilled' && failed.value.status === 200).toBe(false);
    expect(newPasswordWorks && await verifySession(env, before) !== null).toBe(false);
    expect((await reset(post, 'a brand new password')).status).toBe(200);
    expect(await verifySession(env, before)).toBeNull();
  });

  test('a sign-in that read the old password before a reset does not outlive the reset', async () => {
    const { env, objectFor, post, registerOwner } = deployment();

    await registerOwner(OWNER);
    const target = objectFor(await deriveBuiltinUserId(OWNER)).userDO;
    const register = target.registerBrowserSession.bind(target);
    let after: Response | null = null;

    target.registerBrowserSession = async (...args) => {
      target.registerBrowserSession = register;
      after = await reset(post, 'a brand new password');

      return register(...args);
    };

    const racing = await signIn(post, 'a long enough password');

    expect(after).not.toBeNull();
    expect(await verifySession(env, sessionOf(after ?? racing))).not.toBeNull();
    expect(await verifySession(env, sessionOf(racing))).toBeNull();
  });
});

test('the setup token never rides in a URL: /login takes it in a password field and never renders it back', async () => {
  const { page, registerOwner } = deployment();
  const owner = await page(`/login?setup=${encodeURIComponent(SETUP_TOKEN)}`);

  expect(owner).toContain('<input type="password" name="setup"');
  expect(owner).not.toContain(SETUP_TOKEN);
  expect(owner).not.toContain(encodeURIComponent(SETUP_TOKEN));
  await registerOwner('owner@example.com');
  const signIn = await page(`/login?setup=${encodeURIComponent(SETUP_TOKEN)}`);

  expect(signIn).toContain('Set up or recover the owner');
  // The recovery field names the status line that reads its outcome to a screen reader.
  expect(signIn).toContain('aria-describedby="recovery-status"');
  expect(signIn).toContain('id="recovery-status"');
  expect(signIn).not.toContain('owner@example.com');
  expect(signIn).not.toContain(encodeURIComponent(SETUP_TOKEN));
});

test("the deployer's setup token resets the owner's sign-in and ends the owner's sessions", async () => {
  const { env, post, registerOwner } = deployment();
  const before = sessionOf(await registerOwner('owner@example.com'));
  const guessed = await post('/api/auth/builtin/password/reset', { setup: 'a guess', password: 'a brand new password' });
  const reset = await post('/api/auth/builtin/password/reset', { setup: SETUP_TOKEN, password: 'a brand new password' });

  expect(guessed.status).toBe(403);
  expect(v.parse(ErrorSchema, await guessed.json()).error).toBe('That is not the setup token.');
  expect(reset.status).toBe(200);
  expect(await verifySession(env, before)).toBeNull();
  expect((await post('/api/auth/builtin/password/sign-in', { email: 'owner@example.com', password: 'a brand new password' })).status).toBe(200);
  expect((await post('/api/auth/builtin/password/sign-in', { email: 'owner@example.com', password: 'a long enough password' })).status).toBe(401);
});

describe('signing in', () => {
  test('a wrong password is refused, and no session is set', async () => {
    const { post, registerOwner } = deployment();

    await registerOwner('owner@example.com');
    const wrong = await post('/api/auth/builtin/password/sign-in', { email: 'owner@example.com', password: 'not the password' });
    const right = await post('/api/auth/builtin/password/sign-in', { email: 'owner@example.com', password: 'a long enough password' });

    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect(right.status).toBe(200);
    expect(right.headers.get('set-cookie')).toContain('Secure');
  });

  test("an unknown email costs the same password derivation as a known one, so timing does not say which exist", async () => {
    const { post, registerOwner } = deployment();

    await registerOwner('owner@example.com');
    const derivations = spyOn(crypto.subtle, 'deriveBits');

    await post('/api/auth/builtin/password/sign-in', { email: 'owner@example.com', password: 'not the password' });
    const known = derivations.mock.calls.length;

    await post('/api/auth/builtin/password/sign-in', { email: 'nobody@example.com', password: 'not the password' });
    const unknown = derivations.mock.calls.length - known;

    derivations.mockRestore();
    expect(known).toBeGreaterThan(0);
    expect(unknown).toBe(known);
  });

  test('a passkey sign-in answered once cannot be replayed: its challenge is spent', async () => {
    const { post } = deployment();
    const authenticator = await Authenticator.create();

    const creation = v.parse(ChallengeSchema, await (await post('/api/auth/builtin/passkey/register/options', { email: 'owner@example.com', setup: SETUP_TOKEN })).json());

    expect((await post('/api/auth/builtin/passkey/register', { response: await authenticator.attest(creation.challenge) })).status).toBe(200);

    const request = v.parse(ChallengeSchema, await (await post('/api/auth/builtin/passkey/sign-in/options', {})).json());
    const assertion = await authenticator.assert(request.challenge);
    const first = await post('/api/auth/builtin/passkey/sign-in', { response: assertion });
    const replay = await post('/api/auth/builtin/passkey/sign-in', { response: assertion });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(v.parse(ErrorSchema, await replay.json()).error).toContain('already used');
  });
});

// --- A software passkey: ES256, attestation "none", user verified --------------------------------------------

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => new Uint8Array(parts.flatMap((part) => [...part]));

/** The CBOR WebAuthn needs, one encoder per kind: unsigned and negative ints, text, bytes, maps. */
function head(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);

  if (length < 256) return Uint8Array.of((major << 5) | 24, length);

  return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
}

const int = (value: number): Uint8Array => (value >= 0 ? head(0, value) : head(1, -1 - value));

const text = (value: string): Uint8Array => concat(head(3, Buffer.byteLength(value)), new TextEncoder().encode(value));

const bytes = (value: Uint8Array): Uint8Array => concat(head(2, value.length), value);

/** Keys and values already encoded. */
const map = (entries: readonly (readonly [Uint8Array, Uint8Array])[]): Uint8Array =>
  concat(head(5, entries.length), ...entries.flatMap(([key, value]) => [key, value]));

/** WebCrypto signs P-256 as r||s; WebAuthn carries it as an ASN.1 DER sequence. */
function der(raw: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array): Uint8Array => {
    let start = 0;

    while (start < half.length - 1 && half[start] === 0) start += 1;
    const trimmed = half.slice(start);
    const padded = (trimmed[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;

    return concat(Uint8Array.of(0x02, padded.length), padded);
  };

  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));

  return concat(Uint8Array.of(0x30, body.length), body);
}

class Authenticator {
  private counter = 0;

  private constructor(private readonly keys: CryptoKeyPair, readonly credentialId: Uint8Array) {}

  static async create(): Promise<Authenticator> {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

    return new Authenticator(keys, crypto.getRandomValues(new Uint8Array(16)));
  }

  private clientData(type: string, challenge: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  }

  private authData(flags: number, attested: Uint8Array = new Uint8Array()): Uint8Array {
    this.counter += 1;
    const count = Uint8Array.of(0, 0, 0, this.counter);

    return concat(sha256(new TextEncoder().encode(new URL(ORIGIN).hostname)), Uint8Array.of(flags), count, attested);
  }

  async attest(challenge: string) {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const coordinate = (value: string | undefined): Uint8Array => new Uint8Array(Buffer.from(value ?? '', 'base64url'));
    const coseKey = map([[int(1), int(2)], [int(3), int(-7)], [int(-1), int(1)], [int(-2), bytes(coordinate(jwk.x))], [int(-3), bytes(coordinate(jwk.y))]]);
    const attested = concat(new Uint8Array(16), Uint8Array.of(0, this.credentialId.length), this.credentialId, coseKey);
    // User present, user verified, attested credential data.
    const authData = this.authData(0x45, attested);
    const attestationObject = map([[text('fmt'), text('none')], [text('attStmt'), map([])], [text('authData'), bytes(authData)]]);

    return {
      id: b64url(this.credentialId), rawId: b64url(this.credentialId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64url(this.clientData('webauthn.create', challenge)), attestationObject: b64url(attestationObject), transports: ['internal'] },
    };
  }

  async assert(challenge: string) {
    const clientData = this.clientData('webauthn.get', challenge);
    const authData = this.authData(0x05);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, concat(authData, sha256(clientData))));

    return {
      id: b64url(this.credentialId), rawId: b64url(this.credentialId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(der(signature)) },
    };
  }
}
