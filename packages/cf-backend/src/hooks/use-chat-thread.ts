/**
 * The whole thread of a chat, for any chat.
 *
 * A pane's live list is the agents SDK's `get-messages` seed — `Think.messages`,
 * a bounded newest window governed by `hydrationByteBudget` — plus everything
 * the socket has streamed since. Anything older exists only in storage and is
 * reached one cursored page at a time, over `getChatHistoryPage`.
 *
 * One hook because there is one contract and two panes. Both columns need the
 * walk. Workspace and subordinate panes share one paginated transcript
 * contract: each actor has its own conversation over the shared workspace
 * database, and a helper that worked for an hour has more of one than the
 * window holds. Without the walk everything past the window is not slow to
 * reach, it is unreachable, and the pane has no affordance saying so.
 * Copying the workspace column's four hooks across would make that one
 * contract into two.
 *
 * ── Why the derivation is staged (KINU-072) ─────────────────────────────────
 * Every streamed token replaces the live list. Re-deriving the thread from
 * scratch on each one would rebuild a Set of live ids and re-project every
 * restored row, then walk the whole merged list in `buildTranscript` and build
 * a second Set — cost growing with the conversation, per token, plus fresh row
 * identities that break `memo(MessageView)` for every historical message. The
 * stages below pin what cannot have changed inside a tick: the restored
 * projection moves only when a page lands, the overlap filter only when the
 * live window's ID SET changes, and the settled half's fold only when either of
 * those does. A token re-folds the live window alone.
 */
import { useCallback, useMemo } from "react";
import * as v from "valibot";
import {
  EMPTY_TRANSCRIPT_FOLD, JsonObjectSchema, extendTranscript, pageSchema,
  restoredRows, sealTranscript,
  type ChatHistoryEntry, type InlineSteer, type Page, type Transcript,
} from "@kinu.run/core";
import type { UIMessage } from "ai";

import { usePagedScroll, walkStart, type PagedScroll } from "@/hooks/use-paged-scroll";
import type { Rpc } from "@/lib/protocol";

/** Messages per older-history request. Small enough that a page renders in one
 *  frame and the scroll stays smooth, large enough that a flick up does not
 *  need a dozen round trips. */
const CHAT_PAGE_SIZE = 40;

/**
 * The wire shape of one page.
 *
 * `metadata` is on it because it is not presentation: it is the author stamp and
 * the `kinuEvent` name a pane decides who wrote a row from, and the restored row
 * carries it for exactly that reason. Valibot's `v.object` drops what it does
 * not declare, so leaving it out silently undid that on the way in — a
 * background notice kept its card while it was live and became an ordinary
 * message the moment the reader scrolled back to it.
 */
const ChatHistoryPageSchema: v.GenericSchema<Page<ChatHistoryEntry>> = pageSchema(v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  role: v.picklist(["user", "assistant", "system"]),
  content: v.string(),
  createdAt: v.union([v.string(), v.number()]),
  metadata: v.optional(JsonObjectSchema),
}));

export interface ChatThread {
  /** The walk, for the loading/error/exhausted affordance and the scroller. */
  readonly history: PagedScroll<ChatHistoryEntry>;
  /** Fetched history and the live list as one list, oldest first, deduplicated
   *  where the two sources overlap. */
  readonly transcript: readonly UIMessage[];
  /** The thread as the chat draws it — every steer inside the turn that read
   *  it, and only an unplaceable one trailing. */
  readonly thread: Transcript;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** The default `steerRuns`, hoisted. A `= []` in the signature mints a fresh
 *  array on every render, which is a changed dependency — so the thread memo
 *  below could never hold for a caller that omitted the argument, and the
 *  staging this whole file exists for would be undone by the parameter list. */
const NO_STEER_RUNS: readonly InlineSteer[] = [];

/**
 * @param live the pane's live message list, oldest first.
 * @param seeded whether the server has stated that list's contents at all. A
 *   DELIVERED empty list is not a finished conversation — it is a live view that
 *   came up with nothing, and only the store can say which. That distinction is
 *   `walkStart`'s, and it is why an empty seed still starts the walk.
 * @param steerRuns the server's account of this session's mid-turn steers
 *   (`useKinu().steerRuns`); ones whose durable row has arrived are dropped
 *   here, so the thread shows each steer once — never both copies.
 */
export function useChatThread(
  rpc: Rpc, live: readonly UIMessage[], seeded: boolean,
  steerRuns: readonly InlineSteer[] = NO_STEER_RUNS,
): ChatThread {
  const oldest = live[0]?.id;

  const history = usePagedScroll<ChatHistoryEntry>({
    grows: "up",
    fetchPage: useCallback(
      (cursor) => rpc<unknown>("getChatHistoryPage", [{ cursor, limit: CHAT_PAGE_SIZE }])
        .then((page) => v.parse(ChatHistoryPageSchema, page)),
      [rpc],
    ),
    startFrom: useCallback(() => walkStart(oldest, seeded), [oldest, seeded]),
  });

  // Row identities are minted when a page lands and never again — a restored
  // message keeps its object across stream ticks, so memo(MessageView) holds.
  const restored = useMemo(() => restoredRows(history.fetched), [history.fetched]);

  // The live window's ids, keyed by content: the Set (and everything hanging
  // off it) is rebuilt when a message arrives or is replaced, not per token.
  const liveIdsKey = useMemo(() => live.map((message) => message.id).join("\n"), [live]);

  const liveIds = useMemo(
    () => liveIdsKey === "" ? NO_IDS : new Set(liveIdsKey.split("\n")),
    [liveIdsKey]);

  // The two sources overlap by construction: the walk seeks strictly older
  // than an anchor minted from a list the socket keeps extending, and a
  // reconnect can re-seed a wider window. The live copy wins — it carries the
  // parts the stored copy has been flattened out of.
  const olderRows = useMemo(
    () => restored.filter((row) => !liveIds.has(row.id)),
    [restored, liveIds]);

  const transcript = useMemo(
    () => olderRows.length === 0 ? live : [...olderRows, ...live],
    [olderRows, live]);

  // The settled half's fold survives the tick; each token re-folds only the
  // live window on top of it. Entry identities in the settled half are stable
  // for the same reason restored row identities are.
  const olderFold = useMemo(() => extendTranscript(EMPTY_TRANSCRIPT_FOLD, olderRows), [olderRows]);

  const thread = useMemo(
    () => sealTranscript(extendTranscript(olderFold, live), steerRuns),
    [olderFold, live, steerRuns]);

  return { history, transcript, thread };
}
