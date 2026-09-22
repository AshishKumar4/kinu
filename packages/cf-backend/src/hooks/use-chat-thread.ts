/**
 * Derivation is staged: restored rows move only when a page lands, the overlap filter only when
 * the live ID set changes, so a streamed token re-folds the live window alone.
 */
import { useCallback, useMemo } from "react";
import * as v from "valibot";
import {
  EMPTY_TRANSCRIPT_FOLD, ChatHistoryEntrySchema, extendTranscript, pageSchema,
  restoredRows, sealTranscript,
  type ChatHistoryEntry, type InlineSteer, type Transcript,
} from "@kinu.run/core";
import type { UIMessage } from "ai";

import { usePagedScroll, walkStart, type PagedScroll } from "@/hooks/use-paged-scroll";
import type { Rpc } from "@kinu.run/core";

const CHAT_PAGE_SIZE = 40;

/** `metadata` must be declared: `v.object` drops undeclared keys, and panes read the author stamp from it. */
const ChatHistoryPageSchema = pageSchema(ChatHistoryEntrySchema);

export interface ChatThread {
  readonly history: PagedScroll<ChatHistoryEntry>;
  readonly transcript: readonly UIMessage[];
  readonly thread: Transcript;
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
}

export function useChatThread({
  rpc, live, seeded, steerRuns = NO_STEER_RUNS, actor,
}: ChatThreadInput): ChatThread {
  const oldest = live[0]?.id;

  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(
      (cursor) => rpc<unknown>("getChatHistoryPage", [
        actor === undefined || actor === null
          ? { cursor, limit: CHAT_PAGE_SIZE }
          : { cursor, limit: CHAT_PAGE_SIZE, actor },
      ]).then((page) => v.parse(ChatHistoryPageSchema, page)),
      [rpc, actor],
    ),
    startFrom: useCallback(
      () => actor === null ? null : walkStart(oldest, seeded),
      [actor, oldest, seeded]),
  });

  // Row identities are minted once per page, so memo(MessageView) holds across ticks.
  const restored = useMemo(() => restoredRows(history.fetched), [history.fetched]);

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

  return { history, transcript, thread };
}
