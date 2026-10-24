/**
 * A page's mode, by the one rule every page follows: the app, the signed-out pages and a slate page drawn on its own.
 * The reader's choice on this device wins; without one, the system's, and dark when the system asks for no light, as
 * `:root` draws. The app's theme store (cf-backend `hooks/use-theme.ts`) and every page's pre-paint script read it here,
 * so the first frame and the toggle that names the other face never disagree.
 */

export type Mode = 'dark' | 'light';

/** Where a device keeps the mode its reader chose. */
export const MODE_KEY = 'theme';

/** The system preference a page follows until its reader chooses. */
export const PREFERS_LIGHT = '(prefers-color-scheme: light)';

export function modeFor(stored: string | null, prefersLight: boolean): Mode {
  if (stored === 'light' || stored === 'dark') return stored;

  return prefersLight ? 'light' : 'dark';
}

/** {@link modeFor} on `<html data-mode>`, run as the head is parsed so the first paint is already in it: it ships as
 *  text, and a test runs this text against the rule. */
export const MODE_BOOT = `(() => {
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem(${JSON.stringify(MODE_KEY)}); } catch (e) {}
  var mode = stored === 'light' || stored === 'dark' ? stored : (matchMedia(${JSON.stringify(PREFERS_LIGHT)}).matches ? 'light' : 'dark');
  root.setAttribute('data-mode', mode);
  root.style.colorScheme = mode;
})();`;
