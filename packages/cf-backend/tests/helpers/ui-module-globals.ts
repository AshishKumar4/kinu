/**
 * The smallest browser shims that let cf-backend's UI module graph evaluate
 * outside a browser: the theme store reads `matchMedia` and `localStorage` at
 * import time, and every surface transitively reaches it. Imported BEFORE any
 * component module — ES module evaluation follows import order — by unit tests
 * that exercise pure seams of those modules and never render.
 *
 * The values are inert: no theme listener can fire, nothing persists. Each is
 * installed only when the real global is absent, so a browser environment is
 * never shadowed.
 */

interface MediaQueryListShim {
  matches: boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
}

const media = (): MediaQueryListShim => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

if (!("window" in globalThis)) {
  Object.assign(globalThis, { window: { matchMedia: media } });
}
if (!("localStorage" in globalThis)) {
  Object.assign(globalThis, {
    localStorage: {
      getItem: (_key: string) => null,
      setItem: (_key: string, _value: string) => {},
      removeItem: (_key: string) => {},
    },
  });
}
