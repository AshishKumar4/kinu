// detach runs an effect React calls and nothing awaits: its type admits no failure, and a defect is one diagnostic.
import { Effect } from 'effect';
import { describe, expect, test } from 'bun:test';
import { createRecordingLogger, detach, KinuError, setDiagnosticsSink } from '../src/obs/index';

describe('detach', () => {
  test('refuses, at compile time, an effect that has not answered its failures', () => {
    // Fails typecheck if detach ever admits a failure channel.
    const refusesFailures: Effect.Effect<never, KinuError> extends Parameters<typeof detach>[0] ? false : true = true;

    expect(refusesFailures).toBe(true);
  });

  test('a defect is one diagnostic and no rejection is left unhandled', async () => {
    const recording = createRecordingLogger();
    const restore = setDiagnosticsSink(recording);
    const unhandled: unknown[] = [];

    const onUnhandled = (...rejected: [unknown]): void => { unhandled.push(rejected[0]); };

    process.on('unhandledRejection', onUnhandled);

    try {
      detach(Effect.die(new Error('the handler broke')));
      await recording.until((lines) => lines.some((line) => line.event === 'effect.detached_defect'));
      await new Promise((resolve) => { setImmediate(resolve); });

      expect(recording.emitted.map((line) => line.event)).toEqual(['effect.detached_defect']);
      expect(recording.emitted[0]?.cause).toContain('the handler broke');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      restore();
    }
  });
});
