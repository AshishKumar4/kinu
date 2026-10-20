/**
 * DeployRunDO — one guided deployment, from the first answer to the moment it
 * holds no secret; and, for the deploy page, the sign-in that starts it.
 *
 * WHY A DURABLE OBJECT PER RUN. A run is a sequence of writes to somebody
 * else's Cloudflare account that takes minutes, and the page in front of it is
 * a browser tab that can close. The object is the run's memory: every step is a
 * row, so a reload re-renders what already happened, and an eviction in the
 * middle of a step leaves that row `running` and the next activation does it
 * again — which is safe because the steps look before they create.
 *
 * THE ALARM IS THE RUNNER. `start`, `begin` and `selfUpdate` write down what to
 * run and return at once; `alarm()` is where every step actually happens. A
 * caller is never held for the length of a deployment, a handler the runtime
 * could not finish is redelivered — which is how a run survives an eviction,
 * and how a self-update survives the restart its own upload causes — and the
 * same one timer, with no plan to run, is every clock the run keeps: the
 * fifteen-second re-check of a paused run, the hour its grant may be held, the
 * seven days its ledger is kept, and a sign-in's hour.
 *
 * WHAT IT HOLDS AND FOR HOW LONG. The vault (`secret.`) holds two kinds of
 * thing: the person's grant (access token, refresh token, client id) and what
 * the run minted (the root keys, the setup link's secret) or was given. The
 * grant is held for an hour without the person: a run paused on a prerequisite
 * re-checks for that hour, then lets go of the grant, because a tab somebody
 * closed must not leave their account writable from here; signing in again
 * from any device gives it back, and the run carries on where it stopped. The
 * minted keys stay with the ledger and the setup link for seven days, so that
 * resume finds them, then the object deletes itself. The handover writes the
 * refresh token into the new Worker and wipes the vault. A self-update keeps
 * its refresh token and client id past the hour: they are the deployment's own.
 *
 * WHO REACHES IT. A door run (the CLI, the old page) is named by its run id and
 * authorized by its run key: 192 bits minted at creation, presented on every
 * call, compared against its digest. A page run is named for the Cloudflare
 * user and account it deploys into (`deploy-run.<user>.<account>`), reached
 * only through a sign-in that proved that user: the sign-in's own object,
 * named by its cookie's digest, holds the grant and the user for an hour.
 */
import { Effect } from 'effect';
import { DurableObject } from 'cloudflare:workers';
import {
  ACCESS_TOKEN_KEY, DEPLOY_CLIENT_ID_KEY, DEPLOY_SESSION_STATE, DEPLOY_SOCKET_PROTOCOL,
  DeployInputsSchema, DeployNeedSchema, DeployRunPhaseSchema, DeployRunPlanSchema, DeployStepRowSchema, DeploymentRecordSchema,
  FACT_ADDRESS, HeldBytes, REFRESH_TOKEN_KEY, SELF_UPDATE_RUN_ID, SIGN_IN_AGAIN_NEED,
  bearerTransport, cloudflareResult, cloudflareUser, deployPlan, deployRunView, exchangeDeployCode, factsFrom, failureWords,
  fetchReleaseArtifact, fetchReleaseManifest, heard, judgeRefusal, mintDeployRun, refreshDeployToken, runDeployPlan, runKeyAdmits,
  zoneHeld,
  type ArtifactMember, type ArtifactSource, type CloudflareUser, type DeployChoice, type DeployFrame, type DeployInputs, type DeployLedger, type DeployNeed,
  type DeployRunFrame, type DeployRunOutcome, type DeployRunPlan, type DeployRunView,
  type DeploySecretVault, type DeploySnapshot, type DeployStepFailure,
  type DeployStepRow, type DeployStepSeed, type DeploymentRecord, type TarArtifact,
} from '@kinu.run/core/deploy';
import { randomToken, sha256Hex } from '@kinu.run/core';
import { diagnostics, KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';
import * as v from 'valibot';

interface StepRecord extends Record<string, SqlStorageValue> {
  id: string;
  seq: number;
  title: string;
  state: string;
  attempt: number;
  detail: string;
  notes: string;
  failure: string | null;
  facts: string;
}

const FailureSchema = DeployStepRowSchema.entries.failure;

const FactsSchema = DeployStepRowSchema.entries.facts;

const NotesSchema = DeployStepRowSchema.entries.notes;

const StateSchema = DeployStepRowSchema.entries.state;

/** An account to deploy into or a zone to bind a hostname in, as the Cloudflare API answers it. */
const ChoicesSchema: v.GenericSchema<readonly DeployChoice[]> = v.array(v.object({
  id: v.string(),
  name: v.string(),
}));

const RUN_STATE_KEY = 'run.state';

const RUN_ID_KEY = 'run.id';

const INPUTS_KEY = 'run.inputs';

const KEY_DIGEST_KEY = 'run.key_digest';

const VERIFIER_KEY = 'oauth.verifier';

const STATE_KEY = 'oauth.state';

/** The release version this run installs, shown while steps are still going. */
const VERSION_KEY = 'run.version';

const SECRET_PREFIX = 'secret.';

/** The person's grant inside the vault: what the hour lets go of. The rest of the vault is what the run minted or was given. */
const GRANT_KEYS: readonly string[] = [ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, DEPLOY_CLIENT_ID_KEY].map((key) => `${SECRET_PREFIX}${key}`);

/** An update's vault keys that the expiry leaves: the deployment's own key. */
const OWN_KEY: readonly string[] = [`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`, `${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`];

/** The state nonce, in bytes. 128 bits of CSPRNG beside the run id, so a
 *  `state` is not guessable by somebody who knows which run is authorizing. */
const NONCE_BYTES = 16;

/** Durable: the activation that writes the intent is often not the one that runs it. Whether it is an update is the
 *  run record's presence, which the alarm reads. */
const IntentSchema = v.object({
  channelOrigin: v.pipe(v.string(), v.minLength(1)),
});

type DeployIntent = v.InferOutput<typeof IntentSchema>;

const INTENT_KEY = 'run.intent';

/** For an update: what to re-run, and where to write the rotated refresh token. */
const RECORD_KEY = 'run.record';

/** Not a secret, so not under the `secret.` prefix; the wipe leaves it. */
const TOKEN_EXPIRES_KEY = 'run.token_expires_at';

/** The first owner's setup link and its lapse: shown to the run's holder until then, never in a row or the vault. */
const SEAT_KEY = 'run.owner_seat';

const SeatSchema = v.object({ link: v.string(), expiresAt: v.number() });

/** When the grant must be let go of: an hour after the person last acted, or after the run first paused. */
const GRANT_UNTIL_KEY = 'run.grant_until';

/** A page run: the Cloudflare user it belongs to, and how it began (`DeployRunPlan`). */
const OWNER_KEY = 'run.owner';

const PLAN_KEY = 'run.plan';

/** The prerequisite a page run is paused on, the step it stopped at, and since when. */
const PAUSE_KEY = 'run.paused';

const PauseSchema = v.object({ need: DeployNeedSchema, step: v.string(), since: v.number() });

type DeployPause = v.InferOutput<typeof PauseSchema>;

/** The handover wrote this run's refresh token into the deployment: from then on the run never spends it. */
const HANDED_KEY = 'run.handed_over';

/** When the object deletes itself: seven days after the run last moved. */
const RETAIN_KEY = 'run.retain_until';

/** A sign-in's object: its Cloudflare user, the account whose run it follows, and the end of its hour. */
const SESSION_USER_KEY = 'session.user';

const SESSION_ACCOUNT_KEY = 'session.account';

const SESSION_UNTIL_KEY = 'session.until';

/** Where the sign-in leg ends: the shared finish page in a helper window, or back in the tab. */
const SESSION_END_KEY = 'session.end';

const EndSchema = v.picklist(['helper', 'tab']);

export type DeploySignInEnd = v.InferOutput<typeof EndSchema>;

const UserSchema = v.object({ id: v.string(), email: v.string() });

/** How long a run may hold tokens idle: an hour so a person can fix billing in another tab and retry. */
const VAULT_TTL_MS = 3_600_000;

/** A paused run asks Cloudflare again this often, and whenever the page reads it. */
const RECHECK_MS = 15_000;

/** The ledger, the minted keys and the setup link outlive the grant by this much: the link's own lifetime. */
const RETAIN_MS = 7 * 24 * 3_600_000;

/** A plan's next call must not land past the access token's expiry. */
const TOKEN_FLOOR_MS = 60_000;

/** The person's grant as a sign-in hands it to a run: moved, never copied, since a refresh rotates the refresh token. */
export interface DeployGrant {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms; 0 when Cloudflare named no lifetime. */
  readonly expiresAt: number;
}

/** The archive is fetched when a step first walks it, so a re-check that stops before the upload downloads none of it.
 *  Its bytes are charged to `held` on arrival, as `TarArtifact` charges its own. */
function fetchedOnWalk(open: () => Promise<TarArtifact>): ArtifactSource {
  const held = new HeldBytes();

  return {
    held,
    async *members(): AsyncIterable<ArtifactMember> {
      const artifact = await open();

      held.hold(artifact.held.peak());
      yield* artifact.members();
    },
  };
}

export class DeployRunDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  /** Idempotent; called again after `deleteAll` drops the table under a live activation. */
  private initSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deploy_step (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '[]',
      failure TEXT,
      facts TEXT NOT NULL DEFAULT '{}'
    )`);
  }

  /** Every clock here reads this, so a probe can move time without waiting for it. */
  protected now(): number {
    return Date.now();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.accept(request);
    }

    return new Response('not a deploy socket', { status: 400 });
  }

  /** The key is returned to the caller once, by the route. The expiry alarm starts now so an
   *  object minted by a probe that never returns deletes itself. */
  async open(runId: string, keyDigest: string): Promise<void> {
    await this.ctx.storage.put(RUN_ID_KEY, runId);
    await this.ctx.storage.put(KEY_DIGEST_KEY, keyDigest);
    await this.ctx.storage.put(RUN_STATE_KEY, 'collecting');
    await this.ctx.storage.put(RETAIN_KEY, this.now() + RETAIN_MS);
    await this.armExpiry();
  }

  async admits(runKey: string): Promise<boolean> {
    return runKeyAdmits(runKey, await this.ctx.storage.get<string>(KEY_DIGEST_KEY) ?? '');
  }

  /**
   * The PKCE verifier stays here: a verifier that travelled would make the exchange forgeable.
   * A callback whose state is not this object's nonce is refused rather than exchanged.
   */
  async holdAuthorization(verifier: string): Promise<string> {
    const state = `${await this.runId()}.${randomToken(NONCE_BYTES)}`;

    await this.ctx.storage.put(VERIFIER_KEY, verifier);
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.put(RUN_STATE_KEY, 'authorizing');

    return state;
  }

  /**
   * False (a 400) for a callback that is not this run's; the exchange itself still throws so the
   * authorization server's refusal reaches the person.
   */
  async landAuthorization(clientId: string, redirectUri: string, code: string, state: string): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(STATE_KEY) ?? '';
    const verifier = await this.ctx.storage.get<string>(VERIFIER_KEY) ?? '';

    if (expected === '' || verifier === '' || state !== expected) return false;

    const token = await exchangeDeployCode({ clientId, redirectUri, code, verifier });

    await this.ctx.storage.delete([VERIFIER_KEY, STATE_KEY]);
    await this.landToken(clientId, token.accessToken, token.refreshToken, token.expiresInSeconds);

    return true;
  }

  /** Reached by the page's callback and by `kinu deploy cloudflare`. The client id is written into
   *  the deployment (a refresh names its client); the lifetime lets a late retry renew the token. */
  async landToken(
    clientId: string,
    accessToken: string,
    refreshToken: string,
    expiresInSeconds: number,
  ): Promise<void> {
    await this.landGrant({ clientId, accessToken, refreshToken, expiresAt: expiresInSeconds === 0 ? 0 : this.now() + expiresInSeconds * 1000 });
  }

  /** A grant the person just gave: the run's own to spend, held for the hour from now. */
  private async landGrant(grant: DeployGrant): Promise<void> {
    await this.holdGrant(grant);
    await this.ctx.storage.delete(HANDED_KEY);

    // A refresh in the middle of a plan must not send the page back to the form.
    if (await this.runState() === 'authorizing') await this.ctx.storage.put(RUN_STATE_KEY, 'collecting');
    await this.armExpiry();
  }

  private async holdGrant(grant: DeployGrant): Promise<void> {
    await this.ctx.storage.put(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`, grant.clientId);
    await this.ctx.storage.put(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`, grant.accessToken);
    await this.ctx.storage.put(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`, grant.refreshToken);
    await this.ctx.storage.put(TOKEN_EXPIRES_KEY, grant.expiresAt);
  }

  async authorized(): Promise<boolean> {
    return await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`) !== undefined;
  }

  /** Straight into the vault, never the inputs row, which is readable for the run's lifetime. */
  async holdProviderKey(name: string, value: string): Promise<void> {
    await this.ctx.storage.put(`${SECRET_PREFIX}${name}`, value);
    await this.armExpiry();
  }

  /** Read with the run's own token and never stored. */
  accounts(): Promise<readonly DeployChoice[]> {
    return settle(this.choices('/accounts?per_page=50'));
  }

  zones(): Promise<readonly DeployChoice[]> {
    return settle(this.choices('/zones?per_page=50'));
  }

  async snapshot(): Promise<DeploySnapshot> {
    const steps = this.rows();
    const facts = factsFrom(steps);
    const seat = await this.seat();

    return {
      runId: await this.runId(),
      state: await this.runState(),
      address: facts.get(FACT_ADDRESS) ?? '',
      version: await this.ctx.storage.get<string>(VERSION_KEY) ?? '',
      steps,
      setupLink: seat,
    };
  }

  private choices(path: string): Effect.Effect<readonly DeployChoice[], KinuError> {
    return Effect.gen({ self: this }, function* () {
      const transport = bearerTransport(yield* this.accessToken());

      return yield* Effect.promise(() => cloudflareResult(transport, { method: 'GET', path }, ChoicesSchema));
    });
  }

  /**
   * Records the plan and wakes the alarm; the plan never runs in this call. Answers are parsed before
   * storing and refused while a plan is going, so a second `start` cannot change what remaining steps deploy.
   */
  async start(inputs: DeployInputs): Promise<DeploySnapshot> {
    const parsed = v.parse(DeployInputsSchema, inputs);

    if (await this.going()) return this.snapshot();

    await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(parsed));
    await this.wake({ channelOrigin: this.channelOrigin() });

    return this.snapshot();
  }

  /** Re-enters at exactly the failed step because everything before it is `done`. */
  async retry(stepId: string): Promise<DeploySnapshot> {
    if (await this.going()) return this.snapshot();
    const inputs = await this.ctx.storage.get<string>(INPUTS_KEY);

    if (inputs === undefined) return this.snapshot();
    this.sql.exec(`UPDATE deploy_step SET state = 'pending', failure = NULL WHERE id = ? AND state = 'failed'`, stepId);

    const record = await this.ctx.storage.get<string>(RECORD_KEY);

    await this.wake({
      channelOrigin: record === undefined ? this.channelOrigin() : v.parse(DeploymentRecordSchema, JSON.parse(record)).channelOrigin,
    });

    return this.snapshot();
  }

  /**
   * The deployment updating itself (docs/SELF-DEPLOY.md § Updates).
   *
   * THE SAME PLAN, not an update-shaped subset of it: every step looks before
   * it creates, so a second run over an account that already holds everything
   * uploads a new version and points the deployment at it. What differs is
   * where the three things come from — the answers come from the deployment's
   * own record instead of a person, the token is minted by spending the
   * deployment's own refresh token, and the channel is the one the record
   * names rather than this Worker's own origin. The page's update of a Kinu
   * (`begin` with an update plan) is this plan again, its answers read back
   * from the account and its token the person's.
   *
   * THE GRANT IS SPENT HERE AND KEPT HERE. Cloudflare rotates the refresh token
   * on every refresh, so the pair this call receives is the only one that will
   * ever work again: it lands in this object before a step runs, and only the
   * handover moves it into the Worker, after `promote`. A secret write deploys a
   * copy of the latest version, the staged one until then, so Cloudflare
   * refuses it (10215) or would ship the staged code.
   *
   * The token it spends is this object's when it holds one: after a failed
   * update `env` still carries a spent token.
   */
  async selfUpdate(record: DeploymentRecord, refreshToken: string): Promise<DeploySnapshot> {
    await this.ctx.storage.put(RUN_ID_KEY, SELF_UPDATE_RUN_ID);

    if (await this.going()) return this.snapshot();

    await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(record.inputs));
    await this.ctx.storage.put(RECORD_KEY, JSON.stringify(record));

    const held = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`);
    const token = await refreshDeployToken({ clientId: record.clientId, refreshToken: held ?? refreshToken });

    await this.landToken(record.clientId, token.accessToken, token.refreshToken, token.expiresInSeconds);
    await this.wake({ channelOrigin: record.channelOrigin });

    return this.snapshot();
  }

  // ── A sign-in (the page's session) ────────────────────────────────────────

  /** Its hour starts now; the alarm deletes it then, grant and all. */
  async openSession(): Promise<void> {
    await this.ctx.storage.put(SESSION_UNTIL_KEY, this.now() + VAULT_TTL_MS);
    await this.arm();
  }

  async holdSignIn(verifier: string, end: DeploySignInEnd): Promise<string> {
    const state = `${DEPLOY_SESSION_STATE}.${randomToken(NONCE_BYTES)}`;

    await this.ctx.storage.put(VERIFIER_KEY, verifier);
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.put(SESSION_END_KEY, end);

    return state;
  }

  async ending(): Promise<DeploySignInEnd> {
    const held = v.safeParse(EndSchema, await this.ctx.storage.get(SESSION_END_KEY));

    return held.success ? held.output : 'tab';
  }

  /** The code exchanged for a grant, and the grant proven against `GET /user`: the user a run of this sign-in is named for. */
  async landSignIn(clientId: string, redirectUri: string, code: string, state: string): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(STATE_KEY) ?? '';
    const verifier = await this.ctx.storage.get<string>(VERIFIER_KEY) ?? '';

    if (expected === '' || verifier === '' || state !== expected) return false;

    const token = await exchangeDeployCode({ clientId, redirectUri, code, verifier });
    const user = await settle(cloudflareUser(bearerTransport(token.accessToken)));

    await this.ctx.storage.delete([VERIFIER_KEY, STATE_KEY]);
    await this.holdGrant({
      clientId, accessToken: token.accessToken, refreshToken: token.refreshToken,
      expiresAt: token.expiresInSeconds === 0 ? 0 : this.now() + token.expiresInSeconds * 1000,
    });
    await this.ctx.storage.put(SESSION_USER_KEY, { id: user.id, email: user.email });

    return true;
  }

  async signedIn(): Promise<CloudflareUser | null> {
    const held = v.safeParse(UserSchema, await this.ctx.storage.get(SESSION_USER_KEY));

    return held.success ? held.output : null;
  }

  /** A live access token for the page's reads; null when the sign-in holds none it can renew. */
  async readToken(): Promise<string | null> {
    return settle(Effect.map(heard(this.accessToken()), (held) => ('answer' in held ? held.answer : null)));
  }

  /** The grant moves into a run. The sign-in keeps the access token for its reads, never the refresh token two holders would race to spend. */
  async surrender(): Promise<DeployGrant | null> {
    const clientId = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`);
    const accessToken = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`);
    const refreshToken = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`);

    if (clientId === undefined || accessToken === undefined || refreshToken === undefined) return null;
    await this.ctx.storage.delete(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`);

    return { clientId, accessToken, refreshToken, expiresAt: await this.ctx.storage.get<number>(TOKEN_EXPIRES_KEY) ?? 0 };
  }

  /** The account whose run this sign-in shows as `runs/current`. */
  async follow(account: string): Promise<void> {
    await this.ctx.storage.put(SESSION_ACCOUNT_KEY, account);
  }

  async following(): Promise<string> {
    return await this.ctx.storage.get<string>(SESSION_ACCOUNT_KEY) ?? '';
  }

  // ── A page run ────────────────────────────────────────────────────────────

  async busy(): Promise<boolean> {
    return this.going();
  }

  /**
   * A new run in this account, replacing whatever finished or stopped here before: the ledger, the vault (a change
   * must never bind another Worker's minted keys) and the setup link start empty. Null while a plan is going.
   */
  async begin(owner: string, plan: DeployRunPlan, grant: DeployGrant): Promise<string | null> {
    if (await this.going()) return null;
    const parsed = v.parse(DeployRunPlanSchema, plan);
    const runId = mintDeployRun().runId;
    const vault = await this.ctx.storage.list({ prefix: SECRET_PREFIX });

    this.sql.exec(`DELETE FROM deploy_step`);
    await this.ctx.storage.delete([...vault.keys(), PAUSE_KEY, SEAT_KEY, VERSION_KEY]);
    await this.ctx.storage.put(RUN_ID_KEY, runId);
    await this.ctx.storage.put(OWNER_KEY, owner);
    await this.ctx.storage.put(PLAN_KEY, JSON.stringify(parsed));
    await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(parsed.inputs));
    await this.ctx.storage.put(RETAIN_KEY, this.now() + RETAIN_MS);
    await this.landGrant(grant);
    await this.wake({ channelOrigin: this.channelOrigin() });

    return runId;
  }

  /** The page's view, for its own user only; null for anyone else's sign-in, or when no run is here. */
  async view(owner: string): Promise<DeployRunView | null> {
    if (!await this.ownedBy(owner)) return null;

    return this.runView();
  }

  /** The view, and a paused run asks Cloudflare again now rather than at its next fifteen seconds. */
  async current(owner: string): Promise<DeployRunView | null> {
    if (!await this.ownedBy(owner)) return null;

    if (!await this.going() && await this.pause() !== null && await this.authorized()) await this.wake({ channelOrigin: this.channelOrigin() });

    return this.runView();
  }

  /** Whether `continue` needs the sign-in's grant: the run let go of its own, and has more to do. */
  async wantsGrant(owner: string): Promise<boolean> {
    if (!await this.ownedBy(owner) || await this.authorized()) return false;

    return await this.runState() !== 'done' || ((await this.plan())?.pending ?? null) !== null;
  }

  /**
   * After a refusal's action, or on resume from any device: the grant lands if one came, the stopped step runs again,
   * and a run waiting on a zone looks at it now.
   */
  async carryOn(owner: string, grant: DeployGrant | null): Promise<DeployRunView | null> {
    if (!await this.ownedBy(owner)) return null;

    if (grant !== null) await this.landGrant(grant);

    if (!await this.going()) {
      await this.ctx.storage.put(RETAIN_KEY, this.now() + RETAIN_MS);

      if (await this.runState() === 'done') {
        await this.ctx.storage.setAlarm(Date.now());
      } else {
        this.sql.exec(`UPDATE deploy_step SET state = 'pending', failure = NULL WHERE state = 'failed'`);
        await this.wake({ channelOrigin: this.channelOrigin() });
      }
    }

    return this.runView();
  }

  private async ownedBy(owner: string): Promise<boolean> {
    const held = await this.ctx.storage.get<string>(OWNER_KEY) ?? '';

    return held !== '' && held === owner;
  }

  private async plan(): Promise<DeployRunPlan | null> {
    const held = await this.ctx.storage.get<string>(PLAN_KEY);

    return held === undefined ? null : v.parse(DeployRunPlanSchema, JSON.parse(held));
  }

  private async pause(): Promise<DeployPause | null> {
    const held = v.safeParse(PauseSchema, await this.ctx.storage.get(PAUSE_KEY));

    return held.success ? held.output : null;
  }

  private async seat(): Promise<{ readonly link: string; readonly expiresAt: number } | null> {
    const seat = v.safeParse(SeatSchema, await this.ctx.storage.get(SEAT_KEY));

    return seat.success && seat.output.expiresAt > this.now() ? seat.output : null;
  }

  private async runView(): Promise<DeployRunView> {
    const rows = this.rows();
    const plan = await this.plan();
    const state = await this.runState();
    const inputs = await this.ctx.storage.get<string>(INPUTS_KEY);
    const answers = inputs === undefined ? null : v.parse(DeployInputsSchema, JSON.parse(inputs));
    const pending = plan?.pending ?? null;
    const renamed = plan === null || plan.renamedFrom === '' ? '' : `${plan.renamedFrom} was taken by then, so this Kinu is ${plan.inputs.instanceName}.`;

    return deployRunView({
      runId: await this.runId(),
      account: answers?.accountId ?? '',
      rows,
      state,
      mail: (answers?.mailDomain ?? '') !== '',
      paused: (await this.pause())?.need ?? null,
      signedOut: state !== 'done' && !await this.authorized(),
      seat: await this.seat(),
      pending: pending === null ? null : { domain: pending.domain, nameservers: pending.nameservers },
      note: renamed,
      now: this.now(),
    });
  }

  /** Runs the stored intent (redelivered if unfinished, so runs resume); with no intent, it is the clock. */
  override alarm(): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const intent = yield* Effect.promise(async () => this.ctx.storage.get<string>(INTENT_KEY));

      if (intent === undefined) {
        yield* this.tick();

        return;
      }

      const held = v.parse(IntentSchema, JSON.parse(intent));
      const record = yield* Effect.promise(async () => this.ctx.storage.get<string>(RECORD_KEY));
      const inputs = yield* Effect.promise(async () => this.ctx.storage.get<string>(INPUTS_KEY));

      if (inputs === undefined) {
        yield* Effect.promise(async () => this.ctx.storage.delete(INTENT_KEY));

        return;
      }

      yield* this.drive(v.parse(DeployInputsSchema, JSON.parse(inputs)), held.channelOrigin, record !== undefined);

      // Only after the plan settled: a stored intent is a plan the next alarm must carry on with.
      yield* Effect.promise(async () => this.ctx.storage.delete(INTENT_KEY));
      yield* Effect.promise(async () => this.arm());
    }));
  }

  /**
   * The clock, when no plan is going. In order: a sign-in past its hour is deleted; a grant past its hour is let go
   * of; a paused run holding its grant asks Cloudflare again; a live run waiting on a zone looks at it; and a run seven
   * days still is deleted.
   */
  private tick(): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const now = this.now();
      const session = yield* Effect.promise(async () => this.ctx.storage.get<number>(SESSION_UNTIL_KEY));

      if (session !== undefined && session <= now) return yield* Effect.promise(async () => this.deleteSelf('deploy.session_ended'));
      const grantUntil = yield* Effect.promise(async () => this.ctx.storage.get<number>(GRANT_UNTIL_KEY));

      if (session === undefined && grantUntil !== undefined && grantUntil <= now) {
        if (yield* Effect.promise(async () => this.expire())) return;
      } else if (yield* Effect.promise(async () => this.recheckable())) {
        return yield* Effect.promise(async () => this.wake({ channelOrigin: this.channelOrigin() }));
      } else {
        yield* this.watchZone();
      }

      const retain = yield* Effect.promise(async () => this.ctx.storage.get<number>(RETAIN_KEY));

      if (retain !== undefined && retain <= now) return yield* Effect.promise(async () => this.deleteSelf('deploy.run_retired'));
      yield* Effect.promise(async () => this.arm());
    });
  }

  /** Paused on a prerequisite with the grant still held. */
  private async recheckable(): Promise<boolean> {
    return await this.pause() !== null && await this.authorized() && await this.ctx.storage.get(INPUTS_KEY) !== undefined;
  }

  /** Live on workers.dev with a zone pending: once Cloudflare calls the zone active, the same plan runs again with the
   *  host as the address, which moves the deployment onto it. A refused read is asked again at the next tick. */
  private watchZone(): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const plan = yield* Effect.promise(async () => this.plan());
      const live = (yield* Effect.promise(async () => this.runState())) === 'done';

      if (plan === null || plan.pending === null || !live || !(yield* Effect.promise(async () => this.authorized()))) return;
      const pending = plan.pending;
      const token = yield* heard(this.accessToken());

      if ('words' in token) return;
      const zone = yield* heard(zoneHeld(bearerTransport(token.answer), pending.zoneId));

      if ('words' in zone || zone.answer.status !== 'active') return;

      const moved: DeployRunPlan = {
        ...plan, kind: 'change', pending: null,
        inputs: { ...plan.inputs, address: { kind: 'zone', hostname: pending.host, zoneId: pending.zoneId } },
      };

      this.sql.exec(`DELETE FROM deploy_step`);
      yield* Effect.promise(async () => this.ctx.storage.put(PLAN_KEY, JSON.stringify(moved)));
      yield* Effect.promise(async () => this.ctx.storage.put(INPUTS_KEY, JSON.stringify(moved.inputs)));
      yield* Effect.promise(async () => this.wake({ channelOrigin: this.channelOrigin() }));
      diagnostics.event('deploy.zone_active', { run: yield* Effect.promise(async () => this.runId()), zone: pending.zoneId });
    });
  }

  /** The stored intent rather than a field: an in-memory flag is lost by the eviction that makes
   *  resuming necessary. */
  private async going(): Promise<boolean> {
    return await this.ctx.storage.get<string>(INTENT_KEY) !== undefined;
  }

  /** `Date.now()` rather than `0`: workerd rejects a non-positive alarm time
   *  (measured 2026-09-18 on `@cloudflare/workerd-linux-64`). */
  private async wake(intent: DeployIntent): Promise<void> {
    await this.ctx.storage.put(INTENT_KEY, JSON.stringify(intent));
    await this.ctx.storage.put(RUN_STATE_KEY, 'running');
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** The person acted: the grant may be held for another hour from now. */
  private async armExpiry(): Promise<void> {
    await this.ctx.storage.put(GRANT_UNTIL_KEY, this.now() + VAULT_TTL_MS);
    await this.arm();
  }

  /**
   * The one timer slot, when no plan awaits it (arming then would drop the run): the soonest of the sign-in's end, the
   * grant's hour, a paused or waiting run's next look, and the retention's end.
   */
  private async arm(): Promise<void> {
    if (await this.going()) return;
    const now = this.now();
    const plan = await this.plan();
    const holds = await this.authorized();
    const waiting = (plan?.pending ?? null) !== null && await this.runState() === 'done';
    const looks = holds && (await this.pause() !== null || waiting) ? now + RECHECK_MS : undefined;

    const due = [
      await this.ctx.storage.get<number>(SESSION_UNTIL_KEY),
      await this.ctx.storage.get<number>(GRANT_UNTIL_KEY),
      await this.ctx.storage.get<number>(RETAIN_KEY),
      looks,
    ].filter((at): at is number => at !== undefined);

    if (due.length === 0) {
      await this.ctx.storage.deleteAlarm();

      return;
    }

    // In the run's own clock: a probe that moved it forward fires the alarm itself.
    await this.ctx.storage.setAlarm(Date.now() + Math.max(0, Math.min(...due) - now));
  }

  /**
   * The end of the grant's hour.
   *
   * The person's access and refresh tokens are gone, and the run says so: the
   * page offers signing in again rather than a ledger that cannot move, and a
   * fresh grant carries on from the step it stopped at. What the run minted
   * stays with it, for the retention's seven days. A self-update keeps
   * `OWN_KEY`. A door object that never got as far as a single step deletes
   * itself outright — `POST /api/deploy/runs` is public, so an object per probe
   * is the shape this bounds. True when the object is gone.
   */
  private async expire(): Promise<boolean> {
    const run = await this.runId();
    const own = await this.ctx.storage.get<string>(RECORD_KEY) !== undefined;
    const dropped = GRANT_KEYS.filter((key) => !own || !OWN_KEY.includes(key));

    await this.ctx.storage.delete([...dropped, GRANT_UNTIL_KEY, HANDED_KEY]);

    if (!own && this.rows().length === 0 && await this.plan() === null) {
      await this.deleteSelf('deploy.run_dropped');

      return true;
    }

    if (await this.runState() !== 'done') await this.ctx.storage.put(RUN_STATE_KEY, 'expired');
    diagnostics.event('deploy.run_expired', { run, secrets: dropped.length });
    await this.broadcast();

    return false;
  }

  private async deleteSelf(event: `deploy.${string}`): Promise<void> {
    const run = await this.runId();

    await this.ctx.storage.deleteAll();
    this.initSchema();
    diagnostics.event(event, { run });
  }

  /**
   * A live access token for this run.
   *
   * Cloudflare's access tokens last about an hour and a plan can be retried
   * long after the person walked away, so an expiry in the past is a refresh
   * rather than a step that fails with 401. The rotated pair lands the moment
   * it exists, as in `selfUpdate`. Never once the handover gave the refresh
   * token to the deployment: spending it would leave the deployment a spent one.
   */
  private accessToken(): Effect.Effect<string, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const held = yield* Effect.promise(async () => this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`));

      if (held === undefined) return yield* new KinuError('denied', 'this run holds no Cloudflare authorization');
      const expiresAt = (yield* Effect.promise(async () => this.ctx.storage.get<number>(TOKEN_EXPIRES_KEY))) ?? 0;

      if (expiresAt === 0 || expiresAt > this.now() + TOKEN_FLOOR_MS) return held;

      if ((yield* Effect.promise(async () => this.ctx.storage.get<boolean>(HANDED_KEY))) === true) {
        return yield* new KinuError('denied', 'this run handed its refresh token to the deployment and will not spend it');
      }

      const clientId = yield* Effect.promise(async () => this.ctx.storage.get<string>(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`));
      const refreshToken = yield* Effect.promise(async () => this.ctx.storage.get<string>(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`));

      if (clientId === undefined || refreshToken === undefined) return held;
      const minted = yield* Effect.promise(async () => refreshDeployToken({ clientId, refreshToken }));

      yield* Effect.promise(async () => this.holdGrant({
        clientId, accessToken: minted.accessToken, refreshToken: minted.refreshToken,
        expiresAt: minted.expiresInSeconds === 0 ? 0 : this.now() + minted.expiresInSeconds * 1000,
      }));

      return minted.accessToken;
    });
  }

  private drive(inputs: DeployInputs, channelOrigin: string, update: boolean): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const token = yield* heard(this.accessToken());
      const run = yield* Effect.promise(async () => this.runId());

      // No grant, or Cloudflare refused its renewal: the run waits for the person to sign in again.
      if ('words' in token) {
        yield* Effect.promise(async () => this.signedOut(token.words.code === undefined ? SIGN_IN_AGAIN_NEED : { ...SIGN_IN_AGAIN_NEED, details: token.words }));

        return;
      }

      const plan = yield* Effect.promise(async () => this.plan());
      const manifest = yield* Effect.promise(async () => fetchReleaseManifest(channelOrigin));
      const ran = (yield* Effect.promise(async () => this.ctx.storage.get<string>(VERSION_KEY))) ?? '';

      // A ledger belongs to one release: the self-update object has a fixed id, so a new version must
      // reset rows or `runDeployPlan` would skip everything as done. A resume keeps them.
      if (ran !== '' && ran !== manifest.version) this.sql.exec(`DELETE FROM deploy_step`);

      yield* Effect.promise(async () => this.ctx.storage.put(VERSION_KEY, manifest.version));
      yield* Effect.promise(async () => this.ctx.storage.put(RUN_STATE_KEY, 'running'));

      const outcome = yield* Effect.promise(async () => runDeployPlan(
        deployPlan(manifest, inputs),
        {
          manifest,
          inputs,
          transport: bearerTransport(token.answer),
          artifact: fetchedOnWalk(async () => fetchReleaseArtifact(manifest, channelOrigin)),
          vault: this.vault(),
          seat: { hold: async (link, expiresAt) => { await this.ctx.storage.put(SEAT_KEY, { link, expiresAt }); } },
          // A change or an update of a Kinu the page found keeps its root secrets, as a self-update does.
          update: update || (plan !== null && plan.kind !== 'new'),
          freshSetupLink: plan?.freshSetupLink ?? false,
          tag: `${run}.${manifest.version}.${sha256Hex(JSON.stringify(inputs)).slice(0, 16)}`.slice(0, 100),
          facts: factsFrom(this.rows()),
          http: (url, headers) => fetch(url, { headers }),
          note: () => undefined,
        },
        this.ledger(),
        (progress) => this.deliver(run, { type: 'deploy.progress', progress }),
      ));

      yield* Effect.promise(async () => this.ctx.storage.put(RUN_STATE_KEY, outcome.state));
      yield* Effect.promise(async () => this.settled(outcome, inputs.accountId));
      yield* Effect.promise(async () => this.broadcast());
    });
  }

  /**
   * What the plan's end means for the grant's hour. A page run stopped by a prerequisite pauses on it: the hour starts
   * at the first pause and a re-check that is refused again does not extend it. Anything else starts the hour now.
   */
  private async settled(outcome: DeployRunOutcome, account: string): Promise<void> {
    const prior = await this.pause();
    const failure = outcome.rows.find((row) => row.id === outcome.failedAt)?.failure ?? null;
    const judged = failure === null ? null : judgeRefusal(failureWords(failure), account);
    const paging = await this.ctx.storage.get<string>(OWNER_KEY) !== undefined;
    await this.ctx.storage.put(RETAIN_KEY, this.now() + RETAIN_MS);

    if (paging && judged !== null && 'need' in judged && outcome.failedAt !== null) {
      const again = prior !== null && prior.step === outcome.failedAt;

      await this.ctx.storage.put(PAUSE_KEY, { need: judged.need, step: outcome.failedAt, since: again ? prior.since : this.now() });

      if (!again) await this.ctx.storage.put(GRANT_UNTIL_KEY, this.now() + VAULT_TTL_MS);

      return;
    }

    await this.ctx.storage.delete(PAUSE_KEY);

    if (await this.authorized()) await this.ctx.storage.put(GRANT_UNTIL_KEY, this.now() + VAULT_TTL_MS);
  }

  private async signedOut(need: DeployNeed): Promise<void> {
    const prior = await this.pause();
    const step = this.rows().find((row) => row.state !== 'done')?.id ?? '';

    await this.ctx.storage.put(RUN_STATE_KEY, 'expired');

    if (await this.ctx.storage.get<string>(OWNER_KEY) !== undefined) {
      await this.ctx.storage.put(PAUSE_KEY, { need, step, since: prior?.since ?? this.now() });
    }

    await this.broadcast();
  }

  /** The record's channel for a self-update: a deployment's own origin publishes no channel. */
  private channelOrigin(): string {
    return this.env.CLI_PUBLIC_ORIGIN ?? 'https://kinu.run';
  }

  /** No read-through to `env`: an update keeps live secrets via `keep_bindings` (`steps.ts versionMetadata`). A handover
   *  with a zone still pending keeps the grant to watch it, and from then on never refreshes it (`accessToken`). */
  protected vault(): DeploySecretVault {
    return {
      read: async (name: string) => await this.ctx.storage.get<string>(`${SECRET_PREFIX}${name}`) ?? null,
      write: async (name: string, value: string) => {
        await this.ctx.storage.put(`${SECRET_PREFIX}${name}`, value);
      },
      names: async () => {
        const held = await this.ctx.storage.list<string>({ prefix: SECRET_PREFIX });

        return [...held.keys()].map((key) => key.slice(SECRET_PREFIX.length));
      },
      wipe: async () => {
        const held = await this.ctx.storage.list<string>({ prefix: SECRET_PREFIX });
        const watching = ((await this.plan())?.pending ?? null) !== null;
        const wiped = [...held.keys()].filter((key) => !watching || !GRANT_KEYS.includes(key));

        await this.ctx.storage.delete(wiped);

        if (watching) await this.ctx.storage.put(HANDED_KEY, true);
        else await this.ctx.storage.delete(GRANT_UNTIL_KEY);
        diagnostics.event('deploy.secrets_wiped', { run: await this.runId(), count: wiped.length });
      },
    };
  }

  private ledger(): DeployLedger {
    return {
      rows: async () => this.rows(),
      seed: async (steps: readonly DeployStepSeed[]) => {
        for (const step of steps) {
          this.sql.exec(
            `INSERT INTO deploy_step (id, seq, title, state) VALUES (?, ?, ?, 'pending')
             ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, title = excluded.title`,
            step.id, step.seq, step.title,
          );
        }
      },
      started: async (id: string, attempt: number) => {
        this.sql.exec(`UPDATE deploy_step SET state = 'running', attempt = ?, failure = NULL WHERE id = ?`, attempt, id);
        await this.broadcast();
      },
      noted: (id: string, note: string) => {
        const row = this.sql.exec<{ notes: string }>(`SELECT notes FROM deploy_step WHERE id = ?`, id).toArray()[0];
        const notes = row === undefined ? [] : v.parse(NotesSchema, JSON.parse(row.notes));

        this.sql.exec(`UPDATE deploy_step SET notes = ? WHERE id = ?`, JSON.stringify([...notes, note]), id);
      },
      settled: async (id: string, detail: string, facts: Readonly<Record<string, string>>) => {
        this.sql.exec(
          `UPDATE deploy_step SET state = 'done', detail = ?, facts = ?, failure = NULL WHERE id = ?`,
          detail, JSON.stringify(facts), id,
        );

        // The step a pause waited on went through: Cloudflare says the prerequisite is met.
        if ((await this.pause())?.step === id) await this.ctx.storage.delete(PAUSE_KEY);
        await this.broadcast();
      },
      failed: async (id: string, failure: DeployStepFailure) => {
        this.sql.exec(`UPDATE deploy_step SET state = 'failed', failure = ? WHERE id = ?`, JSON.stringify(failure), id);
        await this.broadcast();
      },
    };
  }

  private rows(): readonly DeployStepRow[] {
    return this.sql.exec<StepRecord>(`SELECT * FROM deploy_step ORDER BY seq`).toArray().map((row) => ({
      id: row.id,
      seq: row.seq,
      title: row.title,
      state: v.parse(StateSchema, row.state),
      attempt: row.attempt,
      detail: row.detail,
      notes: v.parse(NotesSchema, JSON.parse(row.notes)),
      failure: row.failure === null ? null : v.parse(FailureSchema, JSON.parse(row.failure)),
      facts: v.parse(FactsSchema, JSON.parse(row.facts)),
    }));
  }

  private async runId(): Promise<string> {
    return await this.ctx.storage.get<string>(RUN_ID_KEY) ?? '';
  }

  private async runState(): Promise<DeploySnapshot['state']> {
    const held = await this.ctx.storage.get<string>(RUN_STATE_KEY) ?? 'collecting';

    return v.parse(DeployRunPhaseSchema, held);
  }

  private async accept(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation: an object evicted between steps must not take the page's socket with it.
    this.ctx.acceptWebSocket(server, [`run:${new URL(request.url).pathname}`]);
    // Awaited: the first frame is the whole state; otherwise the page renders an empty ledger.
    await this.sendSnapshot(server);

    // The run key rides as the second subprotocol; select the first so the key is not echoed.
    const named = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',').map((token) => token.trim()).includes(DEPLOY_SOCKET_PROTOCOL);

    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

    if (named) init.headers = { 'sec-websocket-protocol': DEPLOY_SOCKET_PROTOCOL };

    return new Response(null, init);
  }

  override async webSocketMessage(): Promise<void> {
    // The page never sends; answering would be an unauthenticated write surface on a public socket.
  }

  /** The only place a send happens. A socket whose browser left throws on `send`; unguarded, that
   *  would strand the plan mid-step with the vault still full. */
  private deliver(run: string, frame: DeployFrame | DeployRunFrame, only: WebSocket | null = null): void {
    const body = JSON.stringify(frame);

    for (const socket of only === null ? this.ctx.getWebSockets() : [only]) {
      try {
        socket.send(body);
      } catch (cause) {
        diagnostics.event('deploy.frame_undelivered', {
          run, frame: frame.type, error: renderThrownChain({ cause }),
        });
      }
    }
  }

  /** The ledger as the CLI reads it, then the same moment as the page reads it. */
  private async broadcast(): Promise<void> {
    await this.sendSnapshot(null);
  }

  /** A page that connected mid-run renders the ledger it missed. */
  private async sendSnapshot(socket: WebSocket | null): Promise<void> {
    const snapshot = await this.snapshot();

    this.deliver(snapshot.runId, { type: 'deploy.snapshot', snapshot }, socket);
    this.deliver(snapshot.runId, { type: 'deploy.run', run: await this.runView() }, socket);
  }
}
