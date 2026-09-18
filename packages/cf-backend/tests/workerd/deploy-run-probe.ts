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
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { DeployRunDO } from '../../src/deploy/deploy-do';
import { DeployFakeStateSchema, type DeployFakeRefusal, type DeployFakeState } from './deploy-fake';
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

  private async hit(path: string, body?: DeployFakeRefusal): Promise<DeployFakeState> {
    const sent = body === undefined
      ? { method: 'POST' }
      : { method: 'POST', body: JSON.stringify(body) };

    const response = await fetch(`http://deploy-control.invalid${path}`, sent);

    if (!response.ok) throw new Error(`the deploy fake refused ${path}: ${String(response.status)}`);

    return v.parse(DeployFakeStateSchema, await response.json());
  }
}
