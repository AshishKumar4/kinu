/** A value held outside React, which components read through `useSyncExternalStore(store.subscribe, store.snapshot)`. */
export interface Store<T> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => T;
  readonly set: (next: T) => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    subscribe: (listener) => {
      listeners.add(listener);

      return () => { listeners.delete(listener); };
    },
    snapshot: () => value,
    set: (next) => {
      value = next;

      for (const listener of listeners) listener();
    },
  };
}
