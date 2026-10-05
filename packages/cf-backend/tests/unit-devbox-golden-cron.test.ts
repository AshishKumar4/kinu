// The 15-minute cron keeps the devbox golden snapshot built (devbox D66): it asks the golden object,
// which builds only when the pinned tools moved or the golden nears its end, and a failure is reported.
import { expect, test } from 'bun:test';
import { GOLDEN_NAME } from '@kinu.run/devbox';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { keepDevboxGolden } from '../src/devbox-golden';

test('the cron asks the golden object, and a failed build is reported by name', async () => {
  const asked: string[] = [];

  const boxes = (answer: () => Promise<string>) => ({
    getByName: (name: string) => ({
      ensureGolden: async () => {
        asked.push(name);

        return await answer();
      },
    }),
  });

  const recorder = createRecordingLogger();
  const restore = setDiagnosticsSink(recorder);

  try {
    await keepDevboxGolden(boxes(async () => 'golden-1'));
    await keepDevboxGolden(boxes(async () => await Promise.reject(new Error('installing the tools exited 100'))));
  } finally {
    restore();
  }

  expect({ asked, failed: recorder.emitted.filter(line => line.event === 'devbox.golden_failed').map(line => line.cause ?? '') })
    .toEqual({ asked: [GOLDEN_NAME, GOLDEN_NAME], failed: [expect.stringContaining('installing the tools exited 100')] });
});
