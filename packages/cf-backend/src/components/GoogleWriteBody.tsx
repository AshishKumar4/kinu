/**
 * A call an agent asked to make at Google that writes, as its approval card shows it in Needs-you (`AttentionStack`):
 * what it does, the message it sends or keeps when there is one, and the call exactly. Approving makes this call once.
 */
import type { GoogleWrite } from "@kinu.run/core";
import { revealMisrepresenting } from "@kinu.run/core";
import { Surface } from "@/components/ui/Surface";

export function GoogleWriteBody({ write }: { write: GoogleWrite }) {
  const { mail } = write;

  return (
    <>
      <div className="t-body p-text">{write.by} wants Google to: {write.does}</div>
      {mail !== null && (
        <dl className="t-meta mt-1 grid grid-cols-[var(--layout-label-auto)] gap-x-3" data-google-write-mail>
          <dt className="p-text-3">To</dt><dd className="truncate p-text-2">{mail.to || "(no one yet)"}</dd>
          {mail.cc !== "" && <><dt className="p-text-3">Cc</dt><dd className="truncate p-text-2">{mail.cc}</dd></>}
          <dt className="p-text-3">Subject</dt><dd className="truncate p-text-2">{mail.subject}</dd>
          <dt className="p-text-3">Begins</dt><dd className="p-text-2 break-words">{mail.start}</dd>
        </dl>
      )}
      <Surface look="tile" as="code" className="t-code mt-1 block max-h-36 overflow-auto px-2 py-1 p-text-2 break-all whitespace-pre-wrap" data-google-write-call>
        {revealMisrepresenting(`${write.method}\n${JSON.stringify({ params: write.params, ...(write.body !== null && { body: write.body }) }, null, 2)}`)}
      </Surface>
    </>
  );
}
