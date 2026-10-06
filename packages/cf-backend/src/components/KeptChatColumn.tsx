/** A dismissed agent's read-only chat, paged by its actor id. */
import { useMemo } from "react";
import type { UIMessage } from "ai";
import { Loader } from "@cloudflare/kumo";
import type { Rpc } from "@kinu.run/core";
import { useChatThread } from "@/hooks/use-chat-thread";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { KeptTranscript } from "@/components/KeptTranscript";
import { TranscriptViewport } from "@/components/TranscriptViewport";

/** Hoisted, so the thread memos hold. */
const NO_LIVE: readonly UIMessage[] = [];

export function KeptChatColumn({ workspace, subName, title, rpc, actorId }: {
  workspace: string;
  subName: string;
  title: string;
  rpc: Rpc;
  actorId: string | null;
}) {
  const chat = useChatThread({ rpc, live: NO_LIVE, seeded: true, actor: actorId });
  const { history } = chat;

  const unavailable = useMemo(
    () => new Set(history.entries.flatMap((entry) => entry.unavailable === true ? [entry.id] : [])),
    [history.entries]);

  return (
    <div className="@container relative flex flex-col flex-1 min-h-0" data-agent-pane={`${workspace}/agents/${subName}`}>
      <ErrorBoundary label="Agent chat">
        <TranscriptViewport chat={chat} live={false} padClass="py-5"
          pending={<div role="status" aria-busy="true" className="flex justify-center py-4"><Loader size="sm" /></div>}
          empty={<p className="text-center text-sm p-text-3">{title} said nothing before it was dismissed.</p>}
          rows={(before) => <KeptTranscript entries={chat.thread.entries} unavailable={unavailable} before={before} />} />
      </ErrorBoundary>
      <p role="note" className="border-t p-border p-sidebar px-4 py-3 text-xs p-text-3">
        {title} was dismissed. Its conversation is kept and read-only.
      </p>
    </div>
  );
}
