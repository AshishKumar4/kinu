/** Staged derivation: a streamed token re-folds only the live window. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as v from "valibot";
import {
  EMPTY_TRANSCRIPT_FOLD, ChatHistoryEntrySchema, extendTranscript, pageSchema, unreadRows,
  restoredRows, sealTranscript,
  type ChatHistoryEntry, type InlineSteer, type Transcript,
} from "@kinu.run/core";
import type { UIMessage } from "ai";

import { usePagedScroll, walkStart, type PagedScroll } from "@/hooks/use-paged-scroll";
import type { Rpc } from "@kinu.run/core";

const CHAT_PAGE_SIZE = 40;

/** `metadata` must be declared: `v.object` drops undeclared keys, and panes read the author stamp from it. */
const ChatHistoryPageSchema = v.intersect([pageSchema(ChatHistoryEntrySchema), v.object({ walked: v.number() })]);

export interface ChatThread {
  readonly history: PagedScroll<ChatHistoryEntry>;
  readonly transcript: readonly UIMessage[];
  readonly thread: Transcript;
  readonly unread: number;
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

export function useChatThread({
  rpc, live: frame, seeded, steerRuns = NO_STEER_RUNS, actor, total,
}: ChatThreadInput): ChatThread {
  const [walked, setWalked] = useState(0);
  const [slide, setSlide] = useState<Slide>(() => ({ live: frame, slid: NO_MESSAGES, gaps: 0 }));
  const current = slideWindow(slide, frame);

  // Derived in render: it moves when a row joins or leaves, never per token.
  if (current.slid !== slide.slid || current.gaps !== slide.gaps || frame.length !== slide.live.length) setSlide(current);

  const live = useMemo(
    () => current.slid.length === 0 ? frame : [...current.slid, ...frame],
    [current.slid, frame]);

  const oldest = live[0]?.id;

  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(
      (cursor, limit) => rpc<unknown>("getChatHistoryPage", [
        actor === undefined || actor === null ? { cursor, limit } : { cursor, limit, actor },
      ]).then((raw) => {
        const page = v.parse(ChatHistoryPageSchema, raw);

        setWalked((before) => before + page.walked);

        return page;
      }),
      [rpc, actor],
    ),
    pageSize: CHAT_PAGE_SIZE,
    startFrom: useCallback(
      () => actor === null ? null : walkStart(oldest, seeded),
      [actor, oldest, seeded]),
  });

  const { reset } = history;

  useEffect(() => {
    if (current.gaps > 0) reset();
  }, [current.gaps, reset]);

  if (history.fetched.length === 0 && !history.loading && walked !== 0) setWalked(0);

  // Minted once per entry, so a prepended page renders its own rows, not every row below.
  const minted = useRef(new WeakMap<ChatHistoryEntry, UIMessage>());

  const restored = useMemo(() => {
    const seen = new Set<string>();
    const rows: UIMessage[] = [];

    for (const entry of history.fetched) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const row = minted.current.get(entry) ?? restoredRows([entry])[0];

      if (row === undefined) continue;
      minted.current.set(entry, row);
      rows.push(row);
    }

    return rows;
  }, [history.fetched]);

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

  const unread = unreadRows({ total, walked, shown: history.fetched.length, live: live.length, exhausted: history.exhausted });

  return { history, transcript, thread, unread };
}
