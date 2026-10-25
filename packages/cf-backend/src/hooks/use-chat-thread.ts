/** Staged derivation: a streamed token re-folds only the live window. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EMPTY_TRANSCRIPT_FOLD, extendTranscript, readConversation, restoredRows, sealTranscript, type ChatHistoryEntry, type ConversationMessage, type InlineSteer, type PositionCursor, type PositionPageRequest, type Transcript } from "@kinu.run/core";
import type { UIMessage } from "ai";

import { MAX_PAGE, useHistoryPages, type HistorySegment } from "@/hooks/use-paged-scroll";
import type { ReserveAsk } from "@/hooks/use-growing-scroll";
import type { ReserveRange } from "@/hooks/use-history-reserve";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

const CHAT_PAGE_SIZE = 40;

export interface ChatHistory {
  readonly entries: readonly ChatHistoryEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly errorRange: ReserveRange | null;
  readonly exhausted: boolean;
  readonly loadMore: (urgent?: boolean) => void;
  readonly read: (ask: ReserveAsk) => void;
  readonly retry: () => void;
  readonly reset: () => void;
}

interface ChatReserves {
  readonly top: ReserveRange | null;
  readonly before: ReadonlyMap<string, ReserveRange>;
  readonly tail: ReserveRange | null;
}

export interface ChatThread {
  readonly history: ChatHistory;
  /** The whole conversation, oldest first, read from its history pages, never the window the tab holds; null while the
   *  chat's agent is not known yet. */
  readonly readAll: (() => Promise<ConversationMessage[]>) | null;
  readonly transcript: readonly UIMessage[];
  readonly thread: Transcript;
  readonly reserves: ChatReserves;
  readonly positions: ReadonlyMap<string, number>;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** Where a window the room sent reads on from: `from` is its first row (null: the window is empty), `older` the cursor of
 *  the rows before it, null when it reaches the chat's start. */
export interface SeedEdge {
  readonly from: string | null;
  readonly older: PositionCursor | null;
}

/** Hoisted: a `= []` default mints a new array per render and breaks the thread memo. */
const NO_STEER_RUNS: readonly InlineSteer[] = [];

interface ChatThreadInput {
  readonly rpc: WorkspaceRpc;
  readonly live: readonly UIMessage[];
  /** A delivered empty list still starts the walk; only the store can say the conversation is empty. */
  readonly seeded: boolean;
  /** The newest window's start, as the room sent it. Scroll-back continues from the row shown first, by its window's
   *  cursor: never a page overlapping the rows already shown, and none at all when they reach the chat's start. */
  readonly seedEdge?: SeedEdge | null;
  readonly steerRuns?: readonly InlineSteer[];
  /** Omitted: workspace pane. String: actor pane. Null: actor not known yet, so the walk waits. */
  readonly actor?: string | null;
  /** Sizes the reserve before any page. */
  readonly total?: number | undefined;
}

const NO_MESSAGES: readonly UIMessage[] = [];

/** Rows shown before `next`'s front: a frame holds only the newest window. */
interface Slide { readonly live: readonly UIMessage[]; readonly slid: readonly UIMessage[]; readonly gaps: number }

/** Keeps rows that left the window. An empty frame, or a window disjoint from the last, starts over. */
function slideWindow(prev: Slide, next: readonly UIMessage[]): Slide {
  const first = next[0]?.id;

  if (first === undefined) return { live: next, slid: NO_MESSAGES, gaps: prev.live.length > 0 ? prev.gaps + 1 : prev.gaps };
  const at = prev.live.findIndex((message) => message.id === first);

  if (at > 0) return { live: next, slid: [...prev.slid, ...prev.live.slice(0, at)], gaps: prev.gaps };

  if (at === 0 || prev.live.length === 0) return { live: next, slid: prev.slid, gaps: prev.gaps };

  return { live: next, slid: NO_MESSAGES, gaps: prev.gaps + 1 };
}

/** At least one row, so it can be asked for. `liveStart`: where the shown rows begin, when their window said. */
function liveGap(segments: readonly HistorySegment[], total: number | undefined, live: number, liveStart: number | undefined): ReserveRange | null {
  const last = segments.at(-1);

  if (last === undefined || last.end === Infinity) return null;

  if (liveStart !== undefined) return last.end < liveStart ? { start: last.end, end: liveStart } : null;

  return { start: last.end, end: Math.max(last.end + 1, (total ?? 0) - live) };
}

export function useChatThread({
  rpc, live: frame, seeded, seedEdge = null, steerRuns = NO_STEER_RUNS, actor, total,
}: ChatThreadInput): ChatThread {
  const [slide, setSlide] = useState<Slide>(() => ({ live: frame, slid: NO_MESSAGES, gaps: 0 }));
  const current = slideWindow(slide, frame);

  // Derived in render: it moves when a row joins or leaves, never per token.
  if (current.slid !== slide.slid || current.gaps !== slide.gaps || frame.length !== slide.live.length) setSlide(current);

  const live = useMemo(
    () => current.slid.length === 0 ? frame : [...current.slid, ...frame],
    [current.slid, frame]);

  const readPage = useCallback(
    (request: PositionPageRequest) => rpc("getChatHistoryPage", [
      actor === undefined || actor === null ? request : { ...request, actor },
    ]),
    [rpc, actor],
  );

  const pages = useHistoryPages(readPage, CHAT_PAGE_SIZE);

  const { segments, busy, sizeFor, load, reset } = pages;
  const reading = useRef<ReserveRange | null>(null);

  useEffect(() => {
    if (current.gaps > 0) reset();
  }, [current.gaps, reset]);

  // Each window's start, kept: the rows shown first may be an earlier window's, slid up as newer ones came.
  const edges = useRef(new Map<string, PositionCursor | null>());

  if (seedEdge !== null && seedEdge.from !== null) edges.current.set(seedEdge.from, seedEdge.older);
  // Undefined while the window shown first has not said where it starts. No rows shown start where the room's newest
  // window, empty too, said it does.
  const emptyStart = seedEdge?.from === null ? seedEdge.older : undefined;
  const older = live.length === 0 ? emptyStart : edges.current.get(live[0]?.id ?? "");
  const liveStart = older === undefined ? undefined : older?.before ?? 0;

  const startable = actor !== null && (live.length > 0 || seeded);
  const liveEdge = liveGap(segments, total, live.length, liveStart)?.end;

  // The first page back: from where the rows shown begin. With none shown and no start said it is the newest; with rows
  // whose start is not said yet, it waits for it; with rows, or none, that reach the chat's start, there is none.
  const readNewest = useCallback((urgent: boolean) => {
    const size = Math.min(MAX_PAGE, sizeFor(urgent));

    if (older !== undefined && older !== null) load(size, { cursor: older, limit: size });
    else if (older === undefined && live.length === 0) load(size, { limit: size });
  }, [load, sizeFor, live.length, older]);

  const loadMore = useCallback((urgent = false) => {
    if (!startable || busy() || pages.error !== null) return;
    const first = segments[0];

    if (first === undefined) {
      reading.current = null;
      readNewest(urgent);

      return;
    }

    if (first.start === 0) return;
    const size = sizeFor(urgent);

    reading.current = null;
    load(size, { cursor: { before: first.start }, limit: size });
  }, [startable, busy, pages.error, segments, readNewest, sizeFor, load]);

  const read = useCallback((ask: ReserveAsk) => {
    if (!startable || busy() || pages.error !== null) return;
    reading.current = ask;

    if (ask.from === null && (segments.length === 0 || ask.end === liveEdge)) {
      readNewest(ask.urgent);

      return;
    }

    const size = sizeFor(ask.urgent);
    const before = ask.from === null ? ask.end : Math.min(ask.end, ask.from + size);

    load(size, { cursor: { before }, limit: size });
  }, [startable, busy, pages.error, segments.length, liveEdge, readNewest, sizeFor, load]);

  // Minted once per entry, so a prepended page renders its own rows, not every row below.
  const minted = useRef(new WeakMap<ChatHistoryEntry, UIMessage>());

  const entries = useMemo(() => segments.flatMap((segment) => segment.entries), [segments]);

  const restored = useMemo(() => {
    const seen = new Set<string>();

    return segments.map((segment) => {
      const rows: UIMessage[] = [];

      for (const entry of segment.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const row = minted.current.get(entry) ?? restoredRows([entry])[0];

        if (row === undefined) continue;
        minted.current.set(entry, row);
        rows.push(row);
      }

      return rows;
    });
  }, [segments]);

  const positions = useMemo(() => new Map(entries.map((entry) => [entry.id, entry.position])), [entries]);

  const liveIdsKey = useMemo(() => live.map((message) => message.id).join("\n"), [live]);

  const liveIds = useMemo(
    () => liveIdsKey === "" ? NO_IDS : new Set(liveIdsKey.split("\n")),
    [liveIdsKey]);

  // The sources overlap by construction; the live copy wins because it carries parts the stored copy lost.
  const olderSegments = useMemo(
    () => restored.map((rows) => rows.filter((row) => !liveIds.has(row.id))),
    [restored, liveIds]);

  const olderRows = useMemo(() => olderSegments.flat(), [olderSegments]);

  const transcript = useMemo(
    () => olderRows.length === 0 ? live : [...olderRows, ...live],
    [olderRows, live]);

  const olderFold = useMemo(() => olderSegments.reduce(
    (fold, rows) => extendTranscript(fold, rows, false), EMPTY_TRANSCRIPT_FOLD), [olderSegments]);

  const joinsLive = segments.length === 0 || segments.at(-1)?.end === Infinity;

  const thread = useMemo(
    () => sealTranscript(extendTranscript(olderFold, live, joinsLive), steerRuns),
    [olderFold, live, joinsLive, steerRuns]);

  const reserves = useMemo((): ChatReserves => {
    const first = segments[0];
    let top: ReserveRange | null = null;

    if (first !== undefined) top = first.start > 0 ? { start: 0, end: first.start } : null;
    else if (liveStart !== undefined) top = liveStart > 0 ? { start: 0, end: liveStart } : null;
    else if (total !== undefined && total > live.length) top = { start: 0, end: total - live.length };

    const gaps: ReserveRange[] = [];

    for (let index = 1; index < segments.length; index++) {
      const above = segments[index - 1];
      const below = segments[index];

      if (above !== undefined && below !== undefined) gaps.push({ start: above.end, end: below.start });
    }

    const toLive = liveGap(segments, total, live.length, liveStart);

    if (toLive !== null) gaps.push(toLive);
    const before = new Map<string, ReserveRange>();
    let next = 0;

    for (const { message } of thread.entries) {
      const gap = gaps[next];

      if (gap === undefined) break;
      const at = positions.get(message.id);

      if (at !== undefined && at < gap.end) continue;
      before.set(message.id, gap);
      next += 1;
    }

    return { top, before, tail: gaps[next] ?? null };
  }, [segments, total, live.length, liveStart, thread.entries, positions]);

  const history: ChatHistory = {
    entries, loading: pages.loading, error: pages.error, exhausted: pages.exhausted || (segments.length === 0 && older === null),
    errorRange: pages.error === null ? null : reading.current,
    loadMore, read, retry: pages.retry, reset,
  };

  const readAll = useMemo(() => (actor === null ? null : async () => readConversation(readPage)), [actor, readPage]);

  return { history, readAll, transcript, thread, reserves, positions };
}
