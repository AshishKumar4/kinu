/**
 * What a fork write empties before it stages (docs/WORKSPACES.md, "Forks"). What crosses is the row sections
 * (fork-sections.ts) and the files: the home's names as the pin holds them (`forkCarries`), and each payload the carried
 * conversation references. A table no section lands in does not cross.
 */

/** A table a fork write empties before it stages: the target actor's rows, or the whole table. */
export interface ForkReset {
  readonly table: string;
  readonly scope: 'actor' | 'workspace';
}

const actor = (table: string): ForkReset => ({ table, scope: 'actor' });

const workspace = (table: string): ForkReset => ({ table, scope: 'workspace' });

/**
 * Emptied before a transfer stages, so an abandoned attempt's rows go: every table a section lands in, and the ones
 * hanging off them. Children first, which keeps every foreign key satisfied. The `db` tool's tables are named in their
 * catalogue, so its section empties them itself (`appTables` in fork-sections.ts).
 */
export const FORK_WRITE_RESETS: readonly ForkReset[] = [
  // The chat, every entry up to the cut.
  actor('conversation_entry_parts'), actor('conversation_entries'),
  // The cut entry's context revision, restored as the first revision of one fresh context.
  actor('context_memberships'), actor('actor_context_selection'), actor('context_revisions'), actor('actor_contexts'),
  // A carried message's streamed parts are its source run's; the sealed message is what crosses.
  actor('stream_parts'),
  // Every sealed message the carried chat and context reference.
  actor('session_messages'),
  // The main actor's settings, without its shell-approval authority (`SHELL_APPROVAL_AUTHORITY_KEYS`).
  actor('actor_config'),
  // The workspace's crafted tools, which the fork evolves on its own.
  workspace('crafted_tools'),
  // The main actor's lessons as of the cut, and its tool lessons and facts as they stand.
  actor('lessons'), actor('tool_lessons'), actor('agent_facts'),
  // The closed questions the carried calls read their results from.
  actor('owner_questions'),
  // Rebuilt from the carried notes by the target's first search.
  workspace('memory_note_chunks_fts'), workspace('memory_note_chunks'), workspace('memory_note_files'),
  // What makes the target a fork, written at publication.
  workspace('fork_lineage'),
];
