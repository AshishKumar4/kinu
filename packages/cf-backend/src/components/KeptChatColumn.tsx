/** A dismissed agent's read-only chat, paged over the workspace's socket by its actor id. */
import { useMemo } from "react";
import type { UIMessage } from "ai";
import { Loader } from "@cloudflare/kumo";
import type { Rpc } from "@kinu.run/core";
import { useChatThread } from "@/hooks/use-chat-thread";
import { HistoryReserve, useReservedScroll } from "@/hooks/use-history-reserve";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { KeptTranscript } from "@/components/KeptTranscript";
import { ConversationStartBoundary, HistoryBoundary } from "@/components/surfaces/shared";

/** Hoisted so the thread's memos hold across renders. */
const NO_LIVE: readonly UIMessage[] = [];

export function KeptChatColumn({ workspace, subName, title, rpc, actorId }: {
  workspace: string;
  subName: string;
  title: string;
  rpc: Rpc;
  actorId: string | null;
}) {
  const { history, transcript, thread, reserves } = useChatThread({ rpc, live: NO_LIVE, seeded: true, actor: actorId });

  const unavailable = useMemo(
    () => new Set(history.entries.flatMap((entry) => entry.unavailable === true ? [entry.id] : [])),
    [history.entries]);

  const { ref: messagesRef, rowPx } = useReservedScroll({
    grows: "up",
    content: transcript,
    fetched: history.entries,
    loading: history.loading,
    onReachEdge: history.loadMore,
    onReserve: history.read,
  });

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={`${workspace}/agents/${subName}`}>
      <ErrorBoundary label="Agent chat">
        <div ref={messagesRef} className="flex-1 overflow-y-auto p-thread-column py-5 space-y-5">
          <HistoryReserve range={reserves.top} rowPx={rowPx} />
          {thread.entries.length > 0 && (
            <HistoryBoundary
              loading={history.loading}
              error={history.error}
              exhausted={history.exhausted}
              onRetry={history.retry}
            />
          )}
          <ConversationStartBoundary
            hasEntries={thread.entries.length > 0}
            streaming={false}
            error={history.error}
            exhausted={history.exhausted}
            onRetry={history.retry}
            pending={<div role="status" aria-busy="true" className="flex justify-center py-4"><Loader size="sm" /></div>}
            empty={<p className="text-center text-sm p-text-3">{title} said nothing before it was dismissed.</p>}
          />
          <KeptTranscript entries={thread.entries} unavailable={unavailable}
            before={(id) => <HistoryReserve range={reserves.before.get(id)} rowPx={rowPx} />} />
          <HistoryReserve range={reserves.tail} rowPx={rowPx} />
        </div>
      </ErrorBoundary>
      <p role="note" className="border-t p-border p-sidebar px-4 py-3 text-xs p-text-3">
        {title} was dismissed. Its conversation is kept and read-only.
      </p>
    </div>
  );
}
