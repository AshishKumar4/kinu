/**
 * Inert `matchMedia`/`localStorage` shims the theme store reads at import time; import before any component
 * module. Installed only when absent, so a browser is never shadowed.
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
