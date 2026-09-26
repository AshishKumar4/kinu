import { MEMORY_PATH } from '../memory/note';
import { workspacePath } from '../vfs/workspace-path';

export const LIVE_READS = [
  'getExposedPorts', 'getToolDescriptions', 'listSlates', 'getEvolutionChangelog', 'listPendingActions',
  'getMemoryContent', 'getExecutors', 'listBackgroundJobs', 'getWorkspaceTabPresence', 'getActivePlanReview',
  'listWorkspaceWork',
] as const;

export type LiveRead = typeof LIVE_READS[number];

export const READS_CHANGED_EVENT = 'reads_changed';

export interface ReadsChangedFrame {
  readonly type: typeof READS_CHANGED_EVENT;
  readonly reads: readonly LiveRead[];
}

const LEDGER: readonly LiveRead[] = ['getEvolutionChangelog', 'listPendingActions', 'getWorkspaceTabPresence'];

const QUEUE: readonly LiveRead[] = ['listPendingActions', 'getWorkspaceTabPresence'];

const WORK: readonly LiveRead[] = ['listWorkspaceWork', 'getWorkspaceTabPresence'];

/** Every write to one of these tables moves the reads that select from it. */
const READS_BY_TABLE: ReadonlyMap<string, readonly LiveRead[]> = new Map<string, readonly LiveRead[]>([
  ['agent_facts', LEDGER],
  ['crafted_tools', ['getToolDescriptions', ...LEDGER]],
  ['gepa_runs', LEDGER],
  ['prompt_section_evaluations', LEDGER],
  ['prompt_section_versions', LEDGER],
  ['refinement_requests', LEDGER],
  ['replay_evals', LEDGER],
  ['scaffold_evaluations', LEDGER],
  ['scaffold_versions', LEDGER],
  ['turn_outcomes', LEDGER],
  ['deferred_approvals', QUEUE],
  ['proposed_tasks', QUEUE],
  ['plan_reviews', ['getActivePlanReview', 'getToolDescriptions', ...QUEUE, 'listWorkspaceWork']],
  ['background_jobs', ['listBackgroundJobs', 'getWorkspaceTabPresence']],
  ['agent_tasks', WORK],
  ['agent_task_notes', WORK],
]);

/** Reads that ask only whether a row exists: updates never move them. */
const READS_BY_MEMBERSHIP: ReadonlyMap<string, readonly LiveRead[]> = new Map<string, readonly LiveRead[]>([
  ['head_journal', ['getWorkspaceTabPresence']],
  ['search_nodes', ['getWorkspaceTabPresence']],
]);

const WRITE = /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)/i;

const NONE: readonly LiveRead[] = [];

export function readsWrittenBy(query: string): readonly LiveRead[] {
  const write = WRITE.exec(query);
  const table = write?.[2]?.toLowerCase();

  if (table === undefined) return NONE;

  const membership = write?.[1]?.toUpperCase().startsWith('UPDATE') === false;

  return READS_BY_TABLE.get(table) ?? (membership ? READS_BY_MEMBERSHIP.get(table) : undefined) ?? NONE;
}

const MEMORY_FILE = workspacePath(MEMORY_PATH).slice(1);

const MEMORY_READS: readonly LiveRead[] = ['getMemoryContent', 'getWorkspaceTabPresence'];

/** Paths come with or without the leading slash. */
export function readsMovedByFiles(paths: readonly string[]): readonly LiveRead[] {
  return paths.some((path) => path.replace(/^\//, '') === MEMORY_FILE) ? MEMORY_READS : NONE;
}

/** One frame per `defer` turn, whatever its writes. */
export class LiveReadsNotice {
  private pending: Set<LiveRead> | null = null;

  constructor(private readonly send: (frame: string) => void, private readonly defer: (flush: () => void) => void) {}

  moved(reads: readonly LiveRead[]): void {
    if (reads.length === 0) return;

    if (this.pending === null) {
      this.pending = new Set();
      this.defer(() => { this.flush(); });
    }

    for (const read of reads) this.pending.add(read);
  }

  private flush(): void {
    const reads = [...this.pending ?? []];
    this.pending = null;
    this.send(JSON.stringify({ type: READS_CHANGED_EVENT, reads } satisfies ReadsChangedFrame));
  }
}
