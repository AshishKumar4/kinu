/**
 * DeployRunDO — one guided deployment, from the first answer to the moment it
 * holds no secret.
 *
 * WHY A DURABLE OBJECT PER RUN. A run is a sequence of writes to somebody
 * else's Cloudflare account that takes minutes, and the page in front of it is
 * a browser tab that can close. The object is the run's memory: every step is a
 * row, so a reload re-renders what already happened, and an eviction in the
 * middle of a step leaves that row `running` and the next activation does it
 * again — which is safe because the steps look before they create.
 *
 * THE ALARM IS THE RUNNER. `start` and `selfUpdate` write down what to run and
 * return at once; `alarm()` is where every step actually happens. Three things
 * fall out of that and none of them needed its own mechanism: a caller is never
 * held for the length of a deployment, a handler the runtime could not finish
 * is redelivered — which is how a run survives an eviction, and how a
 * self-update survives the restart its own upload causes — and the same timer,
 * with no plan to run, is the vault's clock.
 *
 * WHAT IT HOLDS AND FOR HOW LONG. The person's access and refresh tokens, their
 * provider keys and the two minted root secrets live in the object's key-value
 * storage, never in a SQL row and never in a frame. The last step writes the
 * refresh token into the new Worker as its own secret and wipes the lot; from
 * then on the deployment owns its key and kinu.run holds nothing. A run that
 * stops moving for an hour loses them to the alarm instead, because a tab
 * somebody closed must not leave their account writable from here.
 *
 * WHAT THE KEY IS FOR. The door is public, so the run key is the whole of the
 * authorization: 192 bits minted at creation, presented on every call and on
 * the socket upgrade, compared against its digest. Storage holds the digest.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  ACCESS_TOKEN_KEY, DEPLOYMENT_REFRESH_SECRET, DEPLOY_CLIENT_ID_KEY, DEPLOY_SOCKET_PROTOCOL,
  DeployInputsSchema, DeployRunPhaseSchema, DeployStepRowSchema, DeploymentRecordSchema,
  FACT_ADDRESS, REFRESH_TOKEN_KEY, SELF_UPDATE_RUN_ID,
  bearerTransport, cloudflareResult, deployPlan, exchangeDeployCode, factsFrom,
  fetchReleaseArtifact, fetchReleaseManifest, refreshDeployToken, runDeployPlan, runKeyAdmits,
  type DeployChoice, type DeployFrame, type DeployInputs, type DeployLedger,
  type DeploySecretVault, type DeploySnapshot, type DeployStepFailure,
  type DeployStepRow, type DeployStepSeed, type DeploymentRecord,
} from '@kinu.run/core/deploy';
import { randomToken } from '@kinu.run/core';
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';
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

/** One thing a person may choose, as the Cloudflare API answers it: an account
 *  to deploy into, or a zone to bind a hostname in. */
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

/** The release version this run installs, settled when the run read the
 *  channel — the page shows it while the steps are still going. */
const VERSION_KEY = 'run.version';

const SECRET_PREFIX = 'secret.';

/** The state nonce, in bytes. 128 bits of CSPRNG beside the run id, so a
 *  `state` is not guessable by somebody who knows which run is authorizing. */
const NONCE_BYTES = 16;

/** What the alarm is holding: a plan to run, and where its release comes from.
 *  Durable, because the activation that wrote it is often not the one that
 *  runs it. */
const IntentSchema = v.object({
  kind: v.picklist(['guided', 'update']),
  channelOrigin: v.pipe(v.string(), v.minLength(1)),
});

type DeployIntent = v.InferOutput<typeof IntentSchema>;

const INTENT_KEY = 'run.intent';

/** The deployment's own record, for an update: what to re-run, and where to
 *  write the rotated refresh token. */
const RECORD_KEY = 'run.record';

/** When the stored access token stops working. Not a secret, so not under the
 *  `secret.` prefix — the wipe takes the token and this is left as a fact
 *  about a token that is gone. */
const TOKEN_EXPIRES_KEY = 'run.token_expires_at';

/**
 * How long a run may hold a person's Cloudflare tokens without moving.
 *
 * A run is resumable for as long as it holds them, which is why this is an
 * hour rather than minutes: a person who hits "R2 needs a payment method"
 * fixes that in another tab and retries. Past it, the tokens are the only
 * thing left of a sitting nobody finished, and a lost tab must not leave an
 * account writable from here.
 */
const VAULT_TTL_MS = 3_600_000;

/** How much life an access token must have left to be worth using. A minute:
 *  a plan's next call must not land on the far side of the expiry. */
const TOKEN_FLOOR_MS = 60_000;

export class DeployRunDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initSchema();
  }

  /** The ledger's one table. Idempotent, and called again after `deleteAll` —
   *  which drops the table under a still-live activation. */
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

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.accept(request);
    }

    return new Response('not a deploy socket', { status: 400 });
  }

  /** Created before anything else exists: the run's key digest is written here
   *  and the key itself is returned to the caller once, by the route. The
   *  expiry alarm starts now, so an object minted by a probe that never comes
   *  back deletes itself rather than sitting in the namespace forever. */
  async open(runId: string, keyDigest: string): Promise<void> {
    await this.ctx.storage.put(RUN_ID_KEY, runId);
    await this.ctx.storage.put(KEY_DIGEST_KEY, keyDigest);
    await this.ctx.storage.put(RUN_STATE_KEY, 'collecting');
    await this.armExpiry();
  }

  async admits(runKey: string): Promise<boolean> {
    return runKeyAdmits(runKey, await this.ctx.storage.get<string>(KEY_DIGEST_KEY) ?? '');
  }

  /**
   * Start an authorization leg and answer with its `state`.
   *
   * The verifier stays here: it is the proof a public client has, and a
   * verifier that travelled would make the PKCE exchange forgeable by whoever
   * saw it. The state is the run's name and a nonce this object keeps, so a
   * callback carrying somebody else's state is refused rather than exchanged;
   * the route binds the same state to the browser that asked for it.
   */
  async holdAuthorization(verifier: string): Promise<string> {
    const state = `${await this.runId()}.${randomToken(NONCE_BYTES)}`;

    await this.ctx.storage.put(VERIFIER_KEY, verifier);
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.put(RUN_STATE_KEY, 'authorizing');

    return state;
  }

  /**
   * The code, exchanged for this run's own leg.
   *
   * False rather than a throw for the two ways a callback is not this run's —
   * no leg in flight, or a state that is not the one minted here. Both are a
   * stranger's callback URL arriving at a route, which is a 400 and not a
   * crash; the exchange itself still throws, because a refusal from the
   * authorization server is the sentence a person has to read.
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

  /** The token pair, however it was obtained: the page's callback exchanges the
   *  code here, and `kinu deploy cloudflare` exchanges it on its own localhost
   *  redirect and hands the pair over. One run, one ledger, two doors.
   *
   *  The client id rides with the pair because the last step writes it into the
   *  deployment: a refresh names its client, and the two doors authorize
   *  against the same one. The lifetime rides with it because a run retried an
   *  hour later must renew the token rather than fail every step with a 401.
   */
  async landToken(
    clientId: string,
    accessToken: string,
    refreshToken: string,
    expiresInSeconds: number,
  ): Promise<void> {
    await this.ctx.storage.put(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`, clientId);
    await this.ctx.storage.put(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`, accessToken);
    await this.ctx.storage.put(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`, refreshToken);
    await this.ctx.storage.put(TOKEN_EXPIRES_KEY, expiresInSeconds === 0 ? 0 : Date.now() + expiresInSeconds * 1000);

    // A leg that just landed leaves the run collecting answers; a refresh in
    // the middle of a plan must not send the page back to the form.
    if (await this.runState() === 'authorizing') await this.ctx.storage.put(RUN_STATE_KEY, 'collecting');
    await this.armExpiry();
  }

  async authorized(): Promise<boolean> {
    return await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`) !== undefined;
  }

  /** Provider keys the person supplied. Written straight into the vault, never
   *  into the inputs row, because the row is readable for the run's lifetime. */
  async holdProviderKey(name: string, value: string): Promise<void> {
    await this.ctx.storage.put(`${SECRET_PREFIX}${name}`, value);
    await this.armExpiry();
  }

  /** The accounts this authorization can deploy into, and the zones it can
   *  bind a hostname in. Read with the run's own token and never stored: the
   *  answers are the person's to pick from, not this run's to keep. */
  async accounts(): Promise<readonly DeployChoice[]> {
    return this.choices('/accounts?per_page=50');
  }

  async zones(): Promise<readonly DeployChoice[]> {
    return this.choices('/zones?per_page=50');
  }

  async snapshot(): Promise<DeploySnapshot> {
    const steps = this.rows();
    const facts = factsFrom(steps);

    return {
      runId: await this.runId(),
      state: await this.runState(),
      address: facts.get(FACT_ADDRESS) ?? '',
      version: await this.ctx.storage.get<string>(VERSION_KEY) ?? '',
      steps,
    };
  }

  /** One question answered with the run's token: the id and name of each thing
   *  the person may choose. A refusal reaches the caller as it came. */
  private async choices(path: string): Promise<readonly DeployChoice[]> {
    return cloudflareResult(bearerTransport(await this.accessToken()), { method: 'GET', path }, ChoicesSchema);
  }

  /**
   * Start the run, or answer the one that is already going.
   *
   * THE PLAN DOES NOT RUN IN THIS CALL. A deployment is minutes of network
   * writes and the caller is a browser tab or a terminal; what this does is
   * record what to run and wake the object's alarm, which is also what makes
   * a run survive the thing it cannot avoid — the object being evicted, or
   * restarted by the very deployment it is performing. The runtime redelivers
   * an alarm whose handler did not finish, and the steps look before they
   * create, so a redelivery carries on rather than starting again.
   *
   * Answers parsed BEFORE they are stored, and refused while a plan is going:
   * a second `start` with a different instance name would otherwise change
   * what the remaining steps deploy.
   */
  async start(inputs: DeployInputs): Promise<DeploySnapshot> {
    const parsed = v.parse(DeployInputsSchema, inputs);

    if (await this.going()) return this.snapshot();

    await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(parsed));
    await this.wake({ kind: 'guided', channelOrigin: this.channelOrigin() });

    return this.snapshot();
  }

  /** Retry one failed step: the row goes back to pending and the plan runs
   *  again, which re-enters at exactly that step because everything before it
   *  is `done`. */
  async retry(stepId: string): Promise<DeploySnapshot> {
    if (await this.going()) return this.snapshot();
    const inputs = await this.ctx.storage.get<string>(INPUTS_KEY);

    if (inputs === undefined) return this.snapshot();
    this.sql.exec(`UPDATE deploy_step SET state = 'pending', failure = NULL WHERE id = ? AND state = 'failed'`, stepId);

    const record = await this.ctx.storage.get<string>(RECORD_KEY);

    await this.wake(record === undefined
      ? { kind: 'guided', channelOrigin: this.channelOrigin() }
      : { kind: 'update', channelOrigin: v.parse(DeploymentRecordSchema, JSON.parse(record)).channelOrigin });

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
   * names rather than this Worker's own origin.
   *
   * THE GRANT IS SPENT HERE AND PERSISTED HERE. Cloudflare rotates the refresh
   * token on every refresh, so the pair this call receives is the only one that
   * will ever work again: it goes into the Worker's own secret immediately,
   * before a single step runs. Written by the last step instead, any failure in
   * between — or the restart this deployment's own upload causes — would leave
   * the Worker holding a spent token and self-update dead for good.
   *
   * The token it spends is the deployment's own when this object holds a newer
   * one than `env` does, which is exactly the retry after a half-finished
   * update: `env` still carries the token the first attempt already spent.
   */
  async selfUpdate(record: DeploymentRecord, refreshToken: string): Promise<DeploySnapshot> {
    await this.ctx.storage.put(RUN_ID_KEY, SELF_UPDATE_RUN_ID);

    if (await this.going()) return this.snapshot();

    const held = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`);
    const token = await refreshDeployToken({ clientId: record.clientId, refreshToken: held ?? refreshToken });

    await this.landToken(record.clientId, token.accessToken, token.refreshToken, token.expiresInSeconds);
    await this.persistRefreshToken(record, token.accessToken, token.refreshToken);
    await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(record.inputs));
    await this.ctx.storage.put(RECORD_KEY, JSON.stringify(record));
    await this.wake({ kind: 'update', channelOrigin: record.channelOrigin });

    return this.snapshot();
  }

  /**
   * The object's one timer, doing both of its jobs.
   *
   * An intent is a plan to run: this is where every deployment actually
   * happens, and a handler that did not finish is redelivered by the runtime,
   * which is how a run resumes after an eviction or after its own upload
   * replaced the Worker hosting it. No intent means the timer is the vault's:
   * a run that has held somebody's Cloudflare tokens for an hour without
   * moving loses them.
   */
  override async alarm(): Promise<void> {
    const intent = await this.ctx.storage.get<string>(INTENT_KEY);

    if (intent === undefined) {
      await this.expire();

      return;
    }

    const held = v.parse(IntentSchema, JSON.parse(intent));
    const record = await this.ctx.storage.get<string>(RECORD_KEY);
    const inputs = await this.ctx.storage.get<string>(INPUTS_KEY);

    if (inputs === undefined) {
      await this.ctx.storage.delete(INTENT_KEY);

      return;
    }

    await this.drive(v.parse(DeployInputsSchema, JSON.parse(inputs)), held.channelOrigin, record !== undefined);

    // Only after the plan settled: an intent still stored is a plan the next
    // alarm must carry on with.
    await this.ctx.storage.delete(INTENT_KEY);
    await this.armExpiry();
  }

  /** Whether a plan is between its first step and its outcome. The stored
   *  intent rather than a field: an in-memory flag is lost by the eviction that
   *  makes resuming necessary, and two activations must not drive one plan. */
  private async going(): Promise<boolean> {
    return await this.ctx.storage.get<string>(INTENT_KEY) !== undefined;
  }

  /** Record what to run and hand it to the alarm.
   *
   *  `Date.now()` rather than `0`: workerd refuses a non-positive alarm time
   *  outright — `TypeError: setAlarm() cannot be called with an alarm time <= 0`,
   *  measured 2026-09-18 on `@cloudflare/workerd-linux-64` through
   *  `vitest-pool-workers` — and a time already past fires as soon as the
   *  runtime can, which is after this call has answered. */
  private async wake(intent: DeployIntent): Promise<void> {
    await this.ctx.storage.put(INTENT_KEY, JSON.stringify(intent));
    await this.ctx.storage.put(RUN_STATE_KEY, 'running');
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** The vault's clock, restarted. Never while a plan is waiting for the alarm:
   *  the object has one timer slot, and arming the expiry over a pending run
   *  would drop the run instead of starting it. */
  private async armExpiry(): Promise<void> {
    if (await this.going()) return;

    await this.ctx.storage.setAlarm(Date.now() + VAULT_TTL_MS);
  }

  /**
   * The end of a run nobody finished.
   *
   * A person's access and refresh tokens, their provider keys and the minted
   * root secrets are gone, and the run says so: the page offers signing in
   * again rather than a ledger that cannot move. An object that never got as
   * far as a single step deletes itself outright — `POST /api/deploy/runs` is
   * public, so an object per probe is the shape this bounds.
   */
  private async expire(): Promise<void> {
    const held = await this.ctx.storage.list<string>({ prefix: SECRET_PREFIX });
    const run = await this.runId();

    await this.ctx.storage.delete([...held.keys()]);

    if (this.rows().length === 0) {
      await this.ctx.storage.deleteAll();
      this.initSchema();
      diagnostics.event('deploy.run_dropped', { run, secrets: held.size });

      return;
    }

    await this.ctx.storage.put(RUN_STATE_KEY, 'expired');
    diagnostics.event('deploy.run_expired', { run, secrets: held.size });
    await this.broadcast();
  }

  /**
   * A live access token for this run.
   *
   * Cloudflare's access tokens last about an hour and a plan can be retried
   * long after the person walked away, so an expiry in the past is a refresh
   * rather than a step that fails with 401. The rotated pair is persisted the
   * moment it exists, for the same reason `selfUpdate` persists its own.
   */
  private async accessToken(): Promise<string> {
    const held = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`);

    if (held === undefined) throw new Error('this run holds no Cloudflare authorization');
    const expiresAt = await this.ctx.storage.get<number>(TOKEN_EXPIRES_KEY) ?? 0;

    if (expiresAt === 0 || expiresAt > Date.now() + TOKEN_FLOOR_MS) return held;

    const clientId = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`);
    const refreshToken = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`);

    if (clientId === undefined || refreshToken === undefined) return held;
    const minted = await refreshDeployToken({ clientId, refreshToken });

    await this.landToken(clientId, minted.accessToken, minted.refreshToken, minted.expiresInSeconds);
    const record = await this.ctx.storage.get<string>(RECORD_KEY);

    if (record !== undefined) {
      await this.persistRefreshToken(
        v.parse(DeploymentRecordSchema, JSON.parse(record)), minted.accessToken, minted.refreshToken,
      );
    }

    return minted.accessToken;
  }

  /** The rotated refresh token, into the deployment that owns it. Only an
   *  update has somewhere to put it: a guided run's Worker does not exist yet,
   *  and the handover step is what gives it its first one. */
  private async persistRefreshToken(record: DeploymentRecord, accessToken: string, refreshToken: string): Promise<void> {
    await cloudflareResult(
      bearerTransport(accessToken),
      {
        method: 'PUT',
        path: `/accounts/${record.inputs.accountId}/workers/scripts/${record.inputs.instanceName}/secrets`,
        body: { name: DEPLOYMENT_REFRESH_SECRET, text: refreshToken, type: 'secret_text' },
      },
      v.object({ name: v.optional(v.string()) }),
    );
  }

  private async drive(inputs: DeployInputs, channelOrigin: string, update: boolean): Promise<void> {
    const token = await this.accessToken();
    const run = await this.runId();

    // The release this deployment gets, read through the one channel reader
    // every door uses: the manifest, and the artifact it names verified
    // against the digest the channel publishes.
    const manifest = await fetchReleaseManifest(channelOrigin);
    const artifact = await fetchReleaseArtifact(manifest, channelOrigin);
    const ran = await this.ctx.storage.get<string>(VERSION_KEY) ?? '';

    // A LEDGER BELONGS TO ONE RELEASE. `runDeployPlan` skips what is `done`,
    // which is exactly right for a resume and exactly wrong for the next
    // version: the self-update object is addressed by a fixed id, so a second
    // release over a finished ledger would upload nothing and report done. The
    // rows are keyed by nothing but this object, so the reset is here — where
    // the version the channel publishes is finally known — and a resume, whose
    // version is the one already recorded, keeps every row it had.
    if (ran !== '' && ran !== manifest.version) this.sql.exec(`DELETE FROM deploy_step`);

    await this.ctx.storage.put(VERSION_KEY, manifest.version);
    await this.ctx.storage.put(RUN_STATE_KEY, 'running');

    const outcome = await runDeployPlan(
      deployPlan(manifest, inputs),
      {
        manifest,
        inputs,
        transport: bearerTransport(token),
        artifact,
        vault: this.vault(),
        update,
        facts: factsFrom(this.rows()),
        http: (url: string) => fetch(url),
        note: () => undefined,
      },
      this.ledger(),
      (progress) => this.deliver(run, { type: 'deploy.progress', progress }),
    );

    await this.ctx.storage.put(RUN_STATE_KEY, outcome.state);
    await this.broadcast();
  }

  /** Where a run pulls its release from. This Worker's own origin for a guided
   *  run on kinu.run; the channel the record names for a self-update, because a
   *  deployment's own origin publishes no channel. */
  private channelOrigin(): string {
    return this.env.CLI_PUBLIC_ORIGIN ?? 'https://kinu.run';
  }

  /**
   * The run's secret material, and nothing else's.
   *
   * No read-through to this Worker's own bindings. An update keeps the secrets
   * it is already running with through `keep_bindings` on the version upload
   * (`steps.ts versionMetadata`), so a name this object does not hold is a name
   * this run has no business sending: copying live secrets out of `env` into an
   * upload payload was only ever compensating for a binding list that dropped
   * them.
   */
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

        await this.ctx.storage.delete([...held.keys()]);
        diagnostics.event('deploy.secrets_wiped', { run: await this.runId(), count: held.size });
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

    // Hibernation, not a held reference: a run is minutes of network calls and
    // a page that may sit open through all of it, and an object evicted between
    // two steps must not take the page's socket with it.
    this.ctx.acceptWebSocket(server, [`run:${new URL(request.url).pathname}`]);
    // Awaited, not fired: the first frame is this run's whole state, and a
    // page that got the 101 before the snapshot was queued would render an
    // empty ledger until the next change.
    await this.sendSnapshot(server);

    // The upgrade carried the run key as its second subprotocol token, so the
    // 101 selects the FIRST one — the name. Echoing the key would put it in a
    // response header for nothing.
    const named = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',').map((token) => token.trim()).includes(DEPLOY_SOCKET_PROTOCOL);

    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

    if (named) init.headers = { 'sec-websocket-protocol': DEPLOY_SOCKET_PROTOCOL };

    return new Response(null, init);
  }

  override async webSocketMessage(): Promise<void> {
    // The page never sends: it asks over HTTP and watches here. A frame from
    // the browser is not a protocol this run has, and answering one would be
    // an unauthenticated write surface on a public socket.
  }

  /**
   * One frame to every socket this run has: the only place a send happens.
   *
   * A hibernated socket whose browser went away throws on `send`, and that is
   * a page navigating rather than anything about the deployment. Unguarded on
   * the progress path it took the plan with it: the throw left the runner
   * mid-step, so the row stayed `running`, the run state stayed `running`, and
   * the vault kept the person's tokens until somebody pressed start again.
   */
  private deliver(run: string, frame: DeployFrame, only: WebSocket | null = null): void {
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

  private async broadcast(): Promise<void> {
    const snapshot = await this.snapshot();

    this.deliver(snapshot.runId, { type: 'deploy.snapshot', snapshot });
  }

  /** The first frame a socket gets: this run's whole state, so a page that
   *  connected mid-run renders the ledger it missed. */
  private async sendSnapshot(socket: WebSocket): Promise<void> {
    const snapshot = await this.snapshot();

    this.deliver(snapshot.runId, { type: 'deploy.snapshot', snapshot }, socket);
  }
}
