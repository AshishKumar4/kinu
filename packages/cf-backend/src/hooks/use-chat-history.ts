/**
 * The older half of a chat, for any chat.
 *
 * A pane's live list is the agents SDK's `get-messages` seed — `Think.messages`,
 * a bounded newest window governed by `hydrationByteBudget` — plus everything
 * the socket has streamed since. Anything older exists only in storage and is
 * reached one cursored page at a time, over `getChatHistoryPage`.
 *
 * One hook because there is one contract and two panes. The workspace column had
 * the walk; the subordinate column had a comment saying it did not need one — "a
 * subordinate facet's transcript is one delegation, and the SDK's seed already
 * carries all of it" — which is not a property of a subordinate. A facet runs
 * `initWorkspaceSchema` against its own storage and keeps its own conversation,
 * and a helper that worked for an hour has more of one than the window holds. So
 * everything past the window was not slow to reach, it was unreachable, and the
 * pane had no affordance saying so. Copying the workspace column's four hooks
 * across would have made that one contract into two.
 */
import { useCallback, useMemo } from "react";
import * as v from "valibot";
import {
  JsonObjectSchema, mergeTranscript, pageSchema,
  type ChatHistoryEntry, type Page,
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
 * the `kinuEvent` name a pane decides who wrote a row from, and `mergeTranscript`
 * carries it onto the restored message for exactly that reason. Valibot's
 * `v.object` drops what it does not declare, so leaving it out silently undid
 * that on the way in — a background notice kept its card while it was live and
 * became an ordinary message the moment the reader scrolled back to it.
 */
const ChatHistoryPageSchema: v.GenericSchema<Page<ChatHistoryEntry>> = pageSchema(v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  role: v.picklist(["user", "assistant", "system"]),
  content: v.string(),
  createdAt: v.union([v.string(), v.number()]),
  metadata: v.optional(JsonObjectSchema),
}));

export interface ChatHistory {
  /** The walk, for the loading/error/exhausted affordance and the scroller. */
  readonly history: PagedScroll<ChatHistoryEntry>;
  /** Fetched history and the live list as one list, oldest first, deduplicated
   *  where the two sources overlap. */
  readonly transcript: readonly UIMessage[];
}

/**
 * @param live the pane's live message list, oldest first.
 * @param seeded whether the server has stated that list's contents at all. A
 *   DELIVERED empty list is not a finished conversation — it is a live view that
 *   came up with nothing, and only the store can say which. That distinction is
 *   `walkStart`'s, and it is why an empty seed still starts the walk.
 */
export function useChatHistory(
  rpc: Rpc, live: readonly UIMessage[], seeded: boolean,
): ChatHistory {
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
  const transcript = useMemo(
    () => mergeTranscript(history.fetched, live), [history.fetched, live]);
  return { history, transcript };
}
