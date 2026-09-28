/** An unavailable entry (`ChatHistoryEntry.unavailable`) keeps its place with a note:
 *  never an empty bubble, never skipped. */
import { Fragment, type ReactNode } from "react";
import type { TranscriptEntry } from "@kinu.run/core";
import { MessageView } from "@/components/MessageView";

export function KeptTranscript({ entries, unavailable, before }: {
  entries: readonly TranscriptEntry[];
  unavailable: ReadonlySet<string>;
  before?: (id: string) => ReactNode;
}) {
  return (
    <>
      {entries.map(({ message, steers }) => (
        <Fragment key={message.id}>
          {before?.(message.id)}
          {unavailable.has(message.id)
            ? (
              <p role="note" className="rounded-md border border-dashed p-border px-3 py-2 text-xs p-text-3">
                This message is unavailable: it was stored in the agent's private files, which close when it is dismissed.
              </p>
            )
            : <MessageView message={message} steers={steers} liveTail={null} />}
        </Fragment>
      ))}
    </>
  );
}
