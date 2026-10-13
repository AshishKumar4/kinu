import type { Plugin } from 'vitest/config';
import type { PoolWorker } from 'vitest/node';
import { closeRemoteWorkersAi, reopenRemoteWorkersAi } from './workers-ai-binding';

/**
 * Ends Wrangler's remote proxy session with the Cloudflare pool, in the pool's own order (@cloudflare/vitest-plugin
 * pool `stop`): a worker disposes its Miniflare first, so no consumer of the session is left running, and only the
 * last worker to stop disposes the shared session. A worker holds its share while starting too, so another worker's
 * stop cannot close the session underneath it. A failed start releases that share.
 */
function tied(worker: PoolWorker, share: { running: number }): PoolWorker {
  const start = worker.start.bind(worker);
  const stop = worker.stop.bind(worker);
  let started = false;

  worker.start = async () => {
    reopenRemoteWorkersAi();
    started = true;
    share.running += 1;
    const [outcome] = await Promise.allSettled([start()]);

    if (outcome.status === 'fulfilled') return;
    started = false;
    share.running -= 1;

    if (share.running === 0) await closeRemoteWorkersAi();
    throw outcome.reason;
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
