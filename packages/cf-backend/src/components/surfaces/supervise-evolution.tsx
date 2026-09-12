/**
 * The Supervise altitude's Evolution content: the self-changes the workspace's
 * changelog records. The digest read itself decides what counts — the page
 * asks for `changesOnly`, so the kinds that are measurements (`outcomes`,
 * `replay`) never arrive: a window that closed quietly renders NOTHING — no
 * heading, no card, no empty state.
 */
import { Badge } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import * as v from "valibot";

export const EvolutionEntrySchema = v.object({
  id: v.string(), kind: v.string(), at: v.number(),
  summary: v.string(), evidence: v.optional(v.nullable(v.string())),
});

export type EvolutionEntry = v.InferOutput<typeof EvolutionEntrySchema>;

/** The loaded changes, newest first. An empty list mounts nothing — a digest
 *  of only bookkeeping must not leave a heading behind. */
export function EvolutionSection({ entries }: { entries: readonly EvolutionEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SparkleIcon size={16} className="p-accent" />
        <h2 className="text-sm font-semibold p-text">Evolution</h2>
        <Badge variant="secondary">{entries.length}</Badge>
      </div>
      <div className="p-group">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-2.5 px-4 py-2.5">
            <span className="shrink-0 p-annotation p-accent">{entry.kind}</span>
            <span className="min-w-0 flex-1 truncate p-row-text p-text-2" title={entry.summary}>{entry.summary}</span>
            <span className="shrink-0 p-annotation p-text-4">{new Date(entry.at).toLocaleDateString()}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
