/**
 * The deploy probe worker: the PRODUCTION `DeployRunDO`, hosted here so a
 * guided run can be driven end to end against real Durable Object SQLite.
 *
 * THE CHARTER EXCEPTION, and why this one earns it (`worker.ts` states the
 * rule): the object under test is the ledger itself. Three of its four
 * obligations are platform semantics — a row written by an activation that
 * then died is what a resumed run reads, `ctx.storage` KV is where the tokens
 * live and `ctx.storage.delete` is what wipes them, and the SQL rows are what
 * must never contain the run key's digest. `bun test` has no Durable Object
 * storage, so the core suite proves the STEP logic against a port fake
 * (`packages/core/tests/unit-deploy-flow.test.ts`) and this file proves what
 * only the platform can answer.
 *
 * WHAT IS ADDED: two read-only windows the production class does not expose,
 * because exposing them in production would be a way to read a run's vault
 * over RPC. `heldSecretNames` lists the vault's keys and never its values;
 * `rowText` returns every SQL row as text, which is how the test asserts that
 * a digest, a token or a minted secret is not in one.
 *
 * `UpdatesProbe` is the second subject here: the production `/api/updates`
 * handlers, called with a session this worker synthesizes. A session is all
 * this probe fakes — the record, the channel, the refresh grant, the plan and
 * the Durable Object are the real ones — because the gate's subject is the
 * deployment's own record and not how a cookie was verified.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { DeployRunDO } from '../../src/deploy/deploy-do';
import { handleDeployRequest } from '../../src/deploy/routes';
import { handleUpdatesRequest } from '../../src/updates/routes';
import type { AuthIdentity } from '../../src/auth/session';
import {
  DeployFakeStateSchema, type DeployFakeRefusal, type DeployFakeServedBuild, type DeployFakeState,
} from './deploy-fake';
import * as v from 'valibot';

const SECRET_PREFIX = 'secret.';

export class DeployRunProbeDO extends DeployRunDO {
  /** The vault's keys. A run that is over must answer with none. */
  async heldSecretNames(): Promise<readonly string[]> {
    const held = await this.ctx.storage.list<string>({ prefix: SECRET_PREFIX });

    return [...held.keys()];
  }

  /** Every durable row, as text. The assertion is a substring search, so the
   *  shape does not matter and a new column cannot escape it. */
  rowText(): string {
    return JSON.stringify(this.ctx.storage.sql.exec('SELECT * FROM deploy_step ORDER BY seq').toArray());
  }
}

/** The test's door to the Node-side plane: the fake's state is module state in
 *  the vitest process, so the test reaches it through this worker's own
 *  outbound rather than over a network it does not have. */
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

  /** What this deployment serves as its own build stamp from here on. */
  async serve(build: DeployFakeServedBuild): Promise<void> {
    await this.hit('/serve', build);
  }

  private async hit(path: string, body?: DeployFakeRefusal | DeployFakeServedBuild): Promise<DeployFakeState> {
    const sent = body === undefined
      ? { method: 'POST' }
      : { method: 'POST', body: JSON.stringify(body) };

    const response = await fetch(`http://deploy-control.invalid${path}`, sent);

    if (!response.ok) throw new Error(`the deploy fake refused ${path}: ${String(response.status)}`);

    return v.parse(DeployFakeStateSchema, await response.json());
  }
}

/** What one call to the Updates surface answered. */
export interface UpdatesProbeAnswer {
  readonly status: number;
  readonly body: string;
}

/**
 * The Updates surface, called as a signed-in session.
 *
 * The identity is synthesized with a provider name and no CLI scopes, which is
 * what a browser session is here; `dev` and CLI-token identities are what the
 * route refuses, and a row asking for either passes them through.
 */
export class UpdatesProbe extends WorkerEntrypoint<Env> {
  async hit(method: string, path: string, session: AuthIdentity): Promise<UpdatesProbeAnswer> {
    const response = await handleUpdatesRequest(
      new Request(`https://kinu.probe.workers.dev${path}`, { method }),
      this.env,
      session,
    );

    if (response === null) throw new Error(`the updates routes do not answer ${method} ${path}`);

    return { status: response.status, body: await response.text() };
  }
}

/** What one call to the door's routes answered. `setCookie` is every
 *  `set-cookie` the answer wrote, because the binding under test IS a cookie. */
export interface DoorProbeAnswer {
  readonly status: number;
  readonly body: string;
  readonly location: string;
  readonly setCookie: readonly string[];
}

/**
 * The door's public routes, called the way a browser and the CLI call them.
 *
 * The third subject on this worker, and the one the ledger probe cannot reach:
 * `handleDeployRequest` decides what a callback must prove before a stranger's
 * Cloudflare tokens land in a run, and where the run key is allowed to travel.
 * Headers in, headers out, no cookie jar — the test carries the cookie between
 * two calls itself, which is exactly the thing a forwarded URL cannot do.
 */
export class DeployDoorProbe extends WorkerEntrypoint<Env> {
  async hit(method: string, path: string, headers: Readonly<Record<string, string>> = {}): Promise<DoorProbeAnswer> {
    const response = await handleDeployRequest(
      new Request(`https://kinu.probe.workers.dev${path}`, { method, headers }),
      this.env,
    );

    if (response === null) throw new Error(`the deploy routes do not answer ${method} ${path}`);

    // An upgrade the row only inspects: the client end is accepted and closed
    // so the runtime does not report a half of a pipe nobody took.
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
