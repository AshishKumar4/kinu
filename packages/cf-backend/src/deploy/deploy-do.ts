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
  ACCESS_TOKEN_KEY, DeployInputsSchema, DeployRunPhaseSchema, DeployStepRowSchema, FACT_ADDRESS,
  REFRESH_TOKEN_KEY, TarArtifact, bearerTransport, cloudflareResult, deployPlan,
  exchangeDeployCode, factsFrom, parseReleaseManifest, runDeployPlan, runKeyAdmits, sha256Hex,
  workerArtifactPath,
  type ArtifactSource, type DeployInputs, type DeployLedger, type DeployProgress,
  type DeploySecretVault, type DeploySnapshot, type DeployStepFailure, type DeployStepRow,
  type DeployStepSeed, type ReleaseManifest,
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

/** One thing a person may choose: an account to deploy into, or a zone to
 *  bind a hostname in. */
export interface DeployChoice {
  readonly id: string;
  readonly name: string;
}

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
    await this.landToken(token.accessToken, token.refreshToken);
  }

  /** The token pair, however it was obtained: the page's callback exchanges the
   *  code here, and `kinu deploy cloudflare` exchanges it on its own localhost
   *  redirect and hands the pair over. One run, one ledger, two doors. */
  async landToken(accessToken: string, refreshToken: string): Promise<void> {
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
      await this.drive(v.parse(DeployInputsSchema, inputs));
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

  private async drive(inputs: DeployInputs): Promise<void> {
    const token = await this.ctx.storage.get<string>(`${SECRET_PREFIX}${ACCESS_TOKEN_KEY}`);

    if (token === undefined) throw new Error('this run holds no Cloudflare authorization');

    const manifest = await this.release();
    const artifact = await this.artifact(manifest);

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

  /** The release this deployment gets: the manifest kinu.run publishes, and the
   *  artifact it names, verified against the digest the manifest carries before
   *  a byte of it is uploaded anywhere. */
  private async release(): Promise<ReleaseManifest> {
    const origin = this.env.CLI_PUBLIC_ORIGIN ?? 'https://kinu.run';
    const response = await fetch(new URL('/downloads/release.json', origin));

    if (!response.ok) throw new Error(`the release channel answered HTTP ${response.status}`);

    return parseReleaseManifest(await response.text());
  }

  private async artifact(manifest: ReleaseManifest): Promise<ArtifactSource> {
    const origin = this.env.CLI_PUBLIC_ORIGIN ?? 'https://kinu.run';
    const url = new URL(workerArtifactPath(manifest.version), origin);
    const response = await fetch(url);

    if (!response.ok) throw new Error(`${url.href} answered HTTP ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const published = await fetch(new URL(`${workerArtifactPath(manifest.version)}.sha256`, origin));
    const expected = (await published.text()).trim().split(/\s+/u)[0] ?? '';
    const actual = await sha256Hex(bytes);

    if (expected !== actual) {
      throw new Error(`the release artifact's checksum is ${actual}, and the channel publishes ${expected || '<none>'}`);
    }

    return TarArtifact.open(bytes);
  }

  private vault(): DeploySecretVault {
    return {
      read: async (name: string) => await this.ctx.storage.get<string>(`${SECRET_PREFIX}${name}`) ?? null,
      write: async (name: string, value: string) => {
        await this.ctx.storage.put(`${SECRET_PREFIX}${name}`, value);
      },
      names: async () => [...(await this.ctx.storage.list<string>({ prefix: SECRET_PREFIX })).keys()]
        .map((key) => key.slice(SECRET_PREFIX.length)),
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
