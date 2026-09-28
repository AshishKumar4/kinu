/** Staged derivation: a streamed token re-folds only the live window. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as v from "valibot";
import {
  EMPTY_TRANSCRIPT_FOLD, ChatHistoryEntrySchema, extendTranscript, positionPageSchema,
  restoredRows, sealTranscript,
  type ChatHistoryEntry, type InlineSteer, type PositionPageRequest, type Rpc, type Transcript,
} from "@kinu.run/core";
import type { UIMessage } from "ai";

import { MAX_PAGE, useHistoryPages, type HistorySegment } from "@/hooks/use-paged-scroll";
import type { ReserveAsk } from "@/hooks/use-growing-scroll";
import type { ReserveRange } from "@/hooks/use-history-reserve";

const CHAT_PAGE_SIZE = 40;

/** `metadata` must be declared: `v.object` drops undeclared keys, and panes read the author stamp from it. */
const ChatHistoryPageSchema = positionPageSchema(ChatHistoryEntrySchema);

export interface ChatHistory {
  readonly entries: readonly ChatHistoryEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly exhausted: boolean;
  readonly loadMore: (urgent?: boolean) => void;
  readonly read: (ask: ReserveAsk) => void;
  readonly retry: () => void;
  readonly reset: () => void;
}

export interface ChatReserves {
  readonly top: ReserveRange | null;
  readonly before: ReadonlyMap<string, ReserveRange>;
  readonly tail: ReserveRange | null;
}

export interface ChatThread {
  readonly history: ChatHistory;
  readonly transcript: readonly UIMessage[];
  readonly thread: Transcript;
  readonly reserves: ChatReserves;
  readonly positions: ReadonlyMap<string, number>;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** Hoisted: a `= []` default mints a new array per render and breaks the thread memo. */
const NO_STEER_RUNS: readonly InlineSteer[] = [];

export interface ChatThreadInput {
  readonly rpc: Rpc;
  readonly live: readonly UIMessage[];
  /** A delivered empty list still starts the walk; only the store can say the conversation is empty. */
  readonly seeded: boolean;
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

/** At least one row, so it can be asked for. */
function liveGap(segments: readonly HistorySegment[], total: number | undefined, live: number): ReserveRange | null {
  const last = segments.at(-1);

  if (last === undefined || last.end === Infinity) return null;

  return { start: last.end, end: Math.max(last.end + 1, (total ?? 0) - live) };
}

export function useChatThread({
  rpc, live: frame, seeded, steerRuns = NO_STEER_RUNS, actor, total,
}: ChatThreadInput): ChatThread {
  const [slide, setSlide] = useState<Slide>(() => ({ live: frame, slid: NO_MESSAGES, gaps: 0 }));
  const current = slideWindow(slide, frame);

  // Derived in render: it moves when a row joins or leaves, never per token.
  if (current.slid !== slide.slid || current.gaps !== slide.gaps || frame.length !== slide.live.length) setSlide(current);

  const live = useMemo(
    () => current.slid.length === 0 ? frame : [...current.slid, ...frame],
    [current.slid, frame]);

  const pages = useHistoryPages(useCallback(
    (request: PositionPageRequest) => rpc<unknown>("getChatHistoryPage", [
      actor === undefined || actor === null ? request : { ...request, actor },
    ]).then((page) => v.parse(ChatHistoryPageSchema, page)),
    [rpc, actor],
  ), CHAT_PAGE_SIZE);

  const { segments, busy, sizeFor, load, reset } = pages;

  useEffect(() => {
    if (current.gaps > 0) reset();
  }, [current.gaps, reset]);

  const startable = actor !== null && (live.length > 0 || seeded);
  const liveEdge = liveGap(segments, total, live.length)?.end;

  // Overlaps the live rows, so asked a live window larger.
  const readNewest = useCallback((urgent: boolean) => {
    const size = Math.min(MAX_PAGE, sizeFor(urgent) + live.length);

    load(size, { limit: size });
  }, [load, sizeFor, live.length]);

  const loadMore = useCallback((urgent = false) => {
    if (!startable || busy()) return;
    const first = segments[0];

    if (first === undefined) {
      readNewest(urgent);

      return;
    }

    if (first.start === 0) return;
    const size = sizeFor(urgent);

    load(size, { cursor: { before: first.start }, limit: size });
  }, [startable, busy, segments, readNewest, sizeFor, load]);

  const read = useCallback((ask: ReserveAsk) => {
    if (!startable || busy()) return;

    if (ask.from === null && (segments.length === 0 || ask.end === liveEdge)) {
      readNewest(ask.urgent);

      return;
    }

    const size = sizeFor(ask.urgent);
    const before = ask.from === null ? ask.end : Math.min(ask.end, ask.from + size);

    load(size, { cursor: { before }, limit: size });
  }, [startable, busy, segments.length, liveEdge, readNewest, sizeFor, load]);

  // Minted once per entry, so a prepended page renders its own rows, not every row below.
  const minted = useRef(new WeakMap<ChatHistoryEntry, UIMessage>());

  const entries = useMemo(() => segments.flatMap((segment) => segment.entries), [segments]);

  const restored = useMemo(() => {
    const seen = new Set<string>();
    const rows: UIMessage[] = [];

    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const row = minted.current.get(entry) ?? restoredRows([entry])[0];

      if (row === undefined) continue;
      minted.current.set(entry, row);
      rows.push(row);
    }

    return rows;
  }, [entries]);

  const positions = useMemo(() => new Map(entries.map((entry) => [entry.id, entry.position])), [entries]);

  const liveIdsKey = useMemo(() => live.map((message) => message.id).join("\n"), [live]);

  const liveIds = useMemo(
    () => liveIdsKey === "" ? NO_IDS : new Set(liveIdsKey.split("\n")),
    [liveIdsKey]);

  // The sources overlap by construction; the live copy wins because it carries parts the stored copy lost.
  const olderRows = useMemo(
    () => restored.filter((row) => !liveIds.has(row.id)),
    [restored, liveIds]);

  const transcript = useMemo(
    () => olderRows.length === 0 ? live : [...olderRows, ...live],
    [olderRows, live]);

  const olderFold = useMemo(() => extendTranscript(EMPTY_TRANSCRIPT_FOLD, olderRows), [olderRows]);

  const thread = useMemo(
    () => sealTranscript(extendTranscript(olderFold, live), steerRuns),
    [olderFold, live, steerRuns]);

  const reserves = useMemo((): ChatReserves => {
    const first = segments[0];
    let top: ReserveRange | null = null;

    if (first !== undefined) top = first.start > 0 ? { start: 0, end: first.start } : null;
    else if (total !== undefined && total > live.length) top = { start: 0, end: total - live.length };

    const gaps: ReserveRange[] = [];

    for (let index = 1; index < segments.length; index++) {
      const above = segments[index - 1];
      const below = segments[index];

      if (above !== undefined && below !== undefined) gaps.push({ start: above.end, end: below.start });
    }

    const toLive = liveGap(segments, total, live.length);

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
  }, [segments, total, live.length, thread.entries, positions]);

  const history: ChatHistory = {
    entries, loading: pages.loading, error: pages.error, exhausted: pages.exhausted,
    loadMore, read, retry: pages.retry, reset,
  };

  return { history, transcript, thread, reserves, positions };
}
