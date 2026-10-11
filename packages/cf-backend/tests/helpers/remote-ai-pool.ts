import type { Plugin } from 'vitest/config';
import type { PoolWorker } from 'vitest/node';
import { closeRemoteWorkersAi, reopenRemoteWorkersAi } from './workers-ai-binding';

/**
 * Ends Wrangler's remote proxy session with the Cloudflare pool, in the pool's own order (@cloudflare/vitest-plugin
 * pool `stop`): a worker disposes its Miniflare first, so no consumer of the session is left running, and only the
 * last worker to stop disposes the shared session. A worker that starts reopens it, and a worker that failed to start
 * holds no share of it.
 */
function tied(worker: PoolWorker, share: { running: number }): PoolWorker {
  const start = worker.start.bind(worker);
  const stop = worker.stop.bind(worker);
  let started = false;

  worker.start = async () => {
    reopenRemoteWorkersAi();
    await start();
    started = true;
    share.running += 1;
  };

  worker.stop = async () => {
    await stop();

    if (!started) return;
    started = false;
    share.running -= 1;

    if (share.running === 0) await closeRemoteWorkersAi();
  };

  return worker;
}

export function remoteAiPoolLifecycle(): Plugin {
  const share = { running: 0 };

  return {
    name: 'kinu:remote-ai-pool-lifecycle',
    // After @cloudflare/vitest-plugin installs its pool, so the pool wrapped is the one that runs.
    enforce: 'post',
    configureVitest({ project }) {
      const pool = project.config.poolRunner;

      if (pool === undefined) throw new Error('The Cloudflare pool was not installed before the remote AI lifecycle plugin ran.');
      project.config.poolRunner = { ...pool, createPoolWorker: (options) => tied(pool.createPoolWorker(options), share) };
    },
  };
}
