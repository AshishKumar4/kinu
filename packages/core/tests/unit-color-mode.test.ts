import { describe, expect, test } from 'bun:test';
import { MODE_BOOT, MODE_KEY, modeFor, PREFERS_LIGHT } from '../src/utils/color-mode';

/** What the shipped pre-paint text draws on a page: `stored` on the device (or storage that refuses to be read), and a
 *  system that does or does not ask for light. */
function painted(stored: string | null | Error, prefersLight: boolean) {
  const attributes = new Map<string, string>();
  const style = { colorScheme: '' };

  const storage = {
    getItem: (key: string) => {
      if (stored instanceof Error) throw stored;

      return key === MODE_KEY ? stored : null;
    },
  };

  const matchMedia = (query: string) => ({ matches: query === PREFERS_LIGHT && prefersLight });
  const root = { setAttribute: (name: string, value: string) => { attributes.set(name, value); }, style };

  new Function('document', 'localStorage', 'matchMedia', MODE_BOOT)({ documentElement: root }, storage, matchMedia);

  return { mode: attributes.get('data-mode'), scheme: style.colorScheme };
}

const CASES = [
  ['light', true], ['light', false], ['dark', true], ['dark', false], [null, true], [null, false], ['sepia', true], ['sepia', false],
] as const;

describe("a page's mode", () => {
  test.each(CASES)('stored %p, a system asking for light %p: the head paints what the rule says', (stored, prefersLight) => {
    const want = modeFor(stored, prefersLight);

    expect(painted(stored, prefersLight)).toEqual({ mode: want, scheme: want });
  });

  test("is the reader's choice, else the system's, and dark where the system asks for no light", () => {
    expect(CASES.map(([stored, prefersLight]) => modeFor(stored, prefersLight))).toEqual(['light', 'light', 'dark', 'dark', 'light', 'dark', 'light', 'dark']);
  });

  test('storage that refuses to be read leaves the system to decide', () => {
    expect(painted(new Error('storage is off'), true).mode).toBe('light');
    expect(painted(new Error('storage is off'), false).mode).toBe('dark');
  });
});
