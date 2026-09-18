/**
 * The public-surface probe worker: the PRODUCTION Worker entry, bound inside the
 * pool, so the surfaces the WEB CLIENT drives can be driven against workerd.
 *
 * WHY A WORKER AND NOT A PROBE OBJECT. Every other probe here addresses a
 * Durable Object and asserts what the object did. The public surface is not an
 * object: creating a workspace is `POST /api/user/workspaces` through
 * `route()`'s auth gate, and a turn is the agents-SDK chat socket the same
 * `route()` hands to `routeAgentRequest`. Nothing in this tree had ever run that
 * route table under workerd — `tests/evals/public-session.ts` drives it, and
 * only against a deployment — so the door the product is actually used through
 * was reachable in tests only over the network. `export { default }` below is
 * the shipped handler, not a copy: a probe that retargets the surface measures
 * its own fixture.
 *
 * WHO THE CALLER IS. Requests carry a LOOPBACK host, which is the one authority
 * `authenticateRequest` takes without a secret — possession of the machine is
 * the trust boundary there (auth/session.ts:200-213) — so the probe needs
 * `DEV_USER_EMAIL` and no identity header, exactly as `vite dev` does. The same
 * host keeps the request off the HTTPS redirect: `isPublishedHost` is derived
 * from `CLI_PUBLIC_ORIGIN`, which this worker does not bind (server.ts:418-421,
 * :447-453).
 *
 * THE MODEL PLANE is the one the workerd tier already supplies, on the seam the
 * sibling two-turn probe uses: the turn is pinned to `openai-compat/probe`
 * against the Node-side fake `vitest.config.ts` installs as this worker's
 * `outboundService`, so the turn's requests travel the product's own
 * openai-compat wire path — `createAuthedFetch` over the global fetch — which is
 * an HTTP subrequest, exactly as production's model traffic is. `FakeAI` is
 * re-exported beside it and bound as `AI`, because the sleep-time and title
 * lanes stay on the tier's Workers AI binding and the fake answers those too.
 * Both fakes are borrowed rather than re-written: one fake per lane, already
 * argued.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

export { default, OrchestratorAgent, UserDO } from '../../src/server';

export { FakeAI } from './two-turn-probe';

/**
 * The one test-only surface this worker adds, and the reason it exists: the
 * Node-side model fake's captured log is MODULE state in the vitest process, so
 * it is one log for every worker whose `outboundService` is `probeOutbound`. A
 * turn driven from this file would leave rows in the log `two-turn.test.ts`
 * reads unfiltered (two-turn.test.ts:281), so the test hands the log back empty
 * through here. Nothing in `src/` knows this entrypoint exists.
 */
export class SurfaceControl extends WorkerEntrypoint {
  async resetModelLog(): Promise<void> {
    const response = await fetch('http://probe-control.invalid/reset', { method: 'POST' });

    if (!response.ok) throw new Error(`the model fake refused a log reset: ${String(response.status)}`);
  }
}
