/** An unavailable entry (`ChatHistoryEntry.unavailable`) keeps its place with a note:
 *  never an empty bubble, never skipped. */
import { Fragment, type ReactNode } from "react";
import type { TranscriptEntry } from "@kinu.run/core";
import { MessageView } from "@/components/MessageView";
import { Surface } from "@/components/ui/Surface";

export function KeptTranscript({ entries, unavailable, before }: {
  entries: readonly TranscriptEntry[];
  unavailable: ReadonlySet<string>;
  before?: (id: string) => ReactNode;
}) {
  return (
    <>
      {entries.map(({ message, steers, landed }) => (
        <Fragment key={message.id}>
          {before?.(message.id)}
          {unavailable.has(message.id)
            ? (
              <Surface look="clip" as="p" className="t-meta border border-dashed p-border px-3 py-2 p-text-3" role="note">
                This message is unavailable: it was stored in the agent's private files, which close when it is dismissed.
              </Surface>
            )
            : <MessageView message={message} steers={steers} landed={landed} liveTail={null} />}
        </Fragment>
      ))}
    </>
  );
}
