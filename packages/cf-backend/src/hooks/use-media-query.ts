import { useCallback, useSyncExternalStore } from 'react';

/** Follows `query`. A server render, and the hydration of one, read true so they lean wide as the markup was drawn. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((changed: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', changed);

    return () => media.removeEventListener('change', changed);
  }, [query]);

  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
}
