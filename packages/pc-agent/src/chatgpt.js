// Sign in with ChatGPT for open-source clients (https://developers.openai.com/siwc/token-sharing-open-source,
// read 2026-09-30): the sign-in, the rotating refresh and the revocation, on the user's own machine.
//
// One implementation for the two processes that may hold the token: the daemon requires this file as a
// sibling, and the CLI imports it. Nothing on Kinu's servers loads it; the OSS terms cover locally hosted
// apps only, so the token never leaves this machine.
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const http = require('node:http');

const crypto = require('node:crypto');

const ISSUER = 'https://auth.openai.com';

const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;

const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;

/** The discovery document's `revocation_endpoint` (read 2026-09-30). */
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;

const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

const RESOURCE = 'https://api.openai.com/v1';

const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];

/** The first-registration entrypoint; never an issued id, never saved. */
const DYNAMIC_AGENT_CLIENT = 'dynamic_agent_client';

/** The app's own name, the same on every installation. */
const AGENT_NAME_HINT = 'Kinu';

/** Only the port of the loopback redirect may vary between sign-ins. */
const CALLBACK_PATH = '/auth/callback';

const USAGE_URL = 'https://chatgpt.com/settings/usage';

/** This machine's `ext_agent_host_id`, shared by the CLI and the daemon: one host per machine. */
const HOST_ID_FILE = 'chatgpt-host-id';

/** The daemon's own sign-in; the CLI keeps its own in config.json. */
const DEVICE_RECORD_FILE = 'pc-agent.chatgpt.json';

/** Refresh this long before the hour-long access token ends. */
const REFRESH_LEAD_MS = 5 * 60_000;

/** The ID token's allowed clock skew, as OpenAI's own verification example sets it. */
const CLOCK_SKEW_SEC = 5;

/** One call to auth.openai.com, bounded, so a hung call holds neither a sign-out nor an update handoff. */
const TOKEN_CALL_TIMEOUT_MS = 30_000;

/** How long an updated daemon waits for the one it replaced to finish its rotation and exit: past one token call. */
const PREDECESSOR_WAIT_MS = 45_000;

const PROCESS_POLL_MS = 50;

/** Refresh answers that end the renewable session: clear the tokens, sign in again with the saved client. */
const UNUSABLE_REFRESH_CODES = Object.freeze([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
]);

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

const byName = (a, b) => a.localeCompare(b);

/** RFC 6749 §5.1: an answer without `scope` granted exactly what was asked (or, on refresh, what the grant held). */
function scopesOf(scope, whenAbsent) {
  const granted = stringOf(scope);

  return granted === undefined ? [...whenAbsent].sort(byName) : granted.split(' ').filter(Boolean).sort(byName);
}

function planEnabled(record) {
  return Array.isArray(record?.scopes) && record.scopes.includes(PLAN_SCOPE);
}

/** Due for refresh: no access token, or within the lead of its expiry. */
function expiring(record, now) {
  const expiresAt = numberOf(record?.expiresAt);

  return stringOf(record?.accessToken) === undefined || expiresAt === undefined || now + REFRESH_LEAD_MS >= expiresAt;
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
    signal: AbortSignal.timeout(TOKEN_CALL_TIMEOUT_MS),
  });

  const answer = tokenAnswerOf(parseJson(await res.text()));

  if (!res.ok) {
    const code = answer.error ?? null;
    const detail = answer.errorDescription === undefined ? '' : `: ${answer.errorDescription}`;

    throw new SiwcError(`auth.openai.com refused ${doing} (HTTP ${res.status}${code === null ? '' : ` ${code}`})${detail}`, {
      code,
      unusable: fields.grant_type === 'refresh_token' && code !== null && UNUSABLE_REFRESH_CODES.includes(code),
    });
  }

  if (answer.accessToken === undefined && answer.idToken === undefined) throw new SiwcError(`auth.openai.com answered ${doing} without tokens`);

  return answer;
}

/** Token fields of one answer, expiry counted from when it arrived. */
function tokensOf(answer, now, grantedWhenAbsent) {
  return {
    ...(answer.accessToken !== undefined && { accessToken: answer.accessToken }),
    ...(answer.refreshToken !== undefined && { refreshToken: answer.refreshToken }),
    ...(answer.expiresIn !== undefined && { expiresAt: now + answer.expiresIn * 1000 }),
    scopes: scopesOf(answer.scope, grantedWhenAbsent),
    savedAt: new Date(now).toISOString(),
  };
}

/** One rotation: the replacement refresh token supersedes the one sent. */
async function refreshTokens({ clientId, refreshToken, scopes = [], fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  // `scope` stays out so the grant keeps what it had.
  const answer = await tokenCall(fetchImpl, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE }, 'the refresh');

  return tokensOf(answer, now(), scopes);
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
      signal: AbortSignal.timeout(TOKEN_CALL_TIMEOUT_MS),
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

/** The ID token's claims this sign-in checks, decoded. */
function claimsOf(payload) {
  return {
    issuer: stringOf(payload.iss),
    audience: Array.isArray(payload.aud) ? stringsOf(payload.aud) : [stringOf(payload.aud)].filter((entry) => entry !== undefined),
    expires: numberOf(payload.exp),
    nonce: stringOf(payload.nonce),
    subject: stringOf(payload.sub),
    email: stringOf(payload.email),
  };
}

/** The OIDC checks: OpenAI's signature, issuer, audience = the issued client, expiry, and this attempt's nonce. */
async function verifyIdToken(idToken, { clientId, nonce, fetch: fetchImpl, now }) {
  const [head, body, signature] = idToken.split('.');
  const header = jwtPart(head);
  const claims = claimsOf(jwtPart(body));
  const kid = stringOf(header.kid);

  if (header.alg !== 'RS256' || kid === undefined) throw new SiwcError(`the ID token is signed with ${String(header.alg)}, not RS256`);
  const key = await signingKey(kid, fetchImpl);
  const signed = new TextEncoder().encode(`${head}.${body}`);

  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(signature ?? '', 'base64url'), signed)) {
    throw new SiwcError('the ID token signature does not verify against auth.openai.com\'s keys');
  }

  if (claims.issuer !== ISSUER) throw new SiwcError(`the ID token was issued by ${String(claims.issuer)}, not ${ISSUER}`);

  if (!claims.audience.includes(clientId)) throw new SiwcError('the ID token was issued to another client');

  if (claims.expires === undefined || claims.expires + CLOCK_SKEW_SEC < now / 1000) throw new SiwcError('the ID token has expired');

  if (claims.nonce !== nonce) throw new SiwcError('the ID token does not answer this sign-in (nonce mismatch)');

  if (claims.subject === undefined || claims.subject === '') throw new SiwcError('the ID token names no subject');

  return { subject: claims.subject, email: claims.email ?? null };
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

    const record = { issuer: ISSUER, subject: identity.subject, email: identity.email, clientId: issued, idToken: answer.idToken, ...tokensOf(answer, at, SCOPES) };

    if (planEnabled(record)) return { outcome: 'signed-in', registered: registering, record };

    // Retain the sign-in, not tokens that cannot pay for inference.
    const { accessToken: _access, refreshToken: _refresh, expiresAt: _expires, ...identityOnly } = record;

    return { outcome: 'plan-disabled', registered: registering, record: identityOnly };
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

  const params = new URLSearchParams({
    client_id: clientId,
    ...(registering && { agent_name_hint: AGENT_NAME_HINT }),
    ext_agent_host_id: hostId(home),
    ...(!registering && registration.email !== undefined && { login_hint: registration.email }),
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ...(consent && { prompt: 'consent' }),
  });

  return { authorizeUrl: `${AUTHORIZE_URL}?${params}`, redirectUri, done: complete() };
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
    idToken: stringOf(json?.idToken),
    accessToken: stringOf(json?.accessToken),
    refreshToken: stringOf(json?.refreshToken),
    expiresAt: numberOf(json?.expiresAt),
    scopes: stringsOf(json?.scopes),
    savedAt: stringOf(json?.savedAt),
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

function processAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function pause(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * The daemon's own ChatGPT sign-in. Every write of the record (a rotation, a sign-in landing, a sign-out) runs
 * on one chain, and each re-reads the record there, so none acts on a session another has replaced: a delayed
 * refresh cannot bring a signed-out session back, and a sign-out revokes the newest refresh token. The chain's
 * first step waits for the daemon this one replaced, so an update's overlap submits no refresh token twice.
 */
function createDeviceSession({ home, fetch: fetchImpl = globalThis.fetch, now = Date.now, predecessor = null }) {
  const file = path.join(home, DEVICE_RECORD_FILE);
  /** The sign-in waiting for the browser: its abort, and its landing, which settles once it is over. */
  let signingIn = null;
  let refreshing = null;
  let lastFailure = null;
  let firstSignIn = false;
  /** Sign-outs under way; while any is, no call gets a token. */
  let signingOut = 0;
  /** Set by `quiesce`: an update handoff or an exit is under way, and nothing new starts. */
  let closed = false;

  // Until the replaced daemon has exited, or for a bound a hung one cannot outlast; a quiesce ends the wait.
  const replaced = async () => {
    const deadline = Date.now() + PREDECESSOR_WAIT_MS;

    while (!closed && processAlive(predecessor) && Date.now() < deadline) await pause(PROCESS_POLL_MS);
  };

  let chain = predecessor === null ? Promise.resolve() : replaced();

  const current = () => readRecord(file);

  /** Runs `step` after every write queued before it; the chain itself never rejects. */
  const serially = (step) => {
    const run = chain.then(step);
    chain = run.then(noop, noop);

    return run;
  };

  const admitting = () => !closed && signingOut === 0;

  const cancelSignIn = async () => {
    if (signingIn === null) return;
    signingIn.controller.abort();
    await signingIn.landed;
  };

  const land = async (flow, controller) => {
    try {
      const result = await flow.done;

      if (result.outcome === 'declined') {
        lastFailure = 'you cancelled the sign-in';

        return;
      }

      await serially(async () => {
        // Cancelled while the browser finished: the grant it made is not kept, so it is not left live either.
        if (controller.signal.aborted) {
          if (result.record.refreshToken !== undefined) await revokeSession({ clientId: result.record.clientId, refreshToken: result.record.refreshToken, fetch: fetchImpl });

          return;
        }

        writeRecord(file, result.record);
        firstSignIn = result.registered;
        lastFailure = result.outcome === 'plan-disabled' ? 'ChatGPT plan usage was not granted' : null;
      });
    } catch (err) {
      if (!controller.signal.aborted) lastFailure = messageOf(err);
    } finally {
      if (signingIn?.controller === controller) signingIn = null;
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

      lastFailure = null;
      signingIn = { controller, landed: land(flow, controller) };

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

    /** Stops new token work and waits for the writes already queued: an update handoff or an exit calls it. */
    async quiesce() {
      closed = true;
      signingIn?.controller.abort();
      await chain;
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
  USAGE_URL,
  DEVICE_RECORD_FILE,
  UNUSABLE_REFRESH_CODES,
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
