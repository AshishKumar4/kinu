/**
 * Hosts the production `DeployRunDO` so a guided run is driven against real Durable Object SQLite:
 * resume-after-death reads, `ctx.storage` token wipes and digest-free rows are platform semantics
 * `bun test` cannot answer (step logic: packages/core/tests/unit-deploy-flow.test.ts).
 * The read-only windows added here must never ship: they would expose a run's vault over RPC.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { DeployRunDO } from '../../src/deploy/deploy-do';
import { deployRoutes, handleDeployCallback } from '../../src/deploy/routes';
import { updatesRoutes } from '../../src/updates/routes';
import { serveFamily } from '../helpers/api';
import type { AuthIdentity } from '../../src/auth/session';
import type { DeployRunPhase, DeploySnapshot } from '@kinu.run/core/deploy';
import {
  DEPLOY_FAKE_CREDENTIALS, DeployFakeStateSchema,
  type DeployFakeRefusal, type DeployFakeServedBuild, type DeployFakeStall, type DeployFakeState,
  type DeployFakeWeight,
} from './deploy-fake';
import * as v from 'valibot';

export class DeployRunProbeDO extends DeployRunDO {
  /** Callers parked on the end of an alarm delivery. */
  private readonly woken: (() => void)[] = [];
  private fires = 0;
  private armedAtMs = 0;

  /** The plane's credentials this object still stores, read off its storage: a finished run holds none. */
  async heldCredentials(): Promise<readonly string[]> {
    const stored = [...(await this.ctx.storage.list<unknown>()).values()];

    return DEPLOY_FAKE_CREDENTIALS.filter((credential) => stored.includes(credential));
  }

  /** Drops all storage: the self-update ledger has a fixed id, and an inherited finished ledger would
   *  pass rows by skipping every step. */
  async forget(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS deploy_step (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '[]', failure TEXT, facts TEXT NOT NULL DEFAULT '{}'
    )`);
  }

  /** Timer due time in epoch ms, or 0 when nothing is armed; the vault's bound is an alarm. */
  async alarmAt(): Promise<number> {
    return await this.ctx.storage.getAlarm() ?? 0;
  }

  /** Only moves an expiry: moving a plan's own alarm would start the run rather than expire it. */
  async expireSoon(): Promise<boolean> {
    if (await this.ctx.storage.get<string>('run.intent') !== undefined) return false;
    await this.ctx.storage.setAlarm(Date.now() + 50);

    return true;
  }

  /** `ctx.abort()` mid-step: the alarm stays uncleared, the state the runtime redelivers into. The
   *  stub call itself rejects with the abort. */
  abort(reason: string): void {
    this.ctx.abort(reason);
  }

  /** Awaited, not polled: every alarm delivery wakes waiters. A run that never reaches `states` never
   *  answers, surfacing in the gate rather than as a timeout blamed on a neighbour. */
  async settledAfter(states: readonly DeployRunPhase[]): Promise<DeploySnapshot> {
    for (;;) {
      const held = await this.snapshot();

      if (states.includes(held.state)) return held;
      await new Promise<void>((resolve) => { this.woken.push(resolve); });
    }
  }

  /** For rows whose subject is the delivery itself; a delivery already taken answers at once. */
  async reportAfterAlarm(): Promise<DeploySnapshot> {
    if (this.fires === 0) await new Promise<void>((resolve) => { this.woken.push(resolve); });

    return await this.snapshot();
  }

  /** By this object's clock, so the vault TTL is `alarmAt() - armedAt()` and never compares the test clock. */
  async armedAt(): Promise<number> {
    return this.armedAtMs;
  }

  /** `finally`, not catch: a thrown alarm must still be redelivered by the runtime. */
  override async alarm(): Promise<void> {
    try {
      await super.alarm();
    } finally {
      this.fires += 1;
      this.armedAtMs = Date.now();

      for (const resolve of this.woken.splice(0)) resolve();
    }
  }

  /** Substring-searched, so a new column cannot escape the assertion. */
  rowText(): string {
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT * FROM deploy_step ORDER BY seq').toArray());
  }
}

/** The fake is module state in the vitest process, reached through this worker's own outbound. */
export class DeployFakeControl extends WorkerEntrypoint {
  async reset(): Promise<void> {
    await this.hit('/reset');
  }

  async state(): Promise<DeployFakeState> {
    return this.hit('/state');
  }

  async refuseOnce(refusal: DeployFakeRefusal): Promise<void> {
    await this.hit('/refuse', refusal);
  }

  async serve(build: DeployFakeServedBuild): Promise<void> {
    await this.hit('/serve', build);
  }

  async stallOnce(stall: DeployFakeStall): Promise<void> {
    await this.hit('/stall', stall);
  }

  /** The window in which the object can be killed having changed the account without knowing it. */
  async stallReached(): Promise<void> {
    await this.hit('/stall/reached');
  }

  async releaseStall(): Promise<void> {
    await this.hit('/stall/release');
  }

  async weigh(weight: DeployFakeWeight): Promise<void> {
    await this.hit('/weigh', weight);
  }

  /** From the next grant on, the first access token is answered 401 until the run refreshes. */
  async expireGrant(expiresIn: number): Promise<void> {
    await this.hit('/expire', { expiresIn });
  }

  async publish(build: DeployFakeServedBuild): Promise<void> {
    await this.hit('/publish', build);
  }

  /** A Worker a previous run left serving the older build at 100%: what a
   *  self-update runs against. */
  async existing(): Promise<void> {
    await this.hit('/existing');
  }

  private async hit(
    path: string,
    body?: DeployFakeRefusal | DeployFakeServedBuild | DeployFakeStall | DeployFakeWeight | { expiresIn: number },
  ): Promise<DeployFakeState> {
    const sent = body === undefined
      ? { method: 'POST' }
      : { method: 'POST', body: JSON.stringify(body) };

    const response = await fetch(`http://deploy-control.invalid${path}`, sent);

    if (!response.ok) throw new Error(`the deploy fake refused ${path}: ${String(response.status)}`);

    return v.parse(DeployFakeStateSchema, await response.json());
  }
}

export interface UpdatesProbeAnswer {
  readonly status: number;
  readonly body: string;
}

/** Synthesized as a browser session (provider name, no CLI scopes); the route refuses dev and CLI-token identities. */
export class UpdatesProbe extends WorkerEntrypoint<Env> {
  async hit(method: string, path: string, session: AuthIdentity): Promise<UpdatesProbeAnswer> {
    // The refresh token this deployment's env carries is the one its last
    // secret write left, as a Worker's is; before any, the one it is bound with.
    const plane = await fetch('http://deploy-control.invalid/state', { method: 'POST' });
    const written = v.parse(DeployFakeStateSchema, await plane.json()).secrets.KINU_SELF_DEPLOY_REFRESH_TOKEN;

    const response = await serveFamily(updatesRoutes, { identity: session })(
      new Request(`https://kinu.probe.workers.dev${path}`, { method }),
      { ...this.env, KINU_SELF_DEPLOY_REFRESH_TOKEN: written ?? this.env.KINU_SELF_DEPLOY_REFRESH_TOKEN },
    );

    if (response === null) throw new Error(`the updates routes do not answer ${method} ${path}`);

    return { status: response.status, body: await response.text() };
  }
}

export interface DoorProbeAnswer {
  readonly status: number;
  readonly body: string;
  readonly location: string;
  readonly setCookie: readonly string[];
}

/** The deploy door (`deployRoutes`, and the callback the Worker answers itself): what a callback must prove before a stranger's Cloudflare tokens land in a run.
 *  No cookie jar: the test carries the cookie itself, which a forwarded URL cannot do. */
export class DeployDoorProbe extends WorkerEntrypoint<Env> {
  async hit(method: string, path: string, headers: Readonly<Record<string, string>> = {}): Promise<DoorProbeAnswer> {
    const request = new Request(`https://kinu.probe.workers.dev${path}`, { method, headers });

    // As the Worker dispatches: every `/api/` path is the app's, the OAuth return is its own.
    const response = path.startsWith('/api/')
      ? await serveFamily(deployRoutes)(request, this.env)
      : await handleDeployCallback(request, this.env);

    if (response === null) throw new Error(`the deploy routes do not answer ${method} ${path}`);

    // Accepted and closed so the runtime does not report an untaken half of a pipe.
    response.webSocket?.accept();
    response.webSocket?.close();

    return {
      status: response.status,
      body: response.webSocket === null ? await response.text() : '',
      location: response.headers.get('location') ?? '',
      setCookie: response.headers.getAll('set-cookie'),
    };
  }
}
