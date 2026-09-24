#!/usr/bin/env bun
/**
 * Run one command against the product's local dev server: boot `vite dev`
 * (live-app-harness: the real Worker and Durable Objects in workerd, on state
 * minted for this run), hand the command that origin as `KINU_ORIGIN`, tear the
 * server down, and exit with the command's own status.
 *
 * This is how a suite that drives `KINU_ORIGIN` runs before a deploy with no
 * second code path: `bun scripts/with-dev-server.ts bun test --timeout=0
 * scripts/product-flows.test.ts`, the same file `scripts/product-flows-tier.sh`
 * points at the deployment. `KINU_EVAL_LIVE=1` is the consent the test preload
 * requires before it lets a suite read `KINU_ORIGIN` at all
 * (scripts/test-scratch-home.ts), and a run here spends real model turns.
 */
import { releaseOnSignals, releaseScratch } from '@kinu.run/test-utils';
import { withDevServer } from './live-app-harness';

// Outside `bun test` no preload releases what the boot minted: its dev server's
// process group and its state and cache directories. A killed wrapper would
// otherwise leave vite serving, detached, on a port no run owns.
releaseOnSignals();

const command = process.argv.slice(2);

if (command.length === 0) {
  console.error('usage: bun scripts/with-dev-server.ts <command> [args...]');
  process.exit(2);
}

const status = await withDevServer(async ({ origin, previewPort }) => {
  console.error(`with-dev-server: ${origin} is up; running ${command.join(' ')}`);

  const child = Bun.spawn(command, {
    env: { ...process.env, KINU_ORIGIN: origin, KINU_DEV_PREVIEW_PORT: String(previewPort), KINU_EVAL_LIVE: '1' },
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  });

  return child.exited;
});

releaseScratch();

process.exit(status);
