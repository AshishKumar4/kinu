import { useState } from "react";
import type { NoteReply } from "@kinu.run/core";

/** The replies under one comment, oldest first, and the owner's composer while the revision is open for review. */
export function CommentThread({ replies, agentName, seenAt, onReply, onDelete }: {
  replies: readonly NoteReply[];
  agentName: string;
  /** Replies from the agent written after this are marked new. */
  seenAt: number;
  /** Absent when the thread is read-only. */
  onReply?: ((text: string) => void) | undefined;
  /** Deletes one of the owner's unsent replies. */
  onDelete?: ((id: string) => void) | undefined;
}) {
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");

  if (replies.length === 0 && onReply === undefined) return null;

  const send = (): void => {
    const reply = text.trim();

    if (reply === "" || onReply === undefined) return;
    onReply(reply);
    setText("");
    setWriting(false);
  };

  return (
    <div data-comment-thread className="mt-2 space-y-2" onClick={(event) => event.stopPropagation()}>
      {replies.map((reply) => {
        const fresh = reply.author === "agent" && reply.createdA > seenAt;

        return (
          <div key={reply.id} data-comment-reply={reply.author} className="border-l-2 border-border pl-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="font-semibold text-foreground/80">{reply.author === "agent" ? agentName : "You"}</span>
              <time dateTime={new Date(reply.createdA).toISOString()}>
                {new Date(reply.createdA).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              {fresh && <span data-comment-reply-new className="rounded-full bg-primary/10 px-1.5 font-medium text-primary">New</span>}
              {onDelete !== undefined && reply.author === "owner" && reply.revision === undefined && (
                <button type="button" className="ml-auto rounded px-1.5 text-destructive hover:bg-destructive/10" onClick={() => onDelete(reply.id)}>Delete</button>
              )}
            </div>
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-foreground/90">{reply.text}</p>
          </div>
        );
      })}
      {onReply !== undefined && (writing ? (
        <div>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
            }}
            aria-label="Reply"
            placeholder="Reply"
            className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button type="button" className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted" onClick={() => { setText(""); setWriting(false); }}>Cancel</button>
            <button type="button" className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40" disabled={text.trim() === ""} onClick={send}>Reply</button>
          </div>
        </div>
      ) : (
        <button type="button" data-comment-reply-open className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setWriting(true)}>Reply</button>
      ))}
    </div>
  );
}
