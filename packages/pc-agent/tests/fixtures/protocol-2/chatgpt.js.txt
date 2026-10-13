// Sign in with ChatGPT for open-source clients (https://developers.openai.com/siwc/token-sharing-open-source,
// read 2026-09-30): the sign-in, the rotating refresh and the revocation, on the user's own machine.
//
// One implementation for the two processes on a machine that may hold the token: the daemon requires this file
// as a sibling, and the CLI imports it. An account's own sign-in, held by Kinu's servers, is core's
// providers/chatgpt-sign-in.ts.
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const http = require('node:http');

const crypto = require('node:crypto');

// BEGIN GENERATED from packages/core/src/providers/chatgpt-protocol.ts by `bun scripts/daemon-generated.ts`. Do not edit.

// Sign in with ChatGPT's token protocol (developers.openai.com/siwc, 2026-09-30) for the machine's sign-in
// (pc-agent/src/chatgpt.js, generated) and a deployment's (chatgpt-sign-in.ts); I/O and errors are each side's.

const ISSUER = 'https://auth.openai.com';

const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;

const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;

const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;

const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

const RESOURCE = 'https://api.openai.com/v1';

/** Lets the tokens pay for inference with the owner's plan. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];

const DYNAMIC_AGENT_CLIENT = 'dynamic_agent_client';

const AGENT_NAME_HINT = 'Kinu';

/** Refresh this long before the hour-long access token ends. */
const REFRESH_LEAD_MS = 5 * 60_000;

/** As OpenAI's own verification example sets it. */
const CLOCK_SKEW_SEC = 5;

/** Refresh refusals that end the renewable session. */
const SPENT_REFRESH_CODES = [
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
];

function tokenRefusal(status, answer, doing) {
  const code = answer.error ?? null;
  const detail = answer.errorDescription === undefined ? '' : `: ${answer.errorDescription}`;

  return { code, message: `auth.openai.com refused ${doing} (HTTP ${String(status)}${code === null ? '' : ` ${code}`})${detail}` };
}

/** RFC 6749 §5.1: no `scope` granted what was asked, or on refresh what the grant held. */
function scopesOf(scope, whenAbsent) {
  return (scope === undefined ? [...whenAbsent] : scope.split(' ').filter((entry) => entry !== '')).sort((left, right) => (left < right ? -1 : 1));
}

function grantsPlan(scopes) {
  return scopes !== undefined && scopes.includes(PLAN_SCOPE);
}

function expiring(held, now) {
  return held?.accessToken === undefined || held.expiresAt === undefined || now + REFRESH_LEAD_MS >= held.expiresAt;
}

/** No access token renews nothing; the refresh token sent stays when none came back. */
function refreshedTokens(answer, held, now) {
  if (answer.accessToken === undefined) return { problem: 'auth.openai.com renewed the ChatGPT sign-in without an access token' };

  return {
    accessToken: answer.accessToken,
    refreshToken: answer.refreshToken ?? held.refreshToken,
    ...(answer.expiresIn !== undefined && { expiresAt: now + answer.expiresIn * 1000 }),
    scopes: scopesOf(answer.scope, held.scopes),
  };
}

function signedInTokens(answer, now) {
  if (answer.accessToken === undefined || answer.refreshToken === undefined) {
    return { problem: 'auth.openai.com answered the sign-in without an access and a refresh token' };
  }

  return {
    accessToken: answer.accessToken,
    refreshToken: answer.refreshToken,
    ...(answer.expiresIn !== undefined && { expiresAt: now + answer.expiresIn * 1000 }),
    scopes: scopesOf(answer.scope, SCOPES),
  };
}

/** Without a registration the sign-in registers Kinu. */
function authorizeUrl(input

) {
  const { registration } = input;
  const loginHint = registration?.email ?? null;

  const params = new URLSearchParams({
    client_id: registration?.clientId ?? DYNAMIC_AGENT_CLIENT,
    ...(registration === null && { agent_name_hint: AGENT_NAME_HINT }),
    ext_agent_host_id: input.hostId,
    ...(loginHint !== null && { login_hint: loginHint }),
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: 'S256',
    code_challenge: input.challenge,
    ...(input.consent && { prompt: 'consent' }),
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** `audience` is `aud` as a list. */

function idTokenKeyId(token) {
  return token.algorithm !== 'RS256' || token.keyId === undefined
    ? { problem: `the ID token is signed with ${String(token.algorithm)}, not RS256` }
    : { keyId: token.keyId };
}

function idTokenSignatureVerifies(key, signed, signature) {
  const padded = signature.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0));

  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes, new TextEncoder().encode(signed));
}

function idTokenIdentity(token, expected) {
  const { subject } = token;

  const problem = ([
    [token.issuer !== ISSUER, `the ID token was issued by ${String(token.issuer)}, not ${ISSUER}`],
    [!token.audience.includes(expected.clientId), 'the ID token was issued to another client'],
    [token.expires === undefined || token.expires + CLOCK_SKEW_SEC < expected.now / 1000, 'the ID token has expired'],
    [token.nonce !== expected.nonce, 'the ID token does not answer this sign-in (nonce mismatch)'],
  ]).find(([failed]) => failed)?.[1];

  if (problem !== undefined) return { problem };

  return subject === undefined || subject === '' ? { problem: 'the ID token names no subject' } : { subject, email: token.email ?? null };
}

// END GENERATED

/** Only the port of the loopback redirect may vary between sign-ins. */
const CALLBACK_PATH = '/auth/callback';


/** This machine's `ext_agent_host_id`, shared by the CLI and the daemon: one host per machine. */
const HOST_ID_FILE = 'chatgpt-host-id';

/** The daemon's own sign-in; the CLI keeps its own in config.json. */
const DEVICE_RECORD_FILE = 'pc-agent.chatgpt.json';

/** A refusal from auth.openai.com, with its OAuth error code when it sent one. */
class SiwcError extends Error {
  constructor(message, { code = null, unusable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SiwcError';
    this.code = code;
    this.unusable = unusable;
  }
}

/** The string a decoded JSON value holds, or undefined: read, never coerced. */
function stringOf(value) {
  return value !== undefined && value !== null && String(value) === value ? value : undefined;
}

/** The finite number a decoded JSON value holds, or undefined. */
function numberOf(value) {
  return Number.isFinite(value) ? value : undefined;
}

function stringsOf(value) {
  return Array.isArray(value) ? value.flatMap((entry) => stringOf(entry) ?? []) : [];
}

/** The chain only orders its steps; each step's own promise carries its outcome to its caller. */
function noop() {}

function messageOf(err) {
  return stringOf(err?.message) ?? String(err);
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function randomToken(bytes) {
  return base64url(crypto.randomBytes(bytes));
}

/** This machine's host id, created once: a UUIDv4 URN, opaque and never user-identifying. */
function hostId(home) {
  const file = path.join(home, HOST_ID_FILE);
  const existing = readText(file);

  if (existing !== null) return existing;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `urn:uuid:${crypto.randomUUID()}\n`, { mode: 0o600, flag: 'wx' });

  try {
    // A link creates the name only when absent, so two first runs agree on the winner's id.
    fs.linkSync(temporary, file);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(temporary, { force: true });
  }

  return readText(file) ?? '';
}

function readText(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();

    return text === '' ? null : text;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function planEnabled(record) {
  return grantsPlan(record?.scopes);
}

/** The token endpoint's answer, decoded (token-reference, 2026-09-30). */
function tokenAnswerOf(body) {
  return {
    accessToken: stringOf(body?.access_token),
    refreshToken: stringOf(body?.refresh_token),
    idToken: stringOf(body?.id_token),
    expiresIn: numberOf(body?.expires_in),
    scope: stringOf(body?.scope),
    error: stringOf(body?.error),
    errorDescription: stringOf(body?.error_description),
  };
}

async function tokenCall(fetchImpl, fields, doing) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });

  const answer = tokenAnswerOf(parseJson(await res.text()));

  if (!res.ok) {
    const { code, message } = tokenRefusal(res.status, answer, doing);

    throw new SiwcError(message, { code, unusable: fields.grant_type === 'refresh_token' && code !== null && SPENT_REFRESH_CODES.includes(code) });
  }

  return answer;
}

/** One rotation: the replacement refresh token supersedes the one sent. */
async function refreshTokens({ clientId, refreshToken, scopes = [], fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  // `scope` stays out so the grant keeps what it had.
  const answer = await tokenCall(fetchImpl, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE }, 'the refresh');
  const tokens = refreshedTokens(answer, { refreshToken, scopes }, now());

  if ('problem' in tokens) throw new SiwcError(tokens.problem);

  return tokens;
}

/**
 * Ends the renewable session; an empty 200 is success, including for an already-dead token. Resolves
 * either way: `unconfirmed` says why OpenAI did not confirm it, for the owner to finish in ChatGPT's
 * settings, since the tokens are forgotten regardless.
 */
async function revokeSession({ clientId, refreshToken, fetch: fetchImpl = globalThis.fetch }) {
  try {
    const res = await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
    });

    return { unconfirmed: res.ok ? null : `auth.openai.com answered HTTP ${res.status}` };
  } catch (err) {
    return { unconfirmed: `auth.openai.com could not be reached: ${messageOf(err)}` };
  }
}

const signingKeys = new Map();

async function signingKey(kid, fetchImpl) {
  if (!signingKeys.has(kid)) {
    const res = await fetchImpl(JWKS_URL, { headers: { accept: 'application/json' } });

    if (!res.ok) throw new SiwcError(`auth.openai.com's signing keys could not be read (HTTP ${res.status})`);

    const published = parseJson(await res.text());

    for (const jwk of Array.isArray(published?.keys) ? published.keys : []) {
      const id = stringOf(jwk?.kid);

      if (jwk?.kty !== 'RSA' || id === undefined) continue;
      signingKeys.set(id, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
  }

  const key = signingKeys.get(kid);

  if (key === undefined) throw new SiwcError(`the ID token names signing key ${kid}, which auth.openai.com does not publish`);

  return key;
}

function jwtPart(segment) {
  const decoded = parseJson(Buffer.from(segment ?? '', 'base64url').toString('utf8'));

  if (decoded === null) throw new SiwcError('the ID token is not a JWT');

  return decoded;
}

/** The ID token's header and claims, decoded for the protocol's checks. */
function idTokenOf(head, body) {
  const header = jwtPart(head);
  const claims = jwtPart(body);

  return {
    algorithm: stringOf(header.alg),
    keyId: stringOf(header.kid),
    issuer: stringOf(claims.iss),
    audience: Array.isArray(claims.aud) ? stringsOf(claims.aud) : [stringOf(claims.aud)].filter((entry) => entry !== undefined),
    expires: numberOf(claims.exp),
    nonce: stringOf(claims.nonce),
    subject: stringOf(claims.sub),
    email: stringOf(claims.email),
  };
}

/** The protocol's ID token checks, with its signing keys read here. */
async function verifyIdToken(idToken, { clientId, nonce, fetch: fetchImpl, now }) {
  const [head, body, signature] = idToken.split('.');
  const token = idTokenOf(head, body);
  const named = idTokenKeyId(token);

  if ('problem' in named) throw new SiwcError(named.problem);

  if (!await idTokenSignatureVerifies(await signingKey(named.keyId, fetchImpl), `${head}.${body}`, signature ?? '')) {
    throw new SiwcError('the ID token signature does not verify against auth.openai.com\'s keys');
  }

  const identity = idTokenIdentity(token, { clientId, nonce, now });

  if ('problem' in identity) throw new SiwcError(identity.problem);

  return identity;
}

function answerBrowser(res, status, text) {
  // `close`: a kept-alive browser socket would hold the CLI's process open after the sign-in.
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  res.end(text);
}

/**
 * Starts one sign-in: a loopback listener on 127.0.0.1 (any free port; the path never varies), fresh
 * state, nonce and PKCE, and the authorize URL to open. `registration` is the saved one for this
 * account, or null to register Kinu with `dynamic_agent_client`. `done` settles when the browser comes
 * back: `signed-in` (plan usage granted), `plan-disabled` (signed in without it; no tokens kept), or
 * `declined`; a callback that cannot be trusted rejects.
 *
 * The URL is shown to the owner and, on the web, crosses Kinu's servers, so it carries the saved email
 * as `login_hint` and never the ID token as `id_token_hint`.
 */
async function beginSignIn({
  home, registration = null, consent = false, fetch: fetchImpl = globalThis.fetch, now = Date.now, signal,
}) {
  const state = randomToken(32);
  const nonce = randomToken(32);
  const verifier = randomToken(64);
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const registering = registration === null;
  const clientId = registering ? DYNAMIC_AGENT_CLIENT : registration.clientId;
  const callback = Promise.withResolvers();
  let redirectUri = '';
  let answered = false;

  const finish = async (url) => {
    const problem = url.searchParams.get('error');

    if (problem === 'access_denied') return { outcome: 'declined' };

    if (problem !== null) throw new SiwcError(`the sign-in did not complete: ${problem}`);
    const code = url.searchParams.get('code');

    if (!code) throw new SiwcError('the sign-in came back without an authorization code');
    const returned = url.searchParams.get('client_id');

    if (registering && (returned === null || returned === DYNAMIC_AGENT_CLIENT)) {
      throw new SiwcError('the registration did not complete: ChatGPT returned no issued client ID');
    }

    if (!registering && returned !== null && returned !== clientId) {
      throw new SiwcError('the sign-in came back for a different client than this account\'s registration');
    }

    const issued = registering ? returned : clientId;

    const answer = await tokenCall(fetchImpl, {
      grant_type: 'authorization_code', client_id: issued, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE,
    }, 'the sign-in code');

    const at = now();

    if (answer.idToken === undefined) throw new SiwcError('auth.openai.com answered the sign-in without an ID token');
    const identity = await verifyIdToken(answer.idToken, { clientId: issued, nonce, fetch: fetchImpl, now: at });

    if (!registering && registration.subject !== undefined && registration.subject !== identity.subject) {
      throw new SiwcError('the browser signed in to a different ChatGPT account than the one this sign-in renews');
    }

    const signedIn = { issuer: ISSUER, subject: identity.subject, email: identity.email, clientId: issued };
    const scopes = scopesOf(answer.scope, SCOPES);

    // Retain the sign-in, not tokens that cannot pay for inference.
    if (!grantsPlan(scopes)) return { outcome: 'plan-disabled', registered: registering, record: { ...signedIn, scopes } };
    const tokens = signedInTokens(answer, at);

    if ('problem' in tokens) throw new SiwcError(tokens.problem);

    return { outcome: 'signed-in', registered: registering, record: { ...signedIn, ...tokens } };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Any page can reach a loopback port: only this attempt's own redirect is read.
    if (answered || url.pathname !== CALLBACK_PATH || url.searchParams.get('state') !== state) {
      answerBrowser(res, 404, 'This is not the ChatGPT sign-in Kinu started.');

      return;
    }

    answered = true;
    callback.resolve({ url, res });
  });

  // The browser's page waits for the exchange, so it says how the sign-in ended.
  const complete = async () => {
    const { url, res } = await callback.promise;

    try {
      const result = await finish(url);

      answerBrowser(res, 200, result.outcome === 'declined'
        ? 'You cancelled the sign-in. You can close this tab.'
        : 'Signed in with ChatGPT. You can close this tab and go back to Kinu.');

      return result;
    } catch (err) {
      answerBrowser(res, 400, `The sign-in did not complete: ${messageOf(err)}. Go back to Kinu to try again.`);
      throw err;
    } finally {
      server.close();
    }
  };

  const listening = Promise.withResolvers();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;

  signal?.addEventListener('abort', () => {
    server.close();
    callback.reject(new SiwcError('the sign-in was cancelled'));
  }, { once: true });

  const authorize = authorizeUrl({ registration, hostId: hostId(home), redirectUri, state, nonce, challenge, consent });

  return { authorizeUrl: authorize, redirectUri, done: complete() };
}

/** The saved registration a record carries, for a later sign-in to the same account. */
function registrationOf(record) {
  const clientId = stringOf(record?.clientId);

  if (clientId === undefined || clientId === DYNAMIC_AGENT_CLIENT) return null;
  const subject = stringOf(record.subject);
  const email = stringOf(record.email);

  return { clientId, ...(subject !== undefined && { subject }), ...(email !== undefined && { email }) };
}

/** The daemon's record as the file holds it, decoded; null when there is none. */
function readRecord(file) {
  const text = readText(file);

  if (text === null) return null;
  const json = parseJson(text);

  return {
    issuer: stringOf(json?.issuer) ?? ISSUER,
    subject: stringOf(json?.subject),
    email: stringOf(json?.email) ?? null,
    clientId: stringOf(json?.clientId),
    accessToken: stringOf(json?.accessToken),
    refreshToken: stringOf(json?.refreshToken),
    expiresAt: numberOf(json?.expiresAt),
    scopes: stringsOf(json?.scopes),
  };
}

function writeRecord(file, record) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

/** The CLI's main ChatGPT registration on this machine (`config.json`), so the daemon reuses its client. */
function cliRegistration(home) {
  const text = readText(path.join(home, 'config.json'));

  return text === null ? null : registrationOf(parseJson(text)?.providers?.chatgpt?.metadata);
}

/** The daemon's registration on this machine, so the CLI's first sign-in reuses its client. */
function deviceRegistration(home) {
  return registrationOf(readRecord(path.join(home, DEVICE_RECORD_FILE)));
}

/** What a signed-out record keeps (SIWC's sign-out): the account and client mapping, and no token of any kind. */
function signedOut(record) {
  const { issuer, subject, email, clientId } = record;

  return {
    issuer, ...(subject !== undefined && { subject }), ...(email !== null && email !== undefined && { email }), ...(clientId !== undefined && { clientId }),
  };
}

/** A sign-in whose grant left out plan usage: signed in, and asked for consent again next time. */
function planDeclined(record) {
  return record !== null && record.scopes.length > 0 && !planEnabled(record);
}

/**
 * The daemon's own ChatGPT sign-in. Every write of the record (a rotation, a sign-in landing, a sign-out) runs
 * on one chain, and each re-reads the record there, so none acts on a session another has replaced: a delayed
 * refresh cannot bring a signed-out session back, and a sign-out revokes the newest refresh token.
 *
 * No clock ends anything here. The chain starts when `predecessorExited` settles, the event of the daemon this
 * one replaced having exited, so an update's overlap submits no refresh token twice. A call to auth.openai.com
 * ends when its answer does, or when `abort` (a forced stop) ends it.
 */
function createDeviceSession({ home, fetch: baseFetch = globalThis.fetch, now = Date.now, predecessorExited = null }) {
  const file = path.join(home, DEVICE_RECORD_FILE);
  /** The sign-in waiting for the browser: its abort, whether it was cancelled, and its landing. */
  let signingIn = null;
  let refreshing = null;
  let lastFailure = null;
  let firstSignIn = false;
  /** Sign-outs under way; while any is, no call gets a token. */
  let signingOut = 0;
  /** Set by `quiesce` or `abort`: an update handoff or an exit is under way, and nothing new starts. */
  let closed = false;
  const closing = Promise.withResolvers();
  const stopping = new AbortController();
  const fetchImpl = (input, init) => baseFetch(input, { ...init, signal: stopping.signal });

  // A daemon stopping has nothing left to wait for its predecessor over.
  let chain = predecessorExited === null ? Promise.resolve() : Promise.race([predecessorExited, closing.promise]);

  const current = () => readRecord(file);

  /** Runs `step` after every write queued before it; the chain itself never rejects. */
  const serially = (step) => {
    const run = chain.then(step);
    chain = run.then(noop, noop);

    return run;
  };

  const admitting = () => !closed && signingOut === 0;

  /** A replacing sign-in or a sign-out: the one waiting is cancelled, and a grant it still gets is revoked. */
  const cancelSignIn = async () => {
    if (signingIn === null) return;
    signingIn.cancelled = true;
    signingIn.controller.abort();
    await signingIn.landed;
  };

  const land = async (flow, attempt) => {
    try {
      const result = await flow.done;

      if (result.outcome === 'declined') {
        lastFailure = 'you cancelled the sign-in';

        return;
      }

      await serially(async () => {
        // Cancelled while the browser finished: the grant it made is not kept, so it is not left live either.
        if (attempt.cancelled) {
          if (result.record.refreshToken !== undefined) await revokeSession({ clientId: result.record.clientId, refreshToken: result.record.refreshToken, fetch: fetchImpl });

          return;
        }

        writeRecord(file, result.record);
        firstSignIn = result.registered;
        lastFailure = result.outcome === 'plan-disabled' ? 'ChatGPT plan usage was not granted' : null;
      });
    } catch (err) {
      if (!attempt.controller.signal.aborted) lastFailure = messageOf(err);
    } finally {
      if (signingIn === attempt) signingIn = null;
    }
  };

  /** Renews the session `seen` came from, unless the record moved on while this waited its turn. */
  const rotate = (seen, forced) => serially(async () => {
    const record = current();

    if (!admitting() || record?.refreshToken === undefined || record.accessToken === undefined || !planEnabled(record)) return null;

    // Another step rotated, signed in or signed out meanwhile: its token is the one to use, if any.
    if (record.refreshToken !== seen.refreshToken) return expiring(record, now()) ? null : record.accessToken;

    if (!forced && !expiring(record, now())) return record.accessToken;

    try {
      const fresh = await refreshTokens({ clientId: record.clientId, refreshToken: record.refreshToken, scopes: record.scopes, fetch: fetchImpl, now });

      writeRecord(file, { ...record, ...fresh });

      return fresh.accessToken ?? null;
    } catch (err) {
      if (!(err instanceof SiwcError) || !err.unusable) throw err;
      writeRecord(file, signedOut(record));
      throw new SiwcError(`ChatGPT ended this machine's sign-in (${err.code}); it is signed out`, { code: err.code, cause: err });
    }
  });

  return {
    status() {
      const record = current();

      return {
        signedIn: record?.accessToken !== undefined && planEnabled(record),
        email: record?.email ?? null,
        planEnabled: planEnabled(record),
        planDeclined: planDeclined(record),
        pending: signingIn !== null,
        lastFailure,
        firstSignIn,
      };
    },

    /** Starts a sign-in for the browser the owner holds, replacing one still waiting. */
    async signIn() {
      if (closed) throw new SiwcError('this daemon is handing over to a newer one; sign in again in a moment');
      await cancelSignIn();
      const controller = new AbortController();
      const record = current();
      const registration = registrationOf(record) ?? cliRegistration(home);

      const flow = await beginSignIn({
        home, registration, consent: planDeclined(record), fetch: fetchImpl, now, signal: controller.signal,
      });

      const attempt = { controller, cancelled: false, landed: null };

      lastFailure = null;
      signingIn = attempt;
      attempt.landed = land(flow, attempt);

      return { authorizeUrl: flow.authorizeUrl };
    },

    /** A current access token; `rejected` is one api.openai.com just refused, which forces a rotation. */
    async bearer(rejected) {
      const record = current();

      if (!admitting() || record?.accessToken === undefined || !planEnabled(record)) return null;

      if (record.accessToken !== rejected && !expiring(record, now())) return record.accessToken;
      refreshing ??= rotate(record, record.accessToken === rejected).finally(() => { refreshing = null; });

      return refreshing;
    },

    /**
     * Revokes the renewable session, then forgets its tokens either way; the registration stays for the
     * next sign-in. It waits for a rotation in flight, so the token revoked is the newest, and no call gets
     * a token meanwhile. `unconfirmed` says why the revocation was not confirmed, for the owner to finish in
     * ChatGPT's settings.
     */
    async signOut() {
      signingOut += 1;

      try {
        await cancelSignIn();

        return await serially(async () => {
          const record = current();

          if (record === null) return { unconfirmed: null };

          const { unconfirmed } = record.refreshToken !== undefined && record.clientId !== undefined
            ? await revokeSession({ clientId: record.clientId, refreshToken: record.refreshToken, fetch: fetchImpl })
            : { unconfirmed: null };

          writeRecord(file, signedOut(record));
          firstSignIn = false;

          return { unconfirmed };
        });
      } finally {
        signingOut -= 1;
      }
    },

    /**
     * Starts nothing new and waits for what is under way: an update handoff or an exit calls it. A browser that
     * has not come back is no longer waited for; one that has lands, and the auth call in flight ends when its
     * answer does.
     */
    async quiesce() {
      closed = true;
      closing.resolve();
      const attempt = signingIn;

      attempt?.controller.abort();
      await attempt?.landed;
      await chain;
    },

    /** A forced stop: the auth call in flight ends now, unanswered, and writes nothing. */
    abort() {
      closed = true;
      closing.resolve();
      stopping.abort(new SiwcError('the daemon was stopped before auth.openai.com answered'));
    },
  };
}

module.exports = {
  ISSUER,
  RESOURCE,
  PLAN_SCOPE,
  SCOPES,
  DYNAMIC_AGENT_CLIENT,
  AGENT_NAME_HINT,
  CALLBACK_PATH,
  DEVICE_RECORD_FILE,
  SPENT_REFRESH_CODES,
  SiwcError,
  hostId,
  planEnabled,
  expiring,
  beginSignIn,
  refreshTokens,
  revokeSession,
  registrationOf,
  deviceRegistration,
  createDeviceSession,
};
