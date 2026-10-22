import { useState } from "react";
import type { NoteReply } from "@kinu.run/core";
import { TextArea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

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
          <div key={reply.id} data-comment-reply={reply.author} className="border-l-2 p-border pl-2">
            <div className="t-meta flex items-center gap-2 text-muted-foreground">
              <span className="p-text-2">{reply.author === "agent" ? agentName : "You"}</span>
              <time dateTime={new Date(reply.createdA).toISOString()}>
                {new Date(reply.createdA).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
              {fresh && <Badge tone="accent" data-comment-reply-new="">New</Badge>}
              {onDelete !== undefined && reply.author === "owner" && reply.revision === undefined && (
                <Button variant="danger" size="sm" className="ml-auto" onClick={() => onDelete(reply.id)}>Delete</Button>
              )}
            </div>
            <p className="t-meta mt-px whitespace-pre-wrap text-foreground/90">{reply.text}</p>
          </div>
        );
      })}
      {onReply !== undefined && (writing ? (
        <div>
          <TextArea className="min-h-16 w-full resize-y" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
            }} aria-label="Reply" placeholder="Reply" autoFocus />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setText(""); setWriting(false); }}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={text.trim() === ""} onClick={send}>Reply</Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" data-comment-reply-open onClick={() => setWriting(true)}>Reply</Button>
      ))}
    </div>
  );
}
