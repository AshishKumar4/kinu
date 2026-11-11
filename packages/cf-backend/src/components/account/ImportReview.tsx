/**
 * Onboarding's last word on what the person imported a few steps back: the batch their fast model read, to keep in one
 * act before their assistant starts, or how far it has read, since it waits in Settings → Memory either way.
 */
import { useEffect } from "react";
import type { AccountMemoryProposal } from "@kinu.run/core";
import { decideAccountMemory, getAccountMemory } from "../../lib/user-api";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { Surface } from "@/components/ui/Surface";
import { ImportBatch } from "./AccountMemoryCard";
import { useActing } from "./MemoryImport";

/** How often a reading import is read again while its step is open: a piece takes a few seconds on a fast model. */
const READING_POLL_MS = 3000;

export function ImportReview() {
  const { resource, reload } = useAsyncResource(getAccountMemory);
  const { busy, failure, act } = useActing(reload);
  const memory = lastValue(resource);
  const reading = memory?.imports.find((each) => !each.parked) ?? null;
  const batch = memory?.pending.find((each): each is AccountMemoryProposal & { proposal: { kind: "import" } } => each.proposal.kind === "import") ?? null;

  useEffect(() => {
    if (reading === null) return undefined;
    const timer = setTimeout(reload, READING_POLL_MS);

    return () => clearTimeout(timer);
  }, [reading, reload]);

  if (batch !== null) {
    return (
      <Surface look="tile" className="space-y-2 py-2" data-welcome-import-review>
        <p className="t-body p-text px-3">Before your assistant starts: keep what your model read about you?</p>
        <ImportBatch key={batch.id} item={batch} busy={busy} act={act} decide={async (id, decision, facts) => { await decideAccountMemory(id, decision, facts); }} />
        {failure !== null && <p className="t-meta p-danger px-3">{failure}</p>}
      </Surface>
    );
  }

  if (reading === null) return null;

  return (
    <p className="t-meta p-text-3" data-welcome-import-reading>
      Your model is reading what you imported: part {Math.min(reading.read + 1, reading.pieces)} of {reading.pieces}. It will wait for you in
      Settings → Memory if you finish first.
    </p>
  );
}
