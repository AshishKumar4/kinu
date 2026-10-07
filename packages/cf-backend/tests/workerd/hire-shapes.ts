/**
 * Shared hire-tier values, kept out of `hire-probe.ts` because workerd's module map rejects non-handler named exports
 * from a worker module ("Incorrect type for map entry").
 */

export const CHILD_ANSWER = 'CHILD-ANSWER-42';

export const HIRE_MISSION = 'HIRE-BRIEF-ONE-LINE';

export const NEST_MISSION = 'HIRE-NEST-BRIEF';

export const NEST_RELAY = 'RELAYED';

/** The deepest helper's answer under `chain`: its own hire is refused at the depth cap. */
export const CHAIN_BOTTOM = 'CHAIN-BOTTOM-7';

/** How a hired agent's report reads in the drain turn it opens on its hirer. */
export const REPORT_MARK = '[subordinate_report]';

export const HIRE_ROOT_MODEL = 'hire-root';

export const HIRE_DURABLE_MODEL = 'hire-root-durable';

/** The catalog's default tier: not what the child runs on (the workspace pin), but every tier slot must be offered by `/v1/models`. */
export const HIRE_CHILD_MODEL = 'hire-child';

/** `job`: a durable hire whose brief starts a shell command that outlives its call's window. */
export type ChildScript = 'answer' | 'throw' | 'park' | 'nest' | 'nest-park' | 'nest-progress' | 'chain' | 'job';

export const JOB_MISSION = 'HIRE-JOB-BRIEF';

/** What the job's command prints as it ends. */
export const JOB_OUTPUT = 'JOB-OUTPUT-77';

/** The job's command ends once this file exists: in the workspace's home, which every agent's shell shares. */
export const JOB_GATE = '/home/main/hire-job-gate';

/** The command the hire's brief runs: a dev server's shape, held until the gate opens. */
export const JOB_COMMAND = `while [ ! -e ${JOB_GATE} ]; do sleep 0.1; done; echo ${JOB_OUTPUT}`;

/** The hire's answer once told its command became a job. */
export const JOB_STARTED = 'JOB-STARTED';

/** The hire's answer to a wake about its job. */
export const JOB_NOTED = 'JOB-NOTED';

export interface JobRow {
  readonly actorId: string;
  readonly id: string;
  readonly status: string;
}

export interface JobWatchState {
  readonly incarnation: string;
  readonly terminalRetry: boolean;
  readonly agentWakes: number;
  readonly fibers: number;
  readonly wakes: number;
  readonly started: boolean;
  readonly jobs: readonly JobRow[];
}

export interface LogRow {
  readonly actorId: string;
  readonly id: string;
  readonly variant: string;
  readonly turnId: string | null;
  readonly consumedAt: number | null;
  readonly kind: string;
  readonly bodyLength: number;
  /** Tells a re-admission loop apart from distinct tasks. */
  readonly body: string;
}

export interface RosterRow {
  readonly actorId: string;
  readonly name: string;
  readonly lifetime: string;
  readonly status: string;
  readonly taskEventId: string | null;
}

export interface ActorRow {
  readonly actorId: string;
  readonly name: string;
  /** Hired by another agent: every row but the workspace's main agent. */
  readonly hired: boolean;
  readonly retiringAt: number | null;
  readonly deletedAt: number | null;
}

export interface TurnCount {
  readonly actorId: string;
  readonly runs: number;
}

/** Everything read out of the product's storage. */
export interface HireObservation {
  readonly rootActorId: string;
  readonly roster: readonly RosterRow[];
  readonly log: readonly LogRow[];
  /** Retired included, so a zero count is distinguishable from a subject retired before the read. */
  readonly actors: readonly ActorRow[];
  readonly turns: readonly TurnCount[];
  readonly toolResults: readonly string[];
  /** Every report message a hirer's turn opened on (`[subordinate_report]` drain text). */
  readonly reports: readonly string[];
  /** The reports the root's own turns opened on: the root alone carries no `report` tool. */
  readonly rootReports: readonly string[];
  readonly transcript: readonly string[];
}

/** The model endpoint a workspace's owner credential names; the path carries the workspace to its run. */
export function hireModelsBaseUrl(workspace: string): string {
  return `http://hire-models.invalid/w/${encodeURIComponent(workspace)}/v1`;
}

/** A workspace's control endpoint: its reset, gates and log. */
export function hireControlUrl(workspace: string, op: string): string {
  return `http://hire-control.invalid/hire/${encodeURIComponent(workspace)}/${op}`;
}

export interface ArchiveSections {
  readonly listed: readonly string[];
  readonly sections: Readonly<Record<string, number>>;
}
