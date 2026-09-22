/** A dismissed agent's retired chat: no socket, no composer. Pages the kept transcript over
 *  the workspace's socket by the roster row's actor id (`getChatHistoryPage({ actor })`). */
import { useMemo } from "react";
import type { UIMessage } from "ai";
import { Loader } from "@cloudflare/kumo";
import type { Rpc } from "@kinu.run/core";
import { useChatThread } from "@/hooks/use-chat-thread";
import { useGrowingScroll } from "@/hooks/use-growing-scroll";
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
  const { history, transcript, thread } = useChatThread({ rpc, live: NO_LIVE, seeded: true, actor: actorId });

  const unavailable = useMemo(
    () => new Set(history.fetched.flatMap((entry) => entry.unavailable === true ? [entry.id] : [])),
    [history.fetched]);

  const messagesRef = useGrowingScroll({
    grows: "up",
    content: transcript,
    fetched: history.fetched,
    loading: history.loading,
    onReachEdge: history.loadMore,
    exhausted: history.exhausted,
  });

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={`${workspace}/agents/${subName}`}>
      <ErrorBoundary label="Agent chat">
        <div ref={messagesRef} className="flex-1 overflow-y-auto p-thread-column py-5 space-y-5">
          {thread.entries.length > 0 && (
            <HistoryBoundary
              loading={history.loading}
              error={history.error}
              exhausted={history.exhausted}
              onRetry={history.loadMore}
            />
          )}
          <ConversationStartBoundary
            hasEntries={thread.entries.length > 0}
            streaming={false}
            error={history.error}
            exhausted={history.exhausted}
            onRetry={history.loadMore}
            pending={<div role="status" aria-busy="true" className="flex justify-center py-4"><Loader size="sm" /></div>}
            empty={<p className="text-center text-sm p-text-3">{title} said nothing before it was dismissed.</p>}
          />
          <KeptTranscript entries={thread.entries} unavailable={unavailable} />
        </div>
      </ErrorBoundary>
      <p role="note" className="border-t p-border p-sidebar px-4 py-3 text-xs p-text-3">
        {title} was dismissed. Its conversation is kept and read-only.
      </p>
    </div>
  );
}
