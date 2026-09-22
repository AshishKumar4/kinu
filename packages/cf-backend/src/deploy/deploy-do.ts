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
 * somebody closed must not leave their account writable from here. A
 * self-update keeps its refresh token and client id past that hour: they are
 * the deployment's own key.
 *
 * WHAT THE KEY IS FOR. The door is public, so the run key is the whole of the
 * authorization: 192 bits minted at creation, presented on every call and on
 * the socket upgrade, compared against its digest. Storage holds the digest.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  ACCESS_TOKEN_KEY, DEPLOY_CLIENT_ID_KEY, DEPLOY_SOCKET_PROTOCOL,
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

/** An update's vault keys that the expiry leaves: the deployment's own key. */
const OWN_KEY: readonly string[] = [`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`, `${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`];

/** The state nonce, in bytes. 128 bits of CSPRNG beside the run id, so a
 *  `state` is not guessable by somebody who knows which run is authorizing. */
const NONCE_BYTES = 16;

/** Durable: the activation that writes the intent is often not the one that runs it. */
const IntentSchema = v.object({
  kind: v.picklist(['guided', 'update']),
  channelOrigin: v.pipe(v.string(), v.minLength(1)),
});

type DeployIntent = v.InferOutput<typeof IntentSchema>;

const INTENT_KEY = 'run.intent';

/** For an update: what to re-run, and where to write the rotated refresh token. */
const RECORD_KEY = 'run.record';

/** Not a secret, so not under the `secret.` prefix; the wipe leaves it. */
const TOKEN_EXPIRES_KEY = 'run.token_expires_at';

/** How long a run may hold tokens idle: an hour so a person can fix billing in another tab and retry. */
const VAULT_TTL_MS = 3_600_000;

/** A plan's next call must not land past the access token's expiry. */
const TOKEN_FLOOR_MS = 60_000;

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
    await this.ctx.storage.put(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`, clientId);
    await this.ctx.storage.put(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`, accessToken);
    await this.ctx.storage.put(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`, refreshToken);
    await this.ctx.storage.put(TOKEN_EXPIRES_KEY, expiresInSeconds === 0 ? 0 : Date.now() + expiresInSeconds * 1000);

    // A refresh in the middle of a plan must not send the page back to the form.
    if (await this.runState() === 'authorizing') await this.ctx.storage.put(RUN_STATE_KEY, 'collecting');
    await this.armExpiry();
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

  private async choices(path: string): Promise<readonly DeployChoice[]> {
    return cloudflareResult(bearerTransport(await this.accessToken()), { method: 'GET', path }, ChoicesSchema);
  }

  /**
   * Records the plan and wakes the alarm; the plan never runs in this call. Answers are parsed before
   * storing and refused while a plan is going, so a second `start` cannot change what remaining steps deploy.
   */
  async start(inputs: DeployInputs): Promise<DeploySnapshot> {
    const parsed = v.parse(DeployInputsSchema, inputs);

    if (await this.going()) return this.snapshot();

    await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(parsed));
    await this.wake({ kind: 'guided', channelOrigin: this.channelOrigin() });

    return this.snapshot();
  }

  /** Re-enters at exactly the failed step because everything before it is `done`. */
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
    await this.wake({ kind: 'update', channelOrigin: record.channelOrigin });

    return this.snapshot();
  }

  /** Runs the stored intent (redelivered if unfinished, so runs resume); with no intent, it is the
   *  vault expiry. */
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

    // Only after the plan settled: a stored intent is a plan the next alarm must carry on with.
    await this.ctx.storage.delete(INTENT_KEY);
    await this.armExpiry();
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

  /** Never while a plan awaits the alarm: one timer slot, and arming expiry would drop the run. */
  private async armExpiry(): Promise<void> {
    if (await this.going()) return;

    await this.ctx.storage.setAlarm(Date.now() + VAULT_TTL_MS);
  }

  /**
   * The end of a run nobody finished.
   *
   * A person's access and refresh tokens, their provider keys and the minted
   * root secrets are gone, and the run says so: the page offers signing in
   * again rather than a ledger that cannot move. A self-update keeps
   * `OWN_KEY`. A guided object that never got as far as a single step deletes
   * itself outright — `POST /api/deploy/runs` is public, so an object per probe
   * is the shape this bounds.
   */
  private async expire(): Promise<void> {
    const held = await this.ctx.storage.list<string>({ prefix: SECRET_PREFIX });
    const run = await this.runId();
    const own = await this.ctx.storage.get<string>(RECORD_KEY) !== undefined;
    const dropped = [...held.keys()].filter((key) => !own || !OWN_KEY.includes(key));

    await this.ctx.storage.delete(dropped);

    if (!own && this.rows().length === 0) {
      await this.ctx.storage.deleteAll();
      this.initSchema();
      diagnostics.event('deploy.run_dropped', { run, secrets: held.size });

      return;
    }

    await this.ctx.storage.put(RUN_STATE_KEY, 'expired');
    diagnostics.event('deploy.run_expired', { run, secrets: dropped.length });
    await this.broadcast();
  }

  /**
   * A live access token for this run.
   *
   * Cloudflare's access tokens last about an hour and a plan can be retried
   * long after the person walked away, so an expiry in the past is a refresh
   * rather than a step that fails with 401. The rotated pair lands the moment
   * it exists, as in `selfUpdate`.
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

    return minted.accessToken;
  }

  private async drive(inputs: DeployInputs, channelOrigin: string, update: boolean): Promise<void> {
    const token = await this.accessToken();
    const run = await this.runId();

    const manifest = await fetchReleaseManifest(channelOrigin);
    const artifact = await fetchReleaseArtifact(manifest, channelOrigin);
    const ran = await this.ctx.storage.get<string>(VERSION_KEY) ?? '';

    // A ledger belongs to one release: the self-update object has a fixed id, so a new version must
    // reset rows or `runDeployPlan` would skip everything as done. A resume keeps them.
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
        http: (url, headers) => fetch(url, { headers }),
        note: () => undefined,
      },
      this.ledger(),
      (progress) => this.deliver(run, { type: 'deploy.progress', progress }),
    );

    await this.ctx.storage.put(RUN_STATE_KEY, outcome.state);
    await this.broadcast();
  }

  /** The record's channel for a self-update: a deployment's own origin publishes no channel. */
  private channelOrigin(): string {
    return this.env.CLI_PUBLIC_ORIGIN ?? 'https://kinu.run';
  }

  /** No read-through to `env`: an update keeps live secrets via `keep_bindings` (`steps.ts versionMetadata`). */
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

  /** A page that connected mid-run renders the ledger it missed. */
  private async sendSnapshot(socket: WebSocket): Promise<void> {
    const snapshot = await this.snapshot();

    this.deliver(snapshot.runId, { type: 'deploy.snapshot', snapshot }, socket);
  }
}
