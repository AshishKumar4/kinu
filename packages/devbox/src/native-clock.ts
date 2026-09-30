import { Effect } from 'effect';
import type { StartClock } from './lifecycle';
import { attempt, observe } from './errors';

/** The native deadline cannot be held behind a Worker timer accepted outside the restore gate. */
export function nativeStartClock(container: Pick<Container, 'exec'>): StartClock {
  return {
    now: () => Date.now(),
    after(ms, fire) {
      return observe(Effect.gen(function* () {
        const process = yield* attempt('io', signal => container.exec(['/bin/sleep', String(Math.max(0, ms) / 1000)], {
          signal, stdout: 'ignore', stderr: 'ignore',
        }));

        let finished = false;
        yield* attempt('io', () => process.exitCode).pipe(
          Effect.tap(() => Effect.sync(() => { finished = true; })),
          Effect.ensuring(Effect.sync(() => { if (!finished) process.kill(9); })),
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
