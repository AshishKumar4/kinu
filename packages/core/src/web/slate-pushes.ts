/** What answers' pages' servers push (`SLATE_PUSH_EVENT`), told in the tab that draws them to each frame of the page. */
import type { JsonValue } from '../utils/json';

type Listener = (data: JsonValue) => void;

const listeners = new Map<string, Set<Listener>>();

export const slatePushes = {
  /** Tells each frame that draws `page` in this tab what its server pushed. */
  deliver(page: string, data: JsonValue): void {
    for (const listener of listeners.get(page) ?? []) listener(data);
  },

  /** Hears what `page`'s server pushes while the returned function has not been called. */
  on(page: string, listener: Listener): () => void {
    const heard = listeners.get(page) ?? new Set<Listener>();

    heard.add(listener);
    listeners.set(page, heard);

    return () => {
      heard.delete(listener);

      if (heard.size === 0) listeners.delete(page);
    };
  },
};
