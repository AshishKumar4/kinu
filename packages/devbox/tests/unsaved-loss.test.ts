// A box never loses work without saying so. A container that stops before its edits are saved (killed, evicted,
// crashed) comes back as its last save; the soak on integration's chain found that wake silent (D68). The box now
// says what time the workspace went back to; a rest that saved everything says nothing.
import { expect, setSystemTime, test } from 'bun:test';
import { chainBox } from './support/chain-box';

test('work written after the last save and lost with its container is named at the next wake', async () => {
  setSystemTime(new Date('2026-10-03T12:00:00Z'));
  const { box, container } = chainBox();

  try {
    await box.start();
    await box.writeFile('/workspace/kept', 'saved');
    expect((await box.checkpointNow('tick')).kind).toBe('committed');
    setSystemTime(new Date('2026-10-03T12:05:00Z'));
    await box.writeFile('/workspace/kept', 'never saved');
    await container.stop();
    setSystemTime(new Date('2026-10-03T12:10:00Z'));
    await box.start();

    const told = (await box.devboxIncidentReasons()).map((row) => `${row.stage}: ${row.reason}`);
    expect({ kept: (await box.readFile('/workspace/kept')).content, told: told.filter((line) => line.includes('2026-10-03T12:00:00.000Z')).length })
      .toEqual({ kept: 'saved', told: 1 });
  } finally {
    setSystemTime();
    await box.destroy();
  }
});

test('a rest that saved everything wakes with nothing to say', async () => {
  setSystemTime(new Date('2026-10-03T12:00:00Z'));
  const { box } = chainBox();

  try {
    await box.start();
    await box.writeFile('/workspace/kept', 'first');
    expect((await box.checkpointNow('tick')).kind).toBe('committed');
    setSystemTime(new Date('2026-10-03T12:03:00Z'));
    await box.writeFile('/workspace/kept', 'saved');
    setSystemTime(new Date('2026-10-03T12:05:00Z'));
    expect((await box.quiesce()).kind).toBe('committed');
    setSystemTime(new Date('2026-10-03T12:10:00Z'));
    await box.start();

    expect({ kept: (await box.readFile('/workspace/kept')).content, told: await box.devboxIncidentReasons() }).toEqual({ kept: 'saved', told: [] });
  } finally {
    setSystemTime();
    await box.destroy();
  }
});
