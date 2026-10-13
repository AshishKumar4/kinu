import { describe, expect, test } from 'bun:test';

import { STROKE_STRIDE } from '../src/web/art';
import { Connectome } from '../src/web/connectome';

const ASPECT = 900 / 1440;

const WIDTH = 1440;

const DT = 1 / 60;

function stepSeconds(connectome: Connectome, seconds: number): Connectome {
  const steps = Math.round(seconds / DT);

  for (let index = 0; index < steps; index += 1) connectome.step(DT);

  return connectome;
}

function run(seed: number, seconds: number, connectome = new Connectome({ seed, aspect: ASPECT, width: WIDTH })): Connectome {
  return stepSeconds(connectome, seconds);
}


describe('the tissue answers the roster', () => {
  test('mode follows activity, and only a decisions rise flashes', () => {
    const connectome = new Connectome({ seed: 1729, aspect: ASPECT, width: WIDTH });
    expect(connectome.mode()).toBe('idle');

    connectome.setActivity({ working: true, decisions: 0 });
    expect(connectome.mode()).toBe('working');

    connectome.setActivity({ working: false, decisions: 0 });
    expect(connectome.mode()).toBe('idle');

    // At age 0 the flash envelope is still 0, so step once before asking.
    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('attention');

    stepSeconds(connectome, 2);
    expect(connectome.mode()).toBe('idle');

    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, 2);
    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('idle');

    connectome.setActivity({ working: false, decisions: 2 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('attention');

    stepSeconds(connectome, 2);
    connectome.setActivity({ working: false, decisions: 1 });
    stepSeconds(connectome, DT);
    expect(connectome.mode()).toBe('idle');

    const informed = new Connectome({ seed: 1729, aspect: ASPECT, width: WIDTH, activity: { working: false, decisions: 3 } });
    expect(informed.mode()).toBe('idle');
    stepSeconds(informed, 2);
    expect(informed.mode()).toBe('idle');
    informed.setActivity({ working: false, decisions: 4 });
    stepSeconds(informed, DT);
    expect(informed.mode()).toBe('attention');
  });
});

describe('the tissue keeps out of the copy', () => {
  test('a keep-out box empties its ground and empties back when lifted', () => {
    const connectome = run(1729, 0);
    stepSeconds(connectome, 4);
    const strokesBefore = connectome.frame().count;

    connectome.setKeepOut([{ left: 0, top: 0, right: 0.3, bottom: 0.3 }]);
    stepSeconds(connectome, 1);
    const shaded = connectome.frame();
    expect(shaded.count).toBeLessThan(strokesBefore);

    for (let index = 0; index < shaded.count; index += 1) {
      const at = index * STROKE_STRIDE;

      for (const [x, y] of [[shaded.strokes[at] ?? 0, shaded.strokes[at + 1] ?? 0], [shaded.strokes[at + 4] ?? 0, shaded.strokes[at + 5] ?? 0]] as const) {
        // A dendrite may run off the view's edge; off the view is outside the box too.
        expect(x > 0.3 || y > 0.3 || x < 0 || y < 0).toBe(true);
      }
    }

    connectome.setKeepOut([]);
    stepSeconds(connectome, 1);
    expect(connectome.frame().count).toBe(strokesBefore);
  });
});
