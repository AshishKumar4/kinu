import { MEMORY_PATH } from '../memory/note';
import { workspacePath, WORKSPACE_ROOT } from '../vfs/workspace-path';

export const LIVE_READS = [
  'getExposedPorts', 'getToolDescriptions', 'listSlates', 'getEvolutionChangelog', 'listPendingActions',
  'getMemoryContent', 'getExecutors', 'listBackgroundJobs', 'getWorkspaceTabPresence', 'getActivePlanReview',
  'listWorkspaceWork', 'listWorkspaceAgents', 'listSubordinates', 'getQuality', 'getWorkspaceGitHub',
] as const;

export type LiveRead = typeof LIVE_READS[number];

export const READS_CHANGED_EVENT = 'reads_changed';

export const PAGE_KEEPALIVE = { ping: '{"type":"ping"}', pong: '{"type":"pong"}' } as const;

export interface ReadsChangedFrame {
  readonly type: typeof READS_CHANGED_EVENT;
  readonly reads: readonly LiveRead[];
}

const LEDGER: readonly LiveRead[] = ['getEvolutionChangelog', 'listPendingActions', 'getWorkspaceTabPresence'];

const QUEUE: readonly LiveRead[] = ['listPendingActions', 'getWorkspaceTabPresence'];

const WORK: readonly LiveRead[] = ['listWorkspaceWork', 'getWorkspaceTabPresence'];

const AGENTS: readonly LiveRead[] = ['listWorkspaceAgents'];

export const ROSTER_READS: readonly LiveRead[] = [...AGENTS, 'listSubordinates'];

/** Every write to one of these tables moves the reads that select from it. */
const READS_BY_TABLE: ReadonlyMap<string, readonly LiveRead[]> = new Map<string, readonly LiveRead[]>([
  ['agent_facts', LEDGER],
  ['github_items', ['getWorkspaceGitHub']],
  ['github_repos', ['getWorkspaceGitHub']],
  ['crafted_tools', ['getToolDescriptions', ...LEDGER]],
  ['gepa_runs', LEDGER],
  ['artifact_versions', LEDGER],
  ['artifact_trials', LEDGER],
  ['refinement_requests', LEDGER],
  ['scaffold_versions', LEDGER],
  ['turn_ratings', [...LEDGER, 'getQuality']],
  // A review's `turn_complete` is the quality read's count of turns.
  ['evolution_events', ['getQuality']],
  ['deferred_approvals', [...QUEUE, ...AGENTS]],
  ['device_consent_requests', AGENTS],
  ['proposed_tasks', QUEUE],
  ['plan_reviews', ['getActivePlanReview', 'getToolDescriptions', ...QUEUE, 'listWorkspaceWork', ...AGENTS]],
  ['background_jobs', ['listBackgroundJobs', 'getWorkspaceTabPresence']],
  ['background_job_serves', ['listBackgroundJobs', 'getWorkspaceTabPresence']],
  ['agent_tasks', WORK],
  ['actor_subordinates', ROSTER_READS],
  ['actor_config', ROSTER_READS],
  ['actor_turn_claims', AGENTS],
  ['agent_log', AGENTS],
  ['head_journal', AGENTS],
  ['head_runs', AGENTS],
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
  const byRow = READS_BY_TABLE.get(table) ?? NONE;
  const byMembership = (membership ? READS_BY_MEMBERSHIP.get(table) : undefined) ?? NONE;

  return byMembership === NONE ? byRow : [...byRow, ...byMembership];
}

const MEMORY_FILE = workspacePath(MEMORY_PATH, WORKSPACE_ROOT).slice(1);

const MEMORY_READS: readonly LiveRead[] = ['getMemoryContent', 'getWorkspaceTabPresence'];

export function readsMovedByFiles(paths: readonly string[]): readonly LiveRead[] {
  return paths.some((path) => path.replace(/^\//, '') === MEMORY_FILE) ? MEMORY_READS : NONE;
}

/** One frame per `defer` turn, whatever its writes. */
export class LiveReadsNotice {
  private pending: Set<LiveRead> | null = null;

  constructor(private readonly send: (frame: ReadsChangedFrame) => void, private readonly defer: (flush: () => void) => void) {}

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
    this.send({ type: READS_CHANGED_EVENT, reads });
  }
}
