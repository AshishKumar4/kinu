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

export function unreadRows(input: {
  readonly total: number | undefined; readonly walked: number; readonly shown: number; readonly live: number;
  readonly exhausted: boolean;
}): number {
  if (input.total === undefined || input.exhausted) return 0;
  const share = input.walked > 0 ? Math.min(1, input.shown / input.walked) : 1;

  if (share === 0) return 0;

  return Math.max(0, Math.round((input.total - input.walked - input.live / share) * share));
}
