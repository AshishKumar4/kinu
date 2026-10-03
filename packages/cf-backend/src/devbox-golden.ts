/** Devbox D66: the 15-minute cron asks the golden object, which builds only when it must. */
import { Effect } from 'effect';
import { GOLDEN_NAME } from '@kinu.run/devbox';
import { attempt, diagnostics, settle } from '@kinu.run/core/obs';

export function keepDevboxGolden(boxes: { getByName(name: string): { ensureGolden(): Promise<string> } }): Promise<void> {
  return settle(attempt({ doing: 'keeping the devbox golden snapshot built', otherwise: 'unavailable' },
    async () => await boxes.getByName(GOLDEN_NAME).ensureGolden()).pipe(
    Effect.asVoid,
    Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('devbox.golden_failed', failure); })),
  ));
}
