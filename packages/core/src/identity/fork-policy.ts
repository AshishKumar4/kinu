/**
 * How a fork takes each family of a workspace's state, declared once (docs/WORKSPACES.md, "Forks"). Every table a
 * workspace holds names its family here, or `unit-fork-policy` fails, so a new table cannot cross, or be left behind,
 * by accident. The row sections that carry a family (fork-sections.ts) and the write's resets (fork-writer.ts) are
 * derived from it. Files cross by their own transport: the home's names as the pin holds them (`forkCarries`), and
 * each payload the carried conversation references.
 */

/**
 * - as-of-cut: the source's value at the fork's cut entry.
 * - current: the source's value when the fork is taken.
 * - fresh: the target makes its own, at its birth or at publication.
 * - not-copied: it never crosses; the target is born without it.
 */
export type ForkPolicy = 'as-of-cut' | 'current' | 'fresh' | 'not-copied';

/** A table a fork write empties before it stages: the target actor's rows, or the whole table. */
export interface ForkReset {
  readonly table: string;
  readonly scope: 'actor' | 'workspace';
}

export interface ForkFamily {
  readonly policy: ForkPolicy;
  /** Every table holding the family's state (an FTS index's shadow tables go with it). */
  readonly tables: readonly string[];
  /**
   * Emptied before a transfer stages, so an abandoned attempt's rows go: a family the write lands, or one hanging off
   * a table it lands. Children first; families reset in declared order, which keeps every foreign key satisfied.
   */
  readonly resets?: readonly ForkReset[];
}

const actor = (table: string): ForkReset => ({ table, scope: 'actor' });

const workspace = (table: string): ForkReset => ({ table, scope: 'workspace' });

const FAMILIES = {
  /** The chat, every entry up to the cut. */
  chat: {
    policy: 'as-of-cut',
    tables: ['conversation_entries', 'conversation_entry_parts'],
    resets: [actor('conversation_entry_parts'), actor('conversation_entries')],
  },
  /** The cut entry's context revision, restored as the first revision of one fresh context. */
  workingContext: {
    policy: 'as-of-cut',
    tables: ['actor_contexts', 'actor_context_selection', 'context_revisions', 'context_memberships'],
    resets: [actor('context_memberships'), actor('actor_context_selection'), actor('context_revisions'), actor('actor_contexts')],
  },
  /** A carried message's streamed parts are its source run's; the sealed message is what crosses. */
  streamedOutput: { policy: 'not-copied', tables: ['stream_parts'], resets: [actor('stream_parts')] },
  /** Every sealed message the carried chat and context reference; its request does not cross. */
  modelMessages: { policy: 'as-of-cut', tables: ['session_messages'], resets: [actor('session_messages')] },
  /** The main actor's settings, without its shell-approval authority (`SHELL_APPROVAL_AUTHORITY_KEYS`). */
  configuration: { policy: 'current', tables: ['actor_config'], resets: [actor('actor_config')] },
  /** The workspace's crafted tools, which the fork evolves on its own; their search index follows them. */
  craftedTools: { policy: 'current', tables: ['crafted_tools', 'crafted_tools_fts'], resets: [workspace('crafted_tools')] },
  /** The main actor's lessons as they stood at the cut: none made after it, and one corroborated after it still
   *  provisional. A lesson cites its turns by id, as values; the chat up to the cut carries those turns. */
  lessons: { policy: 'as-of-cut', tables: ['lessons'], resets: [actor('lessons')] },
  /** Today's value: a tool lesson is revised in place and keeps no earlier revision, so the fork takes the current one. */
  toolLessons: { policy: 'current', tables: ['tool_lessons'], resets: [actor('tool_lessons')] },
  /** Today's value: a memory fact is overwritten in place and keeps no earlier one, so the fork recalls what the source does. */
  facts: { policy: 'current', tables: ['agent_facts'], resets: [actor('agent_facts')] },
  /** Today's value: the `db` tool's tables and the main actor's rows in them, which keep no history. The tables are
   *  named in their catalogue, so the store resets them itself (`appTables` in fork-sections.ts). */
  appData: { policy: 'current', tables: ['agent_data_tables'] },
  /** Rebuilt from the carried notes by the target's first search. */
  memoryIndex: {
    policy: 'fresh',
    tables: ['memory_note_chunks', 'memory_note_chunks_fts', 'memory_note_files'],
    resets: [workspace('memory_note_chunks_fts'), workspace('memory_note_chunks'), workspace('memory_note_files')],
  },
  /** What makes the target a fork, written at publication. */
  lineage: { policy: 'fresh', tables: ['fork_lineage'], resets: [workspace('fork_lineage')] },
  /** The target's own id, name and main actor. */
  identity: { policy: 'fresh', tables: ['workspace_identity', 'workspace_actors'] },
  /** The transfer's own staging on the target. */
  forkTransfer: { policy: 'fresh', tables: ['fork_transfer', 'fork_transfer_counts', 'fork_staged_files'] },
  /** Re-bootstrapped at v0, with the home's `scaffold` directory. */
  scaffold: { policy: 'fresh', tables: ['scaffold_versions'] },
  /** The source's turns, runs and their bookkeeping: a fork starts with none in flight. */
  turns: {
    policy: 'not-copied',
    tables: [
      'run_events', 'open_turns', 'operator_requests', 'agent_open_turns', 'agent_wakes', 'actor_turn_claims', 'actor_requests',
      'request_renders', 'actor_program_state', 'fibers', 'effect_tombstones', 'tool_effect_claims', 'reply_channels',
      'agent_log', 'activity_log', 'executor_output', 'cache_warm', 'compaction_state', 'compaction_archive',
      'context_proposals', 'context_proposal_entries',
    ],
  },
  /** Background jobs, tasks and schedules run for the source. */
  jobs: { policy: 'not-copied', tables: ['background_jobs', 'background_job_serves', 'agent_tasks', 'proposed_tasks', 'triggers'] },
  /** Approvals and consents the source's owner gave or was asked: each is the source's to answer. */
  approvals: {
    policy: 'not-copied',
    tables: ['deferred_approvals', 'deferred_approval_hits', 'instruction_approvals', 'device_consent_requests', 'plan_reviews'],
  },
  /** How the source learned from its own turns: the struggles, ratings and trials behind its lessons, not the lessons. */
  learning: {
    policy: 'not-copied',
    tables: [
      'evolution_events', 'evolution_helpers', 'pattern_extractions', 'turn_struggles',
      'turn_ratings', 'gepa_runs', 'gepa_candidates', 'artifact_versions', 'artifact_trials', 'trial_turns',
      'refinement_requests', 'refinement_lane_holds', 'imported_experience',
    ],
  },
  /** Exploration heads, searches and swarms the source ran. */
  exploration: {
    policy: 'not-copied',
    tables: [
      'head_journal', 'head_runs', 'head_steps', 'head_merge_results', 'exploration_records', 'exploration_seals',
      'search_nodes', 'mcts_search_runs', 'alternate_takes', 'swarm_node_records',
    ],
  },
  /** The source's slates, their versions and who they are shared with, and which of its answers' pages hold a process. */
  slates: {
    policy: 'not-copied',
    tables: [
      'slates', 'slate_versions', 'slate_publications', 'slate_file_manifest', 'slate_state', 'slate_shares',
      'slate_share_users', 'slate_live_shares', 'slate_live_share_users', 'slate_viewer_requests', 'ephemeral_slates',
    ],
  },
  /** The source's GitHub activity. */
  github: { policy: 'not-copied', tables: ['github_repos', 'github_nodes', 'github_items'] },
  /** The source's own token and spend figures. */
  figures: { policy: 'not-copied', tables: ['agent_figures'] },
} as const satisfies Readonly<Record<string, ForkFamily>>;

export type ForkFamilyName = keyof typeof FAMILIES;

export const FORK_FAMILIES: Readonly<Record<ForkFamilyName, ForkFamily>> = FAMILIES;
