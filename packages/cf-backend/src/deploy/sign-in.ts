// The deploy page's sign-in, kept in a DeployRunDO of its own (`deploy-session.<sha256(cookie)>`): the PKCE leg, the
// Cloudflare user it proved, the grant it reads with until a run takes the refresh token, and the account whose run it
// shows. Its hour starts at the callback; the object's alarm deletes it then (deploy-do.ts `tick`).
// cf-only by design (scripts/capability-parity.lock.json): it holds a browser's sign-in across a closed tab, which the
// terminal `kinu deploy` signs in through its own localhost redirect and does not keep, so a CLI copy would be dead code.
import { Effect } from 'effect';
import * as v from 'valibot';
import {
  ACCESS_TOKEN_KEY, DEPLOY_CLIENT_ID_KEY, DEPLOY_SESSION_STATE, REFRESH_TOKEN_KEY, bearerTransport, cloudflareUser,
  exchangeDeployCode, heard, type CloudflareUser,
} from '@kinu.run/core/deploy';
import { randomToken } from '@kinu.run/core';
import { settle, type KinuError } from '@kinu.run/core/obs';

export const VERIFIER_KEY = 'oauth.verifier';

export const STATE_KEY = 'oauth.state';

export const SECRET_PREFIX = 'secret.';

/** Not a secret, so not under the `secret.` prefix; the wipe leaves it. */
export const TOKEN_EXPIRES_KEY = 'run.token_expires_at';

/** When the sign-in is deleted, grant and all. */
export const SESSION_UNTIL_KEY = 'session.until';

const SESSION_USER_KEY = 'session.user';

const SESSION_ACCOUNT_KEY = 'session.account';

/** Where the sign-in leg ends: the tab itself, or the helper window's shared finish page. */
const SESSION_END_KEY = 'session.end';

/** The scopes the grant came with, as Cloudflare named them; absent where its answer named none. */

/** Set when the person signed in again to grant API Tokens (the page's computer row asked them to). */

/** The page's connect run (`connect-window.ts`), which the helper window's finish page names so its tab hears the end. */
const SESSION_CONNECT_RUN_KEY = 'session.connect_run';

/** A grant lasts this long without the person, a sign-in this long from its callback. */
export const VAULT_TTL_MS = 3_600_000;

/** A `state` nonce of 128 bits. */
export const NONCE_BYTES = 16;

const EndSchema = v.picklist(['helper', 'tab']);

type DeploySignInEnd = v.InferOutput<typeof EndSchema>;

/** What the page asked of its sign-in: where it ends, and the connect run it ends for. */
export interface DeploySignInAsk {
  readonly end: DeploySignInEnd;
  readonly run: string | null;
}

/** Where a sign-in ends, and the connect run its finish page names; null when the page named none. */
export type DeploySignInEnding = Pick<DeploySignInAsk, 'end' | 'run'>;

const UserSchema = v.object({ id: v.string(), email: v.string() });

/** A grant as the person gave it: the run's own to spend. */
export interface DeployGrant {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms; 0 when Cloudflare named no lifetime. */
  readonly expiresAt: number;
}

/** What the sign-in shares with the run role of its object: the grant's storage, its renewal, and the alarm. */
export interface SignInHost {
  readonly storage: DurableObjectStorage;
  now(): number;
  arm(): Promise<void>;
  accessToken(): Effect.Effect<string, KinuError>;
}

export async function holdGrant(storage: DurableObjectStorage, grant: DeployGrant): Promise<void> {
  await storage.put(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`, grant.clientId);
  await storage.put(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`, grant.accessToken);
  await storage.put(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`, grant.refreshToken);
  await storage.put(TOKEN_EXPIRES_KEY, grant.expiresAt);
}

/** What `storage` keeps under `key`, as `schema` reads it; null when it keeps nothing there that it reads. */
export async function heldValue<T>(storage: DurableObjectStorage, key: string, schema: v.GenericSchema<T>): Promise<T | null> {
  const held = v.safeParse(schema, await storage.get(key));

  return held.success ? held.output : null;
}

export class DeploySignIn {
  constructor(private readonly host: SignInHost) {}

  /** Its hour starts now; the alarm deletes it then, grant and all. */
  async open(): Promise<void> {
    await this.host.storage.put(SESSION_UNTIL_KEY, this.host.now() + VAULT_TTL_MS);
    await this.host.arm();
  }

  async hold(verifier: string, ask: DeploySignInAsk): Promise<string> {
    const state = `${DEPLOY_SESSION_STATE}.${randomToken(NONCE_BYTES)}`;

    await this.host.storage.put(VERIFIER_KEY, verifier);
    await this.host.storage.put(STATE_KEY, state);
    await this.host.storage.put(SESSION_END_KEY, ask.end);
    await this.host.storage.put(SESSION_CONNECT_RUN_KEY, ask.run);

    return state;
  }

  async ending(): Promise<DeploySignInEnding> {
    const end = await heldValue(this.host.storage, SESSION_END_KEY, EndSchema) ?? 'tab';

    return { end, run: await heldValue(this.host.storage, SESSION_CONNECT_RUN_KEY, v.string()) };
  }

  /** The code exchanged for a grant, and the grant proven against `GET /user`: the user a run of this sign-in is named for. */
  land(clientId: string, redirectUri: string, code: string, state: string): Promise<boolean> {
    const { storage } = this.host;

    return settle(Effect.gen({ self: this }, function* () {
      const expected = (yield* Effect.promise(async () => storage.get<string>(STATE_KEY))) ?? '';
      const verifier = (yield* Effect.promise(async () => storage.get<string>(VERIFIER_KEY))) ?? '';

      if (expected === '' || verifier === '' || state !== expected) return false;

      const token = yield* Effect.promise(async () => exchangeDeployCode({ clientId, redirectUri, code, verifier }));
      // A run is named for this id, so an answer without one is no sign-in.
      const user = yield* cloudflareUser(bearerTransport(token.accessToken));

      yield* Effect.promise(async () => storage.delete([VERIFIER_KEY, STATE_KEY]));
      yield* Effect.promise(async () => holdGrant(storage, {
        clientId, accessToken: token.accessToken, refreshToken: token.refreshToken,
        expiresAt: token.expiresInSeconds === 0 ? 0 : this.host.now() + token.expiresInSeconds * 1000,
      }));
      yield* Effect.promise(async () => storage.put(SESSION_USER_KEY, { id: user.id, email: user.email }));

      // Its hour from now, as the cookie the callback renews says.
      yield* Effect.promise(async () => this.open());

      return true;
    }));
  }

  async user(): Promise<CloudflareUser | null> {
    return heldValue(this.host.storage, SESSION_USER_KEY, UserSchema);
  }

  /** A live access token for the page's reads; null when the sign-in holds none it can renew. */
  async readToken(): Promise<string | null> {
    return settle(Effect.map(heard(this.host.accessToken()), (held) => ('answer' in held ? held.answer : null)));
  }

  /** The grant moves into a run. The sign-in keeps the access token for its reads, never the refresh token two holders would race to spend. */
  async surrender(): Promise<DeployGrant | null> {
    const { storage } = this.host;
    const clientId = await storage.get<string>(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`);
    const accessToken = await storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`);
    const refreshToken = await storage.get<string>(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`);

    if (clientId === undefined || accessToken === undefined || refreshToken === undefined) return null;
    await storage.delete(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`);

    return { clientId, accessToken, refreshToken, expiresAt: await storage.get<number>(TOKEN_EXPIRES_KEY) ?? 0 };
  }

  /** The account whose run this sign-in shows as `runs/current`. */
  async follow(account: string): Promise<void> {
    await this.host.storage.put(SESSION_ACCOUNT_KEY, account);
  }

  async following(): Promise<string> {
    return await this.host.storage.get<string>(SESSION_ACCOUNT_KEY) ?? '';
  }
}
