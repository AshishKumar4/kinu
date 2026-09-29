import type { UIMessage } from "ai";

/** Stored rows up to `id`; a live turn's `inFlight` rows are unstored. */
export function messagesUpTo(
  shown: readonly UIMessage[], id: string, stored: number | undefined,
  history: { readonly positions: ReadonlyMap<string, number>; readonly inFlight: number },
): number {
  const position = history.positions.get(id);

  if (position !== undefined) return position + 1;

  // Unpaged live rows form a contiguous suffix; its canonical end is independent of earlier gaps.
  let count = (stored ?? shown.length - history.inFlight) + history.inFlight;

  for (let index = shown.length - 1; index >= 0; index--) {
    if (shown[index]?.id === id) return count;
    count -= 1;
  }

  return 0;
}

export function turnRows(shown: readonly UIMessage[], live: boolean): number {
  const sent = shown.map((message) => message.role).lastIndexOf("user");

  return live && sent >= 0 ? shown.length - sent : 0;
}
