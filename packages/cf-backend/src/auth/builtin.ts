/**
 * Built-in sign-in where no OAuth app is configured: password or passkey. The first account is the owner; later
 * ones need its invite. A success mints the OAuth callback's session (`createSession`).
 */
import { Hono } from 'hono';
import { generateAuthenticationOptions, generateRegistrationOptions } from '@simplewebauthn/server';
import { AssertionSchema, AttestationSchema, answeredChallenge, verifyNewPasskey, verifyPasskeyAnswer } from './passkeys';
import { base64Url, json, ownerCaller, randomToken, sha256Hex, timingSafeEqual } from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { readKvJson, writeKvJson } from '@kinu.run/agent-utils';
import * as v from 'valibot';
import { SESSION_COOKIE_NAME, setCookie } from './session';
import { createSession, deriveUserId, sanitizeReturnTo, type OAuthProfile } from './store';
import { listConfiguredOAuthProviders, type OAuthProviderEnv } from './providers';
import type { AuthRoutesAuthority, AuthRoutesEnv } from './routes';
import { BUILTIN_ACCOUNTS_OBJECT, type ChallengePurpose, type PasswordHash } from '@kinu.run/core/identity';
import type { UserDO } from '../user/user-do';
import type { ApiVariables, FamilyEnv } from '../api/context';
import type { ObjectNamespace } from '@kinu.run/core';

export type BuiltinAuthority = AuthRoutesAuthority & Pick<UserDO,
  | 'builtinAdmissible' | 'builtinCreateInvite' | 'builtinIsOwner' | 'builtinIssueChallenge' | 'builtinPasskeyAccount'
  | 'builtinPasswordAccount' | 'builtinRecordPasskeyUse' | 'builtinRegister' | 'builtinSpendChallenge'>;

export interface BuiltinAuthEnv<Id = DurableObjectId> extends Omit<AuthRoutesEnv<Id>, 'UserDO'> {
  UserDO: ObjectNamespace<Id, BuiltinAuthority>;
}

/** PBKDF2-SHA256's ceiling on Cloudflare: workerd refuses "iteration counts above 100000". */
const PASSWORD_ITERATIONS = 100_000;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FREE_FAILURES = 5;

const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const MAX_LOCK_MS = 15 * 60 * 1000;

const RP_NAME = 'Kinu';

export function builtinAuthEnabled(env: OAuthProviderEnv): boolean {
  return listConfiguredOAuthProviders(env).length === 0;
}

export function builtinAccounts<Id, Authority>(env: { UserDO: ObjectNamespace<Id, Authority> }): Authority {
  return env.UserDO.get(env.UserDO.idFromName(BUILTIN_ACCOUNTS_OBJECT));
}

const accounts = <Id>(env: BuiltinAuthEnv<Id>): BuiltinAuthority => builtinAccounts(env);

async function derive(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, key, 256,
  );

  return base64Url(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomToken(16);

  return { hash: await derive(password, salt, PASSWORD_ITERATIONS), salt, iterations: PASSWORD_ITERATIONS };
}

const FailuresSchema = v.object({ count: v.number(), lockedUntil: v.number() });

const failureKeys = async (email: string, address: string): Promise<string[]> => [
  `builtin-fail:email:${await sha256Hex(email)}`,
  `builtin-fail:ip:${await sha256Hex(address)}`,
];

async function waitBeforeAttempt<Id>(env: BuiltinAuthEnv<Id>, email: string, address: string): Promise<number> {
  const now = Date.now();
  const records = await Promise.all((await failureKeys(email, address)).map((key) => readKvJson(env.AUTH_KV, key, FailuresSchema)));

  return Math.max(0, ...records.map((record) => (record?.lockedUntil ?? 0) - now));
}

async function recordFailure<Id>(env: BuiltinAuthEnv<Id>, email: string, address: string): Promise<void> {
  const now = Date.now();

  await Promise.all((await failureKeys(email, address)).map(async (key) => {
    const count = ((await readKvJson(env.AUTH_KV, key, FailuresSchema))?.count ?? 0) + 1;
    const lockedUntil = count <= FREE_FAILURES ? 0 : now + Math.min(MAX_LOCK_MS, 1000 * 2 ** (count - FREE_FAILURES));

    await writeKvJson(env.AUTH_KV, key, { count, lockedUntil }, FAILURE_WINDOW_MS);
  }));
}

async function clearFailures<Id>(env: BuiltinAuthEnv<Id>, email: string): Promise<void> {
  const [emailKey] = await failureKeys(email, '');

  if (emailKey !== undefined) await env.AUTH_KV.delete(emailKey);
}

const refuse = (message: string, status = 400, headers: HeadersInit = {}): Response => json({ body: { error: message } }, { status, headers });

const throttled = (waitMs: number): Response => refuse(
  `Too many failed sign-ins. Try again in ${String(Math.ceil(waitMs / 1000))} s.`, 429, { 'retry-after': String(Math.ceil(waitMs / 1000)) },
);

async function signedIn<Id>(env: BuiltinAuthEnv<Id>, profile: OAuthProfile, returnTo: string): Promise<Response> {
  const session = await createSession(env, profile);
  const headers = new Headers({ 'cache-control': 'no-store' });

  headers.append('set-cookie', setCookie(SESSION_COOKIE_NAME, session.token, session.expiresAt - session.issuedAt));

  return json({ body: { returnTo: sanitizeReturnTo(returnTo) } }, { headers });
}

/** The email is the name the account was admitted under, not one a provider verified: admission vouches for it. */
const builtinProfile = (method: 'password' | 'passkey', userId: string, email: string): OAuthProfile => ({
  provider: method, providerSub: userId, email, emailVerified: true,
});

/** Sign-in posts carry no session, so `crossSiteRejection` passes them. */
function fromThisSite(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}

const clientAddress = (request: Request): string => request.headers.get('cf-connecting-ip') ?? 'unknown';

const EmailSchema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.regex(/^[^\s@]+@[^\s@]+$/u, 'Enter an email address.'));

const PasswordSchema = v.pipe(v.string(), v.minLength(10, 'Use a password of at least 10 characters.'), v.maxLength(512));

const ReturnToSchema = v.optional(v.string(), '/');

const InviteSchema = v.optional(v.nullable(v.string()), null);

const inviteHashOf = async (invite: string | null): Promise<string | null> => (invite === null || invite === '' ? null : sha256Hex(invite));

async function body<Schema extends v.GenericSchema>(request: Request, schema: Schema): Promise<v.SafeParseResult<Schema>> {
  return v.safeParse(schema, await tolerateAsync(() => request.json(), 'malformed-input'));
}

const misread = (issues: readonly v.BaseIssue<unknown>[]): Response => refuse(issues[0]?.message ?? 'The request was not understood.');

const SPENT = 'This sign-in request was already used or has expired. Start again.';

type BuiltinEnv = FamilyEnv<BuiltinAuthEnv<unknown>, object>;

export const builtinAuthRoutes = new Hono<BuiltinEnv>();

builtinAuthRoutes.use('/api/auth/builtin/*', async (c, next) => {
  if (!builtinAuthEnabled(c.env)) return refuse('This deployment signs in with OAuth.', 404);

  if (c.req.method === 'POST' && !fromThisSite(c.req.raw)) return refuse('Cross-site request rejected', 403);

  await next();
});

builtinAuthRoutes.post('/api/auth/builtin/password/register', async (c) => {
  const parsed = await body(c.req.raw, v.object({ email: EmailSchema, password: PasswordSchema, invite: InviteSchema, returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const userId = await deriveUserId(input.email);
  const caller = await ownerCaller(c.env);
  const store = accounts(c.env);
  const inviteHash = await inviteHashOf(input.invite);

  // Before the hash is paid for; `builtinRegister` decides again, atomically.
  const admissible = await store.builtinAdmissible(caller, input.email, inviteHash);

  if (!admissible.admitted) return refuse(admissible.reason, 403);
  const admission = await store.builtinRegister(caller, { userId, email: input.email, inviteHash, password: await hashPassword(input.password) });

  if (!admission.admitted) return refuse(admission.reason, 403);

  return signedIn(c.env, builtinProfile('password', userId, input.email), input.returnTo);
});

builtinAuthRoutes.post('/api/auth/builtin/password/sign-in', async (c) => {
  const parsed = await body(c.req.raw, v.object({ email: EmailSchema, password: v.pipe(v.string(), v.maxLength(512)), returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const address = clientAddress(c.req.raw);
  const wait = await waitBeforeAttempt(c.env, input.email, address);

  if (wait > 0) return throttled(wait);
  const account = await accounts(c.env).builtinPasswordAccount(await ownerCaller(c.env), input.email);
  // An unknown email costs the same hash: timing does not say which emails exist.
  const presented = await derive(input.password, account?.salt ?? 'no-such-account', account?.iterations ?? PASSWORD_ITERATIONS);

  if (account === null || !timingSafeEqual(presented, account.hash)) {
    await recordFailure(c.env, input.email, address);

    return refuse('That email and password do not match an account.', 401);
  }

  await clearFailures(c.env, input.email);

  return signedIn(c.env, builtinProfile('password', account.userId, account.email), input.returnTo);
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/register/options', async (c) => {
  const parsed = await body(c.req.raw, v.object({ email: EmailSchema, invite: InviteSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const caller = await ownerCaller(c.env);
  const store = accounts(c.env);
  const inviteHash = await inviteHashOf(input.invite);
  const admissible = await store.builtinAdmissible(caller, input.email, inviteHash);

  if (!admissible.admitted) return refuse(admissible.reason, 403);
  const userId = await deriveUserId(input.email);
  const url = new URL(c.req.url);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: url.hostname, userName: input.email, userID: new TextEncoder().encode(userId),
    attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });

  await store.builtinIssueChallenge(caller, options.challenge, { purpose: 'register', userId, email: input.email, inviteHash }, Date.now() + CHALLENGE_TTL_MS);

  return json({ body: options });
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/register', async (c) => {
  const parsed = await body(c.req.raw, v.object({ response: AttestationSchema, returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const caller = await ownerCaller(c.env);
  const store = accounts(c.env);
  const pending = await spend(c.env, input.response.response.clientDataJSON, 'register');

  if (pending === null || pending.userId === null || pending.email === null) return refuse(SPENT, 403);
  const url = new URL(c.req.url);

  const verified = await verifyNewPasskey(input.response, { origin: url.origin, rpID: url.hostname });

  if (verified instanceof Response) return verified;

  if (!verified.verified) return refuse('The passkey could not be verified. Try again.', 403);
  const { credential } = verified.registrationInfo;

  const admission = await store.builtinRegister(caller, {
    userId: pending.userId, email: pending.email, inviteHash: pending.inviteHash,
    passkey: { credentialId: credential.id, publicKey: base64Url(credential.publicKey), counter: credential.counter, transports: credential.transports ?? [] },
  });

  if (!admission.admitted) return refuse(admission.reason, 403);

  return signedIn(c.env, builtinProfile('passkey', pending.userId, pending.email), input.returnTo);
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/sign-in/options', async (c) => {
  const options = await generateAuthenticationOptions({ rpID: new URL(c.req.url).hostname, userVerification: 'required' });

  await accounts(c.env).builtinIssueChallenge(
    await ownerCaller(c.env), options.challenge, { purpose: 'authenticate', userId: null, email: null, inviteHash: null }, Date.now() + CHALLENGE_TTL_MS,
  );

  return json({ body: options });
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/sign-in', async (c) => {
  const parsed = await body(c.req.raw, v.object({ response: AssertionSchema, returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const address = clientAddress(c.req.raw);
  const wait = await waitBeforeAttempt(c.env, input.response.id, address);

  if (wait > 0) return throttled(wait);

  if (await spend(c.env, input.response.response.clientDataJSON, 'authenticate') === null) return refuse(SPENT, 403);
  const caller = await ownerCaller(c.env);
  const store = accounts(c.env);
  const passkey = await store.builtinPasskeyAccount(caller, input.response.id);
  const url = new URL(c.req.url);

  if (passkey === null) {
    await recordFailure(c.env, input.response.id, address);

    return refuse('That passkey is not registered here.', 401);
  }

  const verified = await verifyPasskeyAnswer(input.response, passkey, { origin: url.origin, rpID: url.hostname });

  if (verified instanceof Response || !verified.verified) {
    await recordFailure(c.env, input.response.id, address);

    return verified instanceof Response ? verified : refuse('That passkey could not be verified.', 401);
  }

  await store.builtinRecordPasskeyUse(caller, passkey.credentialId, verified.authenticationInfo.newCounter);

  return signedIn(c.env, builtinProfile('passkey', passkey.userId, passkey.email), input.returnTo);
});

async function spend<Id>(env: BuiltinAuthEnv<Id>, clientDataJSON: string, purpose: ChallengePurpose) {
  const challenge = answeredChallenge(clientDataJSON);

  return challenge === null ? null : accounts(env).builtinSpendChallenge(await ownerCaller(env), challenge, purpose);
}

type SettingsEnv = FamilyEnv<BuiltinAuthEnv<unknown>, ApiVariables>;

export const builtinAccountRoutes = new Hono<SettingsEnv>();

builtinAccountRoutes.get('/api/user/builtin-auth', async (c) => {
  if (!builtinAuthEnabled(c.env)) return json({ body: { enabled: false, owner: false } });
  const owner = await accounts(c.env).builtinIsOwner(await ownerCaller(c.env), c.get('identity').userId);

  return json({ body: { enabled: true, owner } });
});

builtinAccountRoutes.post('/api/user/builtin-auth/invites', async (c) => {
  if (!builtinAuthEnabled(c.env)) return refuse('This deployment signs in with OAuth.', 404);
  const token = randomToken(32);
  const expiresAt = Date.now() + INVITE_TTL_MS;

  const created = await accounts(c.env).builtinCreateInvite(
    await ownerCaller(c.env), { ownerUserId: c.get('identity').userId, tokenHash: await sha256Hex(token), expiresAt },
  );

  if (!created) return refuse('Only the owner of this deployment can invite people.', 403);
  const url = new URL('/login', c.req.url);

  url.searchParams.set('invite', token);

  return json({ body: { url: url.toString(), expiresAt } });
});
