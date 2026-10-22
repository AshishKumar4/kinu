import { expect, test } from 'bun:test';
import { deployLanded } from './worker-deployments';

const at = (iso: string) => Date.parse(iso);

const window = { from: at('2026-10-21T20:31:52Z'), to: at('2026-10-21T20:41:12Z') };

// A code update's reset is a deploy's only when a deploy other than the version's own landed inside its window.
test('a deploy of another version inside the window rolled the version over; its own deploy and later ones did not', () => {
  const own = { at: at('2026-10-21T20:31:53Z'), versions: ['v1'] };
  const next = { at: at('2026-10-21T20:40:00Z'), versions: ['v2'] };
  const later = { at: at('2026-10-21T21:00:00Z'), versions: ['v2'] };
  const before = { at: at('2026-10-21T19:00:00Z'), versions: ['v0'] };

  expect({
    rolled: deployLanded([later, next, own, before], window, 'v1'),
    quiet: deployLanded([later, own, before], window, 'v1'),
  }).toEqual({ rolled: true, quiet: false });
});

test('a full list that does not reach back to the window cannot say, and fails', () => {
  const newer = Array.from({ length: 10 }, (_, index) => ({ at: at('2026-10-21T22:00:00Z') + index * 60_000, versions: [`n${String(index)}`] }));

  expect(() => deployLanded(newer, window, 'v1')).toThrow('whether one landed inside the window is unknown');
  expect(deployLanded(newer.slice(0, 3), window, 'v1')).toBe(false);
});
