import { useCallback, useSyncExternalStore } from 'react';

// Tailwind's breakpoints, which the stylesheet's `sm:`/`md:`/`lg:` read too: a component deciding in script what a class
// decides in CSS reads the same width.

/** From here a menu is a popover rather than a sheet from the bottom. */
export const SM_QUERY = '(min-width: 640px)';

/** From here the app lays out for a desktop: the workbench's panels side by side, the sidebar beside the page. */
export const DESKTOP_QUERY = '(min-width: 768px)';

/** From here a page has room for a second column: Drive's tree, Mail's reader beside its list. */
export const WIDE_QUERY = '(min-width: 1024px)';

/** Set by the reader's system: motion that only decorates stops. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Follows `query`. A server render, and the hydration of one, read true so they lean wide as the markup was drawn. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((changed: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', changed);

    return () => media.removeEventListener('change', changed);
  }, [query]);

  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
}
