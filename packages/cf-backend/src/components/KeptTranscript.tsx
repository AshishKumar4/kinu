/**
 * A kept conversation's rows, oldest first, as a read-only pane draws them.
 *
 * An entry the server could not read for this pane (`ChatHistoryEntry.unavailable`:
 * its content spilled to a dismissed agent's private files) keeps its place and
 * is named for what it is: never an empty bubble, never skipped.
 */
import type { TranscriptEntry } from "@kinu.run/core";
import { MessageView } from "@/components/MessageView";

export function KeptTranscript({ entries, unavailable }: {
  entries: readonly TranscriptEntry[];
  /** Ids of the entries whose page marked them unavailable. */
  unavailable: ReadonlySet<string>;
}) {
  return (
    <>
      {entries.map(({ message, steers }) => unavailable.has(message.id)
        ? (
          <p key={message.id} role="note" className="rounded-md border border-dashed p-border px-3 py-2 text-xs p-text-3">
            This message is unavailable: it was stored in the agent's private files, which close when it is dismissed.
          </p>
        )
        : <MessageView key={message.id} message={message} steers={steers} liveTail={null} />)}
    </>
  );
}
