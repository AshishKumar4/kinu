/**
 * What a test browser declares at launch instead of asking the machine it runs
 * on: its pointing device and its colour scheme. Left to the machine, headless
 * Chrome reports no pointing device, and the scheme is whatever the desktop's
 * settings portal answers over the session bus, whenever it answers. Both are
 * Blink settings, which Chrome re-applies on every preferences push, so no later
 * push undoes them; they share one `--blink-settings` switch because Chrome
 * keeps only the last one given.
 */

/** A mouse: a fine pointer that hovers. Without it `(hover: hover)` and
 *  `(pointer: fine)` are false and every `hover:` utility Tailwind emits behind
 *  them is dead. It also outlasts touch emulation, so a touch-only visitor
 *  launches without it (measured 2026-09-22 on Chrome 151.0.7922.173). */
const MOUSE = 'primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';

/** `prefers-color-scheme: dark`. Undeclared, a page reads the desktop's setting:
 *  dark on this machine with the session bus reachable and light without it
 *  (measured 2026-09-24), and a page loaded before a late portal answer turned
 *  from light to dark under its test (2026-09-22). A test's own
 *  `emulateMediaFeatures` scheme still wins. */
const DARK = 'preferredColorScheme=0';

/** The launch switch that declares both; `mouse: false` for a touch-only visitor. */
export function declaredSettings({ mouse }: { readonly mouse: boolean }): string {
  return `--blink-settings=${mouse ? `${MOUSE},${DARK}` : DARK}`;
}
