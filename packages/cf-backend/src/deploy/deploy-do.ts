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
 * WHAT IT HOLDS AND FOR HOW LONG. The person's access and refresh tokens, their
 * provider keys and the two minted root secrets live in the object's key-value
 * storage, never in a SQL row and never in a frame. The last step writes the
 * refresh token into the new Worker as its own secret and wipes the lot; from
 * then on the deployment owns its key and kinu.run holds nothing.
 *
 * WHAT THE KEY IS FOR. The door is public, so the run key is the whole of the
 * authorization: 192 bits minted at creation, presented on every call and on
 * the socket upgrade, compared against its digest. Storage holds the digest.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  ACCESS_TOKEN_KEY, DEPLOY_CLIENT_ID_KEY, DeployInputsSchema, DeployRunPhaseSchema,
  DeployStepRowSchema, FACT_ADDRESS, MINTED_SECRETS, REFRESH_TOKEN_KEY, SELF_UPDATE_RUN_ID,
  bearerTransport, cloudflareResult, deployPlan, exchangeDeployCode, factsFrom,
  fetchReleaseArtifact, fetchReleaseManifest, refreshDeployToken, runDeployPlan, runKeyAdmits,
  type DeployChoice, type DeployInputs, type DeployLedger,
  type DeployProgress, type DeploySecretVault, type DeploySnapshot, type DeployStepFailure,
  type DeployStepRow, type DeployStepSeed, type DeploymentRecord,
} from '@kinu.run/core/deploy';
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

export class DeployRunDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
    const url = new URL(request.url);

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.accept(url);
    }

    return new Response('not a deploy socket', { status: 400 });
  }

  /** Created before anything else exists: the run's key digest is written here
   *  and the key itself is returned to the caller once, by the route. */
  async open(runId: string, keyDigest: string): Promise<void> {
    await this.ctx.storage.put(RUN_ID_KEY, runId);
    await this.ctx.storage.put(KEY_DIGEST_KEY, keyDigest);
    await this.ctx.storage.put(RUN_STATE_KEY, 'collecting');
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
   * callback carrying somebody else's state is refused rather than exchanged.
   */
  async holdAuthorization(verifier: string): Promise<string> {
    const nonce = new Uint8Array(16);

    crypto.getRandomValues(nonce);
    const state = `${await this.runId()}.${[...nonce].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;

    await this.ctx.storage.put(VERIFIER_KEY, verifier);
    await this.ctx.storage.put(STATE_KEY, state);
    await this.ctx.storage.put(RUN_STATE_KEY, 'authorizing');

    return state;
  }

  async landAuthorization(clientId: string, redirectUri: string, code: string, state: string): Promise<void> {
    const expected = await this.ctx.storage.get<string>(STATE_KEY) ?? '';
    const verifier = await this.ctx.storage.get<string>(VERIFIER_KEY) ?? '';

    if (expected === '' || verifier === '') throw new Error('this run has no authorization in flight');

    if (state !== expected) throw new Error('that authorization belongs to another run');

    const token = await exchangeDeployCode({ clientId, redirectUri, code, verifier });

    await this.ctx.storage.delete([VERIFIER_KEY, STATE_KEY]);
    await this.landToken(clientId, token.accessToken, token.refreshToken);
  }

  /** The token pair, however it was obtained: the page's callback exchanges the
   *  code here, and `kinu deploy cloudflare` exchanges it on its own localhost
   *  redirect and hands the pair over. One run, one ledger, two doors.
   *
   *  The client id rides with the pair because the last step writes it into the
   *  deployment: a refresh names its client, and the two doors authorize
   *  against the same one. */
  async landToken(clientId: string, accessToken: string, refreshToken: string): Promise<void> {
    await this.ctx.storage.put(`${SECRET_PREFIX}${DEPLOY_CLIENT_ID_KEY}`, clientId);
    await this.ctx.storage.put(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`, accessToken);
    await this.ctx.storage.put(`${SECRET_PREFIX}${REFRESH_TOKEN_KEY}`, refreshToken);
    await this.ctx.storage.put(RUN_STATE_KEY, 'collecting');
  }

  async authorized(): Promise<boolean> {
    return await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`) !== undefined;
  }

  /** Provider keys the person supplied. Written straight into the vault, never
   *  into the inputs row, because the row is readable for the run's lifetime. */
  async holdProviderKey(name: string, value: string): Promise<void> {
    await this.ctx.storage.put(`${SECRET_PREFIX}${name}`, value);
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
    const token = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`);

    if (token === undefined) throw new Error('this run holds no Cloudflare authorization');

    return cloudflareResult(bearerTransport(token), { method: 'GET', path }, ChoicesSchema);
  }

  /**
   * Run, or carry on running.
   *
   * One entry point for the first start, for a reload that finds the run
   * unfinished, and for a retry of a step that refused. `running` keeps two
   * activations of the same object from driving one plan twice; it is an
   * in-memory flag on purpose, because an eviction that clears it is exactly
   * the case where the run SHOULD be startable again.
   */
  async start(inputs: DeployInputs): Promise<DeploySnapshot> {
    await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(inputs));

    if (this.running) return this.snapshot();
    this.running = true;

    try {
      await this.drive(v.parse(DeployInputsSchema, inputs), this.channelOrigin(), this.vault(null));
    } finally {
      this.running = false;
    }

    return this.snapshot();
  }

  /** Retry one failed step: the row goes back to pending and the plan runs
   *  again, which re-enters at exactly that step because everything before it
   *  is `done`. */
  async retry(stepId: string): Promise<DeploySnapshot> {
    this.sql.exec(`UPDATE deploy_step SET state = 'pending', failure = NULL WHERE id = ? AND state = 'failed'`, stepId);
    const inputs = await this.ctx.storage.get<string>(INPUTS_KEY);

    if (inputs === undefined) return this.snapshot();

    return this.start(v.parse(DeployInputsSchema, JSON.parse(inputs)));
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
   * The secrets the upload must re-bind are the ones this Worker is already
   * running with, which is why the vault reads through to `env`: a version
   * uploaded without them would bind a new encryption key over the credentials
   * this deployment has already stored.
   */
  async selfUpdate(record: DeploymentRecord, refreshToken: string): Promise<DeploySnapshot> {
    await this.ctx.storage.put(RUN_ID_KEY, SELF_UPDATE_RUN_ID);

    if (this.running) return this.snapshot();
    this.running = true;

    try {
      const token = await refreshDeployToken({ clientId: record.clientId, refreshToken });

      await this.landToken(record.clientId, token.accessToken, token.refreshToken);
      await this.ctx.storage.put(INPUTS_KEY, JSON.stringify(record.inputs));
      await this.drive(record.inputs, record.channelOrigin, this.vault(record));
    } finally {
      this.running = false;
    }

    return this.snapshot();
  }

  private async drive(inputs: DeployInputs, channelOrigin: string, vault: DeploySecretVault): Promise<void> {
    const token = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`);

    if (token === undefined) throw new Error('this run holds no Cloudflare authorization');

    // The release this deployment gets, read through the one channel reader
    // every door uses: the manifest, and the artifact it names verified
    // against the digest the channel publishes.
    const manifest = await fetchReleaseManifest(channelOrigin);
    const artifact = await fetchReleaseArtifact(manifest, channelOrigin);

    await this.ctx.storage.put(VERSION_KEY, manifest.version);
    await this.ctx.storage.put(RUN_STATE_KEY, 'running');

    const outcome = await runDeployPlan(
      deployPlan(manifest, inputs),
      {
        manifest,
        inputs,
        transport: bearerTransport(token),
        artifact,
        vault,
        facts: factsFrom(this.rows()),
        http: (url: string) => fetch(url),
        note: () => undefined,
      },
      this.ledger(),
      (progress) => this.publish(progress),
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
   * The run's secret material.
   *
   * `record` non-null is a self-update, and then a name this object does not
   * hold reads through to the Worker's own bindings: the minted root secrets
   * and the provider keys the first run supplied are live in `env`, and they
   * are exactly what the new version must be re-bound with. A guided run has
   * no such fallback — there is no deployment yet — so it passes null and a
   * missing name stays missing.
   */
  private vault(record: DeploymentRecord | null): DeploySecretVault {
    const carried = record === null
      ? new Map<string, string>()
      : deploymentSecrets(this.env, record.inputs.providerKeyNames);

    return {
      read: async (name: string) =>
        await this.ctx.storage.get<string>(`${SECRET_PREFIX}${name}`) ?? carried.get(name) ?? null,
      write: async (name: string, value: string) => {
        await this.ctx.storage.put(`${SECRET_PREFIX}${name}`, value);
      },
      names: async () => {
        const held = new Set(carried.keys());

        for (const key of (await this.ctx.storage.list<string>({ prefix: SECRET_PREFIX })).keys()) {
          held.add(key.slice(SECRET_PREFIX.length));
        }

        return [...held];
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

  private async accept(url: URL): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Hibernation, not a held reference: a run is minutes of network calls and
    // a page that may sit open through all of it, and an object evicted between
    // two steps must not take the page's socket with it.
    this.ctx.acceptWebSocket(server, [`run:${url.pathname}`]);
    // Awaited, not fired: the first frame is this run's whole state, and a
    // page that got the 101 before the snapshot was queued would render an
    // empty ledger until the next change.
    await this.sendSnapshot(server);

    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

    return new Response(null, init);
  }

  override async webSocketMessage(): Promise<void> {
    // The page never sends: it asks over HTTP and watches here. A frame from
    // the browser is not a protocol this run has, and answering one would be
    // an unauthenticated write surface on a public socket.
  }

  private publish(progress: DeployProgress): void {
    for (const socket of this.ctx.getWebSockets()) socket.send(JSON.stringify({ type: 'deploy.progress', progress }));
  }

  private async broadcast(): Promise<void> {
    const snapshot = await this.snapshot();

    for (const socket of this.ctx.getWebSockets()) {
      socket.send(JSON.stringify({ type: 'deploy.snapshot', snapshot }));
    }
  }

  private async sendSnapshot(socket: WebSocket): Promise<void> {
    try {
      socket.send(JSON.stringify({ type: 'deploy.snapshot', snapshot: await this.snapshot() }));
    } catch (cause) {
      // A socket that closed between the upgrade and the first frame is a
      // browser navigating away, which is ordinary and costs this run nothing.
      diagnostics.event('deploy.snapshot_undelivered', {
        run: await this.runId(), error: renderThrownChain({ cause }),
      });
    }
  }
}

/** A binding that carries a secret's text. A binding that is a namespace, a
 *  bucket or a fetcher parses as none, which is what keeps this to secrets. */
const SecretTextSchema = v.pipe(v.string(), v.minLength(1));

/**
 * The secrets this Worker is running with, by the names an update must re-bind.
 *
 * NARROWED BY NAME: what a self-update needs is the two minted root secrets
 * plus the provider keys the first run supplied, and the record names those.
 * Every other binding this Worker holds is dropped before it can reach an
 * upload payload.
 */
function deploymentSecrets(env: Env, providerKeyNames: readonly string[]) {
  const wanted = new Set<string>([...MINTED_SECRETS, ...providerKeyNames]);
  const held = new Map<string, string>();

  for (const [name, binding] of Object.entries(env)) {
    if (!wanted.has(name)) continue;
    const text = v.safeParse(SecretTextSchema, binding);

    if (text.success) held.set(name, text.output);
  }

  return held;
}
