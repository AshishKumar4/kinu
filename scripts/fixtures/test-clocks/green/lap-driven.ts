// Loops that run the subject rather than wait on it: none is a lap-poll.
import { setSystemTime } from 'bun:test';

// A fixed repetition with no early exit.
export async function sendThree(send: (index: number) => Promise<void>): Promise<void> {
  for (let index = 0; index < 3; index++) await send(index);
}

// A capped run that hands the subject data each lap: every lap is a step of the subject.
export async function backfillAll(backfill: (page: number) => Promise<void>, done: () => boolean): Promise<void> {
  for (let page = 0; page < 100 && !done(); page++) await backfill(page);
}

// A run under the clock the subject was handed: the test moves time, the subject decides.
export async function beatUntilQuiet(beat: () => Promise<string>, start: number): Promise<string | undefined> {
  for (let lap = 1; lap <= 40; lap++) {
    setSystemTime(start + lap * 60_000);

    if (await beat() === 'quiesce') return 'quiesce';
  }

  return undefined;
}
