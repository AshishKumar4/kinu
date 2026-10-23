import type { JsonValue } from "@kinu.run/core";

type Listener = (data: JsonValue) => void;

const listeners = new Map<string, Set<Listener>>();

/** A push for an answer's page (`SLATE_PUSH_EVENT`), told to each frame that draws it in this tab. */
export function deliverSlatePush(page: string, data: JsonValue): void {
  for (const listener of listeners.get(page) ?? []) listener(data);
}

/** Hears what `page`'s server pushes while the returned function has not been called. */
export function onSlatePush(page: string, listener: Listener): () => void {
  const heard = listeners.get(page) ?? new Set<Listener>();

  heard.add(listener);
  listeners.set(page, heard);

  return () => {
    heard.delete(listener);

    if (heard.size === 0) listeners.delete(page);
  };
}
