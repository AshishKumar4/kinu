import { describe, expect, test } from 'bun:test';
import { drainArmadaProgress } from './armada-progress';

/** stderr as armada writes it, in `chunks`. */
function written(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('an armada map\'s progress', () => {
  test('names its job once the whole line has arrived, though the id is cut between two chunks', async () => {
    const named: string[] = [];
    const drained = await drainArmadaProgress(written(['  0:00  preparing\njob 20261017', '145705-77f1c082\n  0:07  running\n']), (job) => { named.push(job); });

    expect({ named, job: drained.job }).toEqual({ named: ['20261017145705-77f1c082'], job: '20261017145705-77f1c082' });
  });

  test('names a job whose line is the last thing written, without its newline', async () => {
    expect((await drainArmadaProgress(written(['  0:00  preparing\n', 'job 20261017145705-77f1c082']))).job).toBe('20261017145705-77f1c082');
  });
});
