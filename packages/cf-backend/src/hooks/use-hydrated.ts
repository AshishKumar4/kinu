import { useSyncExternalStore } from 'react';

const unchanging = (): (() => void) => () => {};

/** False in a server render and while hydrating one, true after: what only a browser can draw waits for it. */
export function useHydrated(): boolean {
  return useSyncExternalStore(unchanging, () => true, () => false);
}
