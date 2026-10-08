import type { ReactNode } from "react";
import type { ChatThread } from "@/hooks/use-chat-thread";
import type { GrowingScrollOptions } from "@/hooks/use-growing-scroll";
import { HistoryReserve, historyBoundaryError, useReservedScroll } from "@/hooks/use-history-reserve";
import { ConversationStartBoundary, HistoryBoundary } from "@/components/surfaces/shared";

/** One chat's scrolling transcript: `rows` places each entry after its `before` reserve. */
export function TranscriptViewport({ chat, live, startFirst = false, padClass, pending, empty, scroll, rows, children }: {
  chat: Pick<ChatThread, "history" | "transcript" | "thread" | "reserves">;
  live: boolean;
  /** Main's start sits above unread history; an agent's below its boundary. */
  startFirst?: boolean;
  padClass: string;
  pending: ReactNode;
  empty: ReactNode;
  scroll?: Pick<GrowingScrollOptions, "initialScroll" | "onScrollPosition" | "settled">;
  rows: (before: (id: string) => ReactNode) => ReactNode;
  children?: ReactNode;
}) {
  const { history, transcript, thread, reserves } = chat;

  const { ref, rowPx } = useReservedScroll({
    grows: "up",
    content: transcript,
    fetched: history.entries,
    loading: history.loading,
    onReachEdge: history.loadMore,
    onReserve: history.read,
    ...scroll,
  });

  const hasEntries = thread.entries.length > 0;
  const error = historyBoundaryError(history);

  const start = (
    <ConversationStartBoundary hasEntries={hasEntries} streaming={live} error={error} exhausted={history.exhausted}
      onRetry={history.retry} pending={pending} empty={empty} />
  );

  return (
    <div ref={ref} data-thread className={`flex-1 overflow-y-auto p-thread-column space-y-5 ${padClass}`}>
      {startFirst && start}
      <HistoryReserve range={reserves.top} rowPx={rowPx} history={history} />
      {hasEntries && <HistoryBoundary loading={history.loading} error={error} exhausted={history.exhausted} onRetry={history.retry} />}
      {!startFirst && start}
      {rows((id) => <HistoryReserve range={reserves.before.get(id)} rowPx={rowPx} history={history} />)}
      <HistoryReserve range={reserves.tail} rowPx={rowPx} history={history} />
      {children}
    </div>
  );
}
