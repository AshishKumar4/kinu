import { useCallback, useSyncExternalStore } from 'react';

/** From here the app lays out for a desktop: the workbench's panels side by side, the sidebar beside the page. */
export const DESKTOP_QUERY = '(min-width: 768px)';

/** Follows `query`. A server render, and the hydration of one, read true so they lean wide as the markup was drawn. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((changed: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', changed);

    return () => media.removeEventListener('change', changed);
  }, [query]);

  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
}
