import type { UIMessage } from "ai";

/** Stored rows up to `id`; a live turn's `inFlight` rows are unstored. */
export function messagesUpTo(
  shown: readonly UIMessage[], id: string, stored: number | undefined, walk: { readonly exhausted: boolean; readonly inFlight: number },
): number {
  const upTo = shown.findIndex((message) => message.id === id) + 1;

  if (walk.exhausted) return upTo;
  const loaded = shown.length - walk.inFlight;

  return Math.max(0, (stored ?? loaded) - loaded) + upTo;
}

export function turnRows(shown: readonly UIMessage[], live: boolean): number {
  const sent = shown.map((message) => message.role).lastIndexOf("user");

  return live && sent >= 0 ? shown.length - sent : 0;
}
