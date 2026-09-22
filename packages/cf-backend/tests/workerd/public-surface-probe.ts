/**
 * The production Worker entry (`export { default }`, not a copy) bound in the pool, so the web client's route table runs
 * under workerd. A loopback host is the one authority `authenticateRequest` takes without a secret (auth/session.ts);
 * model traffic goes to the Node-side fake via `outboundService`, `FakeAI` answers the Workers AI lanes.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

export { default, OrchestratorAgent, UserDO } from '../../src/server';

export { FakeAI } from './two-turn-probe';

/**
 * Test-only: the model fake's captured log is module state shared by every worker on `probeOutbound`,
 * so tests empty it here to keep `two-turn.test.ts` unfiltered reads clean.
 */
export class SurfaceControl extends WorkerEntrypoint {
  async resetModelLog(): Promise<void> {
    const response = await fetch('http://probe-control.invalid/reset', { method: 'POST' });

    if (!response.ok) throw new Error(`the model fake refused a log reset: ${String(response.status)}`);
  }
}
