/**
 * One branch's whole behaviour — what the reader sees when they open a node.
 *
 * The fork list (read-models/fork-runs.ts) deliberately stops at the summary and
 * leaves detail per-mechanism. That is right for a run, and wrong for a node: a
 * reader who clicked a branch wants the same thing either way — the task it was
 * given, every LLM step it took, and the answer it reached. So this is the one
 * projection that crosses the two stores, and it says WHICH one answered rather
 * than pretending they record the same amount:
 *
 *   `head`    — a branching head. Runs the full inference loop with tools, and
 *               journals every finished step as it lands (HeadJournal.appendStep),
 *               so its trace is readable mid-flight.
 *   `rollout`  — an MCTS branch. One toolless proposal call, scored against its
 *               siblings; `search_nodes.observation` IS its entire output. It has
 *               no step trace and never will — see SubordinateAgent.stepSink,
 *               which returns null for exactly this case.
 *
 * Reads only through what already owns each store: {@link HeadJournal} for the
 * head tables, {@link readSearchTree} for the search tree. No SQL of its own, so
 * a column this file misreads is a column those readers already misread.
 *
 * Returns null for a node neither store knows. That is a distinct answer from a
 * head that died (`errorMessage` set), from one that has recorded nothing yet
 * (`steps` empty, `spawnedAt`/`lastStepAt` saying whether it is working), and
 * from a read that failed — which never reaches here at all. Collapsing those
 * four into one empty panel is what made a live branch look like lost data.
 */

import type { SqlExecutor } from '../types/primitives';
import type { Usage } from '../usage';
import type { HeadStep } from '../heads/types';
import { HeadJournal } from '../heads/journal';
import { readSearchTree } from './search-tree';
import { runName } from './fork-runs';
import type { Page, PageRequest } from './page';

/** Which store recorded this node, and therefore how much there is to show. */
export type NodeTranscriptOrigin = 'head' | 'rollout';

/** One step of the search path, root first — so a reader who followed a deep
 *  branch can still say where they are and walk back out. */
export interface NodeTranscriptCrumb {
  readonly id: string;
  /** The branch's own headline, as the store recorded it. Unpolished on purpose:
   *  the tree's `cleanNodeLabel` is the one place that decides how a
   *  model-authored line is trimmed for display. */
  readonly label: string;
  readonly depth: number;
  readonly status: string;
}

export interface NodeTranscriptView {
  readonly origin: NodeTranscriptOrigin;
  readonly runId: string;
  readonly nodeId: string;
  /** What this branch was asked to do. */
  readonly task: string;
  /** Why the parent opened it. A head's split rationale; empty for a rollout,
   *  which is one of N deliberately-diverging proposals and has no per-branch
   *  reason of its own. */
  readonly rationale: string;
  /** Lifecycle as its own store records it: a head's journal status, or the
   *  search node's status. Not the same vocabulary, which is why `origin` is
   *  carried beside it. */
  readonly status: string;
  readonly spawnedAt: number;
  /** When the trace last grew, or null when it never has. With `spawnedAt` this
   *  is what separates a branch that is working from one that is wedged. */
  readonly lastStepAt: number | null;
  /** Measured only once the branch reported; 0 while it runs. */
  readonly wallClockMs: number;
  /** Absent fields mean the provider never reported that count — never zero. */
  readonly usage: Usage;
  /** The ordered LLM trace, one cursored page of it — newest page first, each
   *  page oldest-first. Always empty for a rollout. The whole trace stays
   *  reachable through `steps.next`; `stepCount` is the honest total. */
  readonly steps: Page<HeadStep>;
  /** How much trace this branch recorded, whatever the page holds. */
  readonly stepCount: number;
  /** Tool calls across the WHOLE trace, not just the page — the Tools metric
   *  would under-count by exactly what paging left out otherwise. */
  readonly toolCount: number;
  /** The branch's final answer — a head's report summary, or a rollout's whole
   *  proposal. Null while it is still working. */
  readonly answer: string | null;
  readonly decisions: ReadonlyArray<{ question: string; choice: string; rationale: string }>;
  /** Why it stopped, when it stopped badly. */
  readonly errorMessage: string | null;
  /** Root → this node, inclusive. */
  readonly path: readonly NodeTranscriptCrumb[];
  /** The runnable draft a rollout offered, when it offered one. */
  readonly codeUsed: string | null;
}

/**
 * One node's transcript, from whichever store holds it.
 *
 * Scoped by `runId` on both paths: a workspace accumulates every tree it ever
 * grew, and an unscoped lookup by node id alone is the class of bug
 * `search_nodes.root_id` scoping exists to prevent.
 */
export function readNodeTranscript(
  sql: SqlExecutor,
  runId: string,
  nodeId: string,
  request: PageRequest = {},
): NodeTranscriptView | null {
  return readHeadTranscript(sql, runId, nodeId, request) ?? readRolloutTranscript(sql, runId, nodeId);
}

/** A row either store can be walked by: both key their parent the same way. */
interface Branchy {
  readonly id: string;
  readonly parent_id: string | null;
  readonly depth: number;
  readonly status: string;
}

/**
 * Root → `node`, walked over rows already in hand rather than re-queried per
 * level: both stores hand this function the whole run, and a per-ancestor read
 * would turn opening a depth-6 branch into six round trips.
 *
 * The `seen` guard is not defensive. A parent id is written by the engine that
 * inserted the child, and a resumed or rewritten search has produced rows whose
 * chain closes on itself; unguarded, that walk does not terminate. A chain that
 * leaves the run (a parent no longer in these rows, e.g. pruned) stops where the
 * evidence stops rather than inventing the rest.
 */
function ancestorCrumbs<Row extends Branchy>(
  node: Row,
  rows: readonly Row[],
  label: (row: Row) => string,
): NodeTranscriptCrumb[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: NodeTranscriptCrumb[] = [];
  const seen = new Set<string>();
  for (let cursor: Row | undefined = node; cursor && !seen.has(cursor.id);) {
    seen.add(cursor.id);
    path.unshift({ id: cursor.id, label: label(cursor), depth: cursor.depth, status: cursor.status });
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return path;
}

function readHeadTranscript(
  sql: SqlExecutor,
  runId: string,
  nodeId: string,
  request: PageRequest,
): NodeTranscriptView | null {
  const journal = new HeadJournal(sql);
  // The run's head rows carry the parent chain; the trace is its own read. Three
  // reads rather than one because only one of them is per-head, and a reader who
  // opened one branch must not pay for its siblings' steps — which is also why
  // `HeadRunHeadView` no longer carries any.
  const rows = journal.readTree(runId);
  const row = rows.find((candidate) => candidate.id === nodeId);
  if (!row) return null;
  const head = journal.readHeadView(nodeId);
  if (!head) return null;

  const path = ancestorCrumbs(row, rows, (head) => head.task);
  const counted = journal.countSteps(nodeId);

  return {
    origin: 'head',
    runId,
    nodeId,
    task: head.task,
    rationale: head.rationale,
    status: head.status,
    spawnedAt: head.spawnedAt,
    lastStepAt: head.lastStepAt,
    wallClockMs: head.wallClockMs,
    usage: head.usage,
    steps: journal.readStepsPage(nodeId, request),
    stepCount: counted.steps,
    toolCount: counted.toolCalls,
    answer: head.summary,
    decisions: head.decisions,
    errorMessage: head.errorMessage,
    path,
    codeUsed: null,
  };
}

function readRolloutTranscript(
  sql: SqlExecutor,
  runId: string,
  nodeId: string,
): NodeTranscriptView | null {
  const nodes = readSearchTree(sql, runId);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;

  // The first crumb is the RUN, so it wears the run's name. Its raw `action` is
  // empty for every MCTS search (`mcts/engine.ts` records the root with
  // `action: ''`), and a breadcrumb reading the column verbatim is what printed
  // the literal `root` where the search's own name belongs.
  const path = ancestorCrumbs(
    node, nodes,
    (row) => (row.parent_id === null ? runName(row.action, row.task) : row.action),
  );

  return {
    origin: 'rollout',
    runId,
    nodeId,
    task: node.task,
    rationale: '',
    status: node.status,
    spawnedAt: node.created_at,
    // A rollout has no trace to time, so nothing may claim one grew. Its own
    // arrival is the only timestamp it has.
    lastStepAt: null,
    wallClockMs: 0,
    // The engine charges a rollout's usage to the mission ledger as it lands and
    // keeps no per-node column, so this branch cannot report tokens. Absent, not
    // zero: the rollout was not free.
    usage: {},
    steps: { status: 'end', items: [] },
    stepCount: 0,
    toolCount: 0,
    answer: node.observation.trim() ? node.observation : null,
    decisions: [],
    errorMessage: null,
    path,
    codeUsed: node.code_used,
  };
}
