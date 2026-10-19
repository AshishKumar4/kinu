import { Effect } from 'effect';
import type { StartClock } from './lifecycle';
import { attempt, observe } from './errors';
import { endProcess } from './processes';

/** The native deadline cannot be held behind a Worker timer accepted outside the restore gate. */
export function nativeStartClock(container: Pick<Container, 'exec'>): StartClock {
  return {
    now: () => Date.now(),
    after(ms, fire) {
      return observe(Effect.gen(function* () {
        const process = yield* attempt('io', () => container.exec(['/bin/sleep', String(Math.max(0, ms) / 1000)], {
          stdout: 'ignore', stderr: 'ignore',
        }));

        // Cancelled before its deadline, the sleep is ended by an exec (`endProcess`). One whose exit could not be read
        // is not: its connection went, and with it anything a kill could reach.
        yield* attempt('io', () => process.exitCode).pipe(
          Effect.onInterrupt(() => Effect.sync(() => { endProcess(container, process.pid, 'ending a cancelled restore clock'); })),
        );
      }), {
        success: fire,
        failure(cause) {
          console.error(`[devbox] restore deadline process failed: ${cause.message}`);
          fire();
        },
      });
    },
  };
}
