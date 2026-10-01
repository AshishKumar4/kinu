/**
 * Built-in sign-in where no OAuth app is configured: password or passkey. The first account is the owner; later
 * ones need its invite. A success mints the OAuth callback's session (`createSession`).
 */
import { Hono, type Context } from 'hono';
import { generateAuthenticationOptions, generateRegistrationOptions } from '@simplewebauthn/server';
import { AssertionSchema, AttestationSchema, answeredChallenge, verifyNewPasskey, verifyPasskeyAnswer } from './passkeys';
import { base64Url, hmacSha256Hex, json, ownerCaller, randomToken, sha256Hex, timingSafeEqual } from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { SESSION_COOKIE_NAME, setCookie } from './session';
import { createSession, deriveBuiltinUserId, sanitizeReturnTo, type OAuthProfile } from './store';
import { builtinSignInOn } from '@kinu.run/core/identity';
import type { AuthRoutesAuthority, AuthRoutesEnv } from './routes';
import {
  BUILTIN_ACCOUNTS_OBJECT, NOT_ADMITTED, OWNER_RESET, type AttemptBucket, type ChallengePurpose, type InvitePurpose, type PasswordAccount, type PasswordHash, type Reset,
} from '@kinu.run/core/identity';
import type { UserDO } from '../user/user-do';
import type { ApiVariables, FamilyEnv } from '../api/context';
import type { ObjectNamespace } from '@kinu.run/core';

export type BuiltinAuthority = AuthRoutesAuthority & Pick<UserDO,
  | 'builtinAdmissible' | 'builtinCreateInvite' | 'builtinInvitedEmail' | 'builtinIsOwner' | 'builtinIssueChallenge' | 'builtinPasskeyAccount'
  | 'builtinPasswordAccount' | 'builtinRecordPasskeyUse' | 'builtinRegister' | 'builtinSpendChallenge'
  | 'builtinReserveAttempt' | 'builtinClearAttempts' | 'builtinReplacePassword'
  | 'builtinResetAccount' | 'builtinApplyReset' | 'builtinListAccounts' | 'builtinOwnerAccount' | 'endAllSessions'>;

export interface BuiltinAuthEnv<Id = DurableObjectId> extends Omit<AuthRoutesEnv<Id>, 'UserDO'> {
  UserDO: ObjectNamespace<Id, BuiltinAuthority>;
  KINU_SETUP_TOKEN?: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
}

const PASSWORD_ITERATIONS = 100_000;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const RP_NAME = 'Kinu';

export function builtinAccounts<Id, Authority>(env: { UserDO: ObjectNamespace<Id, Authority> }): Authority {
  return env.UserDO.get(env.UserDO.idFromName(BUILTIN_ACCOUNTS_OBJECT));
}

const accounts = <Id>(env: BuiltinAuthEnv<Id>): BuiltinAuthority => builtinAccounts(env);

export async function setupProven(env: { KINU_SETUP_TOKEN?: string }, presented: string | null): Promise<boolean> {
  const secret = (env.KINU_SETUP_TOKEN ?? '').trim();

  if (secret === '' || presented === null) return false;

  return timingSafeEqual(await sha256Hex(presented), await sha256Hex(secret));
}

const pepper = (root: string): Promise<string> => hmacSha256Hex(root, 'kinu.builtin-password-pepper.v1');

async function derive(password: string, salt: string, root: string): Promise<string> {
  const peppered = await hmacSha256Hex(await pepper(root), password);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(peppered), 'PBKDF2', false, ['deriveBits']);

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PASSWORD_ITERATIONS }, key, 256,
  );

  return base64Url(new Uint8Array(bits));
}


async function hashPassword(root: string, password: string): Promise<PasswordHash> {
  const salt = randomToken(16);

  return { hash: await derive(password, salt, root), salt, iterations: PASSWORD_ITERATIONS };
}

async function passwordMatches<Id>(env: BuiltinAuthEnv<Id>, root: string, password: string, stored: PasswordAccount | null): Promise<boolean> {
  // Unknown emails cost the same hash.
  const current = await derive(password, stored?.salt ?? 'no-such-account', root);

  if (stored === null) return false;

  if (timingSafeEqual(current, stored.hash)) return true;
  const previous = (env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((key) => key.trim()).filter((key) => key !== '');

  for (const key of previous) {
    if (!timingSafeEqual(await derive(password, stored.salt, key), stored.hash)) continue;
    await accounts(env).builtinReplacePassword(await ownerCaller(env), stored.userId, await hashPassword(root, password));

    return true;
  }

  return false;
}

function addressKey(request: Request): string {
  const address = (request.headers.get('cf-connecting-ip') ?? '').trim();

  if (address === '') return 'no-address';

  if (!address.includes(':')) return address;
  const [head = '', tail = ''] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = address.includes('::') ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;

  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/u, '')).join(':')}::/64`;
}

const buckets = {
  passwordEmail: (email: string): AttemptBucket => ({ key: `password-email:${email}`, free: 5 }),
  passwordAddress: (address: string): AttemptBucket => ({ key: `password-address:${address}`, free: 20 }),
  passkey: (address: string): AttemptBucket => ({ key: `passkey-address:${address}`, free: 20 }),
  register: (address: string): AttemptBucket => ({ key: `register-address:${address}`, free: 10 }),
  challenge: (address: string): AttemptBucket => ({ key: `challenge-address:${address}`, free: 30 }),
};

const refuse = (message: string, status = 400, headers: HeadersInit = {}): Response => json({ body: { error: message } }, { status, headers });

async function reserve<Id>(env: BuiltinAuthEnv<Id>, attempt: readonly AttemptBucket[]): Promise<Response | null> {
  const wait = await accounts(env).builtinReserveAttempt(await ownerCaller(env), attempt);

  if (wait === 0) return null;
  const seconds = String(Math.ceil(wait / 1000));

  return refuse(`Too many attempts. Try again in ${seconds} s.`, 429, { 'retry-after': seconds });
}

async function signedIn<Id>(env: BuiltinAuthEnv<Id>, request: Request, profile: OAuthProfile, returnTo: string): Promise<Response> {
  const session = await createSession(env, profile);
  const headers = new Headers({ 'cache-control': 'no-store' });

  headers.append('set-cookie', setCookie(SESSION_COOKIE_NAME, session.token, session.expiresAt - session.issuedAt));

  return json({ body: { returnTo: sanitizeReturnTo(returnTo, new URL(request.url).origin) } }, { headers });
}

const builtinProfile = (method: 'password' | 'passkey', userId: string, email: string): OAuthProfile => ({
  provider: method, providerSub: userId, email, emailVerified: false,
});

function fromThisSite(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}

const EmailSchema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.regex(/^[^\s@]+@[^\s@]+$/u, 'Enter an email address.'));

const PasswordSchema = v.pipe(v.string(), v.minLength(10, 'Use a password of at least 10 characters.'), v.maxLength(512));

const ReturnToSchema = v.optional(v.string(), '/');

const TokenSchema = v.optional(v.nullable(v.string()), null);

const inviteHashOf = async (invite: string | null): Promise<string | null> => (invite === null || invite === '' ? null : sha256Hex(invite));

async function body<Schema extends v.GenericSchema>(request: Request, schema: Schema): Promise<v.SafeParseResult<Schema>> {
  return v.safeParse(schema, await tolerateAsync(() => request.json(), 'malformed-input'));
}

const misread = (issues: readonly v.BaseIssue<unknown>[]): Response => refuse(issues[0]?.message ?? 'The request was not understood.');

const NO_ROOT_SECRET = 'This deployment has no CREDENTIAL_ENCRYPTION_KEY, so password sign-in is unavailable.';

const RESET_SPENT = 'This reset link was already used or has expired. Ask the owner for a new one.';

const SPENT = 'This sign-in request was already used or has expired. Start again.';

type BuiltinEnv = FamilyEnv<BuiltinAuthEnv<unknown>, object>;

export const builtinAuthRoutes = new Hono<BuiltinEnv>();

builtinAuthRoutes.use('/api/auth/builtin/*', async (c, next) => {
  if (!builtinSignInOn(c.env)) return refuse('This deployment does not offer built-in sign-in.', 404);

  if (c.req.method === 'POST' && !fromThisSite(c.req.raw)) return refuse('Cross-site request rejected', 403);

  await next();
});

const RegisterSchema = v.object({ email: EmailSchema, invite: TokenSchema, setup: TokenSchema });

async function admitted<Id>(env: BuiltinAuthEnv<Id>, request: Request, input: v.InferOutput<typeof RegisterSchema>) {
  const limited = await reserve(env, [buckets.register(addressKey(request))]);

  if (limited) return limited;
  const request_ = { email: input.email, inviteHash: await inviteHashOf(input.invite), setupProven: await setupProven(env, input.setup) };
  const admission = await accounts(env).builtinAdmissible(await ownerCaller(env), request_);

  return admission.admitted ? request_ : refuse(admission.reason, 403);
}

builtinAuthRoutes.post('/api/auth/builtin/password/register', async (c) => {
  const parsed = await body(c.req.raw, v.object({ ...RegisterSchema.entries, password: PasswordSchema, returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const request = await admitted(c.env, c.req.raw, input);

  if (request instanceof Response) return request;
  const root = c.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!root) return refuse(NO_ROOT_SECRET, 503);
  const userId = await deriveBuiltinUserId(input.email);

  const admission = await accounts(c.env).builtinRegister(
    await ownerCaller(c.env), { ...request, userId, password: await hashPassword(root, input.password) },
  );

  if (!admission.admitted) return refuse(admission.reason, 403);
  await accounts(c.env).builtinClearAttempts(await ownerCaller(c.env), [buckets.register(addressKey(c.req.raw)).key]);

  return signedIn(c.env, c.req.raw, builtinProfile('password', userId, input.email), input.returnTo);
});

builtinAuthRoutes.post('/api/auth/builtin/password/sign-in', async (c) => {
  const parsed = await body(c.req.raw, v.object({ email: EmailSchema, password: v.pipe(v.string(), v.maxLength(512)), returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const address = addressKey(c.req.raw);
  const attempt = [buckets.passwordEmail(input.email), buckets.passwordAddress(address)];
  const limited = await reserve(c.env, attempt);

  if (limited) return limited;
  const root = c.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!root) return refuse(NO_ROOT_SECRET, 503);
  const caller = await ownerCaller(c.env);
  const account = await accounts(c.env).builtinPasswordAccount(caller, input.email);

  if (account === null || !await passwordMatches(c.env, root, input.password, account)) return refuse('That email and password do not match an account.', 401);
  await accounts(c.env).builtinClearAttempts(caller, attempt.map((bucket) => bucket.key));

  return signedIn(c.env, c.req.raw, builtinProfile('password', account.userId, account.email), input.returnTo);
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/register/options', async (c) => {
  const parsed = await body(c.req.raw, RegisterSchema);

  if (!parsed.success) return misread(parsed.issues);
  const limited = await reserve(c.env, [buckets.challenge(addressKey(c.req.raw))]);

  if (limited) return limited;
  const request = await admitted(c.env, c.req.raw, parsed.output);

  if (request instanceof Response) return request;
  const userId = await deriveBuiltinUserId(request.email);
  const url = new URL(c.req.url);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: url.hostname, userName: request.email, userID: new TextEncoder().encode(userId),
    attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });

  await accounts(c.env).builtinIssueChallenge(
    await ownerCaller(c.env), options.challenge, { purpose: 'register', userId, resetHash: null, ...request }, Date.now() + CHALLENGE_TTL_MS,
  );

  return json({ body: options });
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/register', async (c) => {
  const parsed = await body(c.req.raw, v.object({ response: AttestationSchema, returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const caller = await ownerCaller(c.env);
  const pending = await spend(c.env, input.response.response.clientDataJSON, 'register');

  if (pending === null || pending.userId === null || pending.email === null) return refuse(SPENT, 403);
  const url = new URL(c.req.url);
  const verified = await verifyNewPasskey(input.response, { origin: url.origin, rpID: url.hostname });

  if (verified instanceof Response) return verified;

  if (!verified.verified) return refuse('The passkey could not be verified. Try again.', 403);
  const { credential } = verified.registrationInfo;
  const passkey = { credentialId: credential.id, publicKey: base64Url(credential.publicKey), counter: credential.counter, transports: credential.transports ?? [] };

  if (pending.resetHash !== null) return resetTo(c.env, c.req.raw, { resetHash: pending.resetHash, passkey }, input.returnTo);

  const admission = await accounts(c.env).builtinRegister(caller, {
    userId: pending.userId, email: pending.email, inviteHash: pending.inviteHash, setupProven: pending.setupProven, passkey,
  });

  if (!admission.admitted) return refuse(admission.reason, 403);

  return signedIn(c.env, c.req.raw, builtinProfile('passkey', pending.userId, pending.email), input.returnTo);
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/sign-in/options', async (c) => {
  const limited = await reserve(c.env, [buckets.challenge(addressKey(c.req.raw))]);

  if (limited) return limited;
  const options = await generateAuthenticationOptions({ rpID: new URL(c.req.url).hostname, userVerification: 'required' });

  await accounts(c.env).builtinIssueChallenge(
    await ownerCaller(c.env), options.challenge,
    { purpose: 'authenticate', userId: null, email: null, inviteHash: null, setupProven: false, resetHash: null }, Date.now() + CHALLENGE_TTL_MS,
  );

  return json({ body: options });
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/sign-in', async (c) => {
  const parsed = await body(c.req.raw, v.object({ response: AssertionSchema, returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const input = parsed.output;
  const attempt = [buckets.passkey(addressKey(c.req.raw))];
  const limited = await reserve(c.env, attempt);

  if (limited) return limited;

  if (await spend(c.env, input.response.response.clientDataJSON, 'authenticate') === null) return refuse(SPENT, 403);
  const caller = await ownerCaller(c.env);
  const store = accounts(c.env);
  const passkey = await store.builtinPasskeyAccount(caller, input.response.id);

  if (passkey === null) return refuse('That passkey is not registered here.', 401);
  const url = new URL(c.req.url);
  const verified = await verifyPasskeyAnswer(input.response, passkey, { origin: url.origin, rpID: url.hostname });

  if (verified instanceof Response) return verified;

  if (!verified.verified) return refuse('That passkey could not be verified.', 401);
  await store.builtinRecordPasskeyUse(caller, passkey.credentialId, verified.authenticationInfo.newCounter);
  await store.builtinClearAttempts(caller, attempt.map((bucket) => bucket.key));

  return signedIn(c.env, c.req.raw, builtinProfile('passkey', passkey.userId, passkey.email), input.returnTo);
});

async function resetTo<Id>(env: BuiltinAuthEnv<Id>, request: Request, reset: Reset, returnTo: string): Promise<Response> {
  const caller = await ownerCaller(env);
  const account = await accounts(env).builtinApplyReset(caller, reset);

  if (account === null) return refuse(RESET_SPENT, 403);
  await env.UserDO.get(env.UserDO.idFromName(account.userId)).endAllSessions(caller);

  return signedIn(env, request, builtinProfile(reset.passkey ? 'passkey' : 'password', account.userId, account.email), returnTo);
}

async function resetHashOf<Id>(env: BuiltinAuthEnv<Id>, reset: string | null, setup: string | null): Promise<string | null> {
  if (reset !== null && reset !== '') return sha256Hex(reset);

  return await setupProven(env, setup) ? OWNER_RESET : null;
}

const ResetSchema = { reset: TokenSchema, setup: TokenSchema };

builtinAuthRoutes.post('/api/auth/builtin/password/reset', async (c) => {
  const parsed = await body(c.req.raw, v.object({ ...ResetSchema, password: PasswordSchema, returnTo: ReturnToSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const limited = await reserve(c.env, [buckets.register(addressKey(c.req.raw))]);

  if (limited) return limited;
  const root = c.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!root) return refuse(NO_ROOT_SECRET, 503);
  const resetHash = await resetHashOf(c.env, parsed.output.reset, parsed.output.setup);

  if (resetHash === null) return refuse(RESET_SPENT, 403);

  return resetTo(c.env, c.req.raw, { resetHash, password: await hashPassword(root, parsed.output.password) }, parsed.output.returnTo);
});

builtinAuthRoutes.post('/api/auth/builtin/passkey/reset/options', async (c) => {
  const parsed = await body(c.req.raw, v.object(ResetSchema));

  if (!parsed.success) return misread(parsed.issues);
  const limited = await reserve(c.env, [buckets.challenge(addressKey(c.req.raw)), buckets.register(addressKey(c.req.raw))]);

  if (limited) return limited;
  const caller = await ownerCaller(c.env);
  const resetHash = await resetHashOf(c.env, parsed.output.reset, parsed.output.setup);

  if (resetHash === null) return refuse(RESET_SPENT, 403);
  const store = accounts(c.env);
  const account = resetHash === OWNER_RESET ? await store.builtinOwnerAccount(caller) : await store.builtinResetAccount(caller, resetHash);

  if (account === null) return refuse(RESET_SPENT, 403);
  const url = new URL(c.req.url);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: url.hostname, userName: account.email, userID: new TextEncoder().encode(account.userId),
    attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });

  await accounts(c.env).builtinIssueChallenge(caller, options.challenge, {
    purpose: 'register', userId: account.userId, email: account.email, inviteHash: null, setupProven: false, resetHash,
  }, Date.now() + CHALLENGE_TTL_MS);

  return json({ body: options });
});

async function spend<Id>(env: BuiltinAuthEnv<Id>, clientDataJSON: string, purpose: ChallengePurpose) {
  const challenge = answeredChallenge(clientDataJSON);

  return challenge === null ? null : accounts(env).builtinSpendChallenge(await ownerCaller(env), challenge, purpose);
}

type SettingsEnv = FamilyEnv<BuiltinAuthEnv<unknown>, ApiVariables>;

export const builtinAccountRoutes = new Hono<SettingsEnv>();

builtinAccountRoutes.get('/api/user/builtin-auth', async (c) => {
  if (!builtinSignInOn(c.env)) return json({ body: { enabled: false, owner: false } });
  const owner = await accounts(c.env).builtinIsOwner(await ownerCaller(c.env), c.get('identity').userId);

  return json({ body: { enabled: true, owner } });
});

/** An owner's link: `join` for an address without an account (`?invite=`), `reset` for one with (`?reset=`). */
async function ownerLink(c: Context<SettingsEnv>, purpose: InvitePurpose): Promise<Response> {
  if (!builtinSignInOn(c.env)) return refuse('This deployment does not offer built-in sign-in.', 404);
  const parsed = await body(c.req.raw, v.object({ email: EmailSchema }));

  if (!parsed.success) return misread(parsed.issues);
  const token = randomToken(32);
  const expiresAt = Date.now() + INVITE_TTL_MS;

  const created = await accounts(c.env).builtinCreateInvite(await ownerCaller(c.env), {
    ownerUserId: c.get('identity').userId, purpose, email: parsed.output.email, tokenHash: await sha256Hex(token), expiresAt,
  });

  if (!created) return refuse('Only the owner makes these links: an invite for an address without an account, a reset for one with.', 403);
  const url = new URL('/login', c.req.url);

  url.searchParams.set(purpose === 'join' ? 'invite' : 'reset', token);

  return json({ body: { url: url.toString(), email: parsed.output.email, expiresAt } });
}

builtinAccountRoutes.post('/api/user/builtin-auth/invites', async (c) => ownerLink(c, 'join'));

builtinAccountRoutes.post('/api/user/builtin-auth/resets', async (c) => ownerLink(c, 'reset'));

export { NOT_ADMITTED };


builtinAccountRoutes.get('/api/user/builtin-auth/accounts', async (c) => {
  if (!builtinSignInOn(c.env)) return refuse('This deployment does not offer built-in sign-in.', 404);
  const caller = await ownerCaller(c.env);

  if (!await accounts(c.env).builtinIsOwner(caller, c.get('identity').userId)) return refuse('Only the owner of this deployment sees its accounts.', 403);

  return json({ body: { accounts: await accounts(c.env).builtinListAccounts(caller) } });
});

