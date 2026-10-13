/**
 * A sandbox box whose one command, `node server.js`, serves for a while on a hand clock: what a long command that
 * outruns its call's window looks like to the job lane.
 */
import { JOB_STAMP_ENV } from '@kinu.run/core';
import { execRecords } from '@kinu.run/devbox';
import type { HandClock } from '@kinu.run/test-utils';

export const SERVING = 'serving on :3000\n';

/** How long `node server.js` serves before it exits, on the job clock: past the 30 s window. */
export const SERVES_MS = 60_000;

/** The box's exposed port while `node server.js` serves, held by the command the job's stamp names. */
const SERVED_PORT = 3000;

/** A command's options as the lane hands them to the box: the job's stamp rides in its environment. */
interface BoxExec {
  readonly execId: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The box: `node server.js` prints its line at once and exits SERVES_MS on, or at the kill that ends it first. While it
 * runs it listens on SERVED_PORT, which the box exposes and names its listener by the stamp the command ran under.
 */
export function serverBox(clock: HandClock, killed: string[] = []) {
  const running = new Map<string, (exitCode: number) => void>();
  const stamps = new Map<string, string | null>();
  const waiting: { readonly count: number; readonly resolve: () => void }[] = [];
  let served = 0;

  const serve = ({ execId, env }: BoxExec, exit: (exitCode: number) => void): void => {
    const once = (exitCode: number): void => {
      stamps.delete(execId);

      if (running.delete(execId)) exit(exitCode);
    };

    running.set(execId, once);
    stamps.set(execId, env?.[JOB_STAMP_ENV] ?? null);
    clock.after(SERVES_MS, () => { once(0); });
    served += 1;

    for (const waiter of waiting.splice(0)) {
      if (served >= waiter.count) waiter.resolve();
      else waiting.push(waiter);
    }
  };

  return {
    /** Resolves once `count` commands have started serving, each its life armed on the clock. */
    served: (count: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();

      if (served >= count) resolve();
      else waiting.push({ count, resolve });

      return promise;
    },
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    configureEgress: async () => {},
    restoreStatus: async () => ({ restoring: false, refused: undefined }),
    getExposedPorts: async (hostname: string) => (stamps.size === 0 ? [] : [{ port: SERVED_PORT, name: undefined, url: `https://${String(SERVED_PORT)}-box-token.${hostname}` }]),
    portListeners: async () => [...stamps.values()].map((stamp) => ({ port: SERVED_PORT, pid: 1, stamp, command: 'node server.js' })),
    // Whole, as the runtime answers a call that streams nothing.
    execUntimed: (_command: string, exec: BoxExec) => new Promise((resolve) => {
      serve(exec, (exitCode) => { resolve({ stdout: SERVING, stderr: '', exitCode }); });
    }),
    execUntimedStream: async (_command: string, exec: BoxExec) => {
      const exitCode = Promise.withResolvers<number>();

      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(SERVING));
          serve(exec, (code) => {
            controller.close();
            exitCode.resolve(code);
          });
        },
      });

      return execRecords({ stdout, stderr: null, exitCode: exitCode.promise }, { exited: () => {}, cancelled: async () => {} });
    },
    releaseUntimed: async () => {},
    // The process tree ends as the runtime ends it: the command exits on the signal.
    killUntimed: async (execId: string) => {
      const end = running.get(execId);
      killed.push(execId);
      end?.(137);

      return end !== undefined;
    },
  };
}
