/**
 * The Supervise altitude's Evolution content: the self-changes the workspace's
 * changelog records, and the decision whether they exist.
 *
 * The gate is the changelog's own classification. A scaffold edit, a kept
 * lesson, a promoted proposal lands as a `scaffold | tool | fact | gepa |
 * prompt_section | refinement` entry — an actual self-change. `outcomes` and
 * `replay` entries are measurements a closed window leaves behind, so a digest
 * of only those renders NOTHING: no heading, no card, no empty state.
 */
import { Badge } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import * as v from "valibot";

export const EvolutionEntrySchema = v.object({
  id: v.string(), kind: v.string(), at: v.number(),
  summary: v.string(), evidence: v.optional(v.nullable(v.string())),
});

export type EvolutionEntry = v.InferOutput<typeof EvolutionEntrySchema>;

const CHANGE_KINDS = {
  scaffold: true, tool: true, fact: true, gepa: true, prompt_section: true, refinement: true,
} satisfies Record<string, true>;

/** The entries that ARE evolution: change-bearing kinds only, so a window that
 *  closed quietly — the digest's `outcomes`/`replay` measurement rows — never
 *  keeps the section alive. The page calls it on the loaded digest before the
 *  section is mounted at all. */
export function evolutionChanges(entries: readonly EvolutionEntry[]): EvolutionEntry[] {
  return entries.filter((entry) => entry.kind in CHANGE_KINDS);
}

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
