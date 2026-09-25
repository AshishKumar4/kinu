/**
 * The production Worker entry (`export { default }`, not a copy) bound in the pool, so the web client's route table runs
 * under workerd. A loopback host is the one authority `authenticateRequest` takes without a secret (auth/session.ts);
 * model traffic goes to the Node-side fake via `outboundService`, `SurfaceAI` answers the Workers AI lanes.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { ownerCaller } from '@kinu.run/core';
import * as v from 'valibot';
import type { UserDO } from '../../src/user/user-do';
import { FakeAI } from './two-turn-probe';
import { HELD_PROXY_MODEL } from './ai-proxy-shapes';

export { default, OrchestratorAgent, UserDO } from '../../src/server';

/** A call to the Node-side control host (`http-model-fake.ts`); a refusal fails the caller. */
async function probeControl(path: string, method: 'GET' | 'POST'): Promise<Response> {
  const response = await fetch(`http://probe-control.invalid${path}`, { method });

  if (!response.ok) throw new Error(`probe-control refused ${method} ${path}: ${String(response.status)}`);

  return response;
}

/** `FakeAI`, except `HELD_PROXY_MODEL` parks at the Node-side hold, so its caller waits on real I/O until released. */
export class SurfaceAI extends FakeAI {
  override async run(...args: Parameters<FakeAI['run']>): Promise<Response> {
    if (args[0] !== HELD_PROXY_MODEL) return super.run(...args);
    await probeControl('/proxy/park', 'POST');

    return Response.json({ response: 'held' });
  }
}

interface SurfaceEnv {
  readonly UserDO: DurableObjectNamespace<UserDO>;
  readonly CREDENTIAL_ENCRYPTION_KEY: string;
}

/**
 * Test-only controls. The model fake's captured log is module state shared by every worker on `probeOutbound`,
 * so tests empty it here to keep `two-turn.test.ts` unfiltered reads clean.
 */
export class SurfaceControl extends WorkerEntrypoint<SurfaceEnv> {
  async resetModelLog(): Promise<void> {
    await probeControl('/reset', 'POST');
  }

  /** Arms the Node-side hold: every `HELD_PROXY_MODEL` call parks until `releaseProxyModel`. */
  async holdProxyModel(): Promise<void> {
    await probeControl('/proxy/hold', 'POST');
  }

  /** The parked count, answered once `count` calls are parked or the hold is released. */
  async proxyModelParked(count: number): Promise<number> {
    const answer = await probeControl(`/proxy/parked?count=${String(count)}`, 'GET');

    return v.parse(v.object({ parked: v.number() }), await answer.json()).parked;
  }

  async releaseProxyModel(): Promise<void> {
    await probeControl('/proxy/release', 'POST');
  }

  /** Arms the Node-side hold: every `probe-queue` call parks until `releaseQueuedModel`. */
  async holdQueuedModel(): Promise<void> {
    await probeControl('/queue/hold', 'POST');
  }

  /** Answers once a model call carrying `marker` has been made: with the hold armed, that call is parked. */
  async modelCalledWith(marker: string): Promise<void> {
    await probeControl(`/log/until?marker=${encodeURIComponent(marker)}`, 'GET');
  }

  async releaseQueuedModel(): Promise<void> {
    await probeControl('/queue/release', 'POST');
  }

  /** A `kinu auth` bearer for a fresh user, minted by the production UserDO as an approved device flow mints it. */
  async mintCliBearer(): Promise<string> {
    const userId = crypto.randomUUID().replaceAll('-', '');
    const owner = await ownerCaller(this.env);
    const user = this.env.UserDO.get(this.env.UserDO.idFromName(userId));
    await user.ensureProfile(owner, `${userId}@probe.local`);
    // The approval hash is single-use; this user's id twice is 64 hex no other mint shares.
    const minted = await user.mintCliToken(owner, userId, userId.repeat(2), 'ai-proxy probe');

    return minted.token;
  }
}
