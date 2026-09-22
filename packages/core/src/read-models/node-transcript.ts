/**
 * One branch's transcript across both stores: `head` (tool loop, journalled per step) or `rollout`
 * (one toolless MCTS proposal; `search_nodes.observation` is its whole output, no step trace).
 * Null means neither store knows the node.
 */

import type { SqlExecutor } from '../types/primitives';
import type { Usage } from '../usage';
import type { HeadStep } from '../heads/types';
import { HeadJournal } from '../heads/journal';
import { readSearchTree } from './search-tree';
import { runName } from './fork-runs';
import type { Page, PageRequest } from '../session/page';
import type { ActorHandle } from '../identity/actor-handle';

export type NodeTranscriptOrigin = 'head' | 'rollout';

/** One step of the search path, root first. */
export interface NodeTranscriptCrumb {
  readonly id: string;
  /** Unpolished; the tree's `cleanNodeLabel` decides display trimming. */
  readonly label: string;
  readonly depth: number;
  readonly status: string;
}

export interface NodeTranscriptView {
  readonly origin: NodeTranscriptOrigin;
  readonly runId: string;
  readonly nodeId: string;
  readonly task: string;
  /** A head's split rationale; empty for a rollout. */
  readonly rationale: string;
  /** Store-specific vocabulary, hence `origin` beside it. */
  readonly status: string;
  readonly spawnedAt: number;
  /** Null when the trace never grew; with `spawnedAt` separates working from wedged. */
  readonly lastStepAt: number | null;
  /** Measured only once the branch reported; 0 while it runs. */
  readonly wallClockMs: number;
  /** Absent fields mean the provider never reported that count — never zero. */
  readonly usage: Usage;
  /** One cursored page, newest page first, each page oldest-first. Always empty for a rollout. */
  readonly steps: Page<HeadStep>;
  readonly stepCount: number;
  /** Tool calls across the whole trace, not just the page. */
  readonly toolCount: number;
  /** A head's report summary or a rollout's proposal; null while working. */
  readonly answer: string | null;
  readonly decisions: ReadonlyArray<{ question: string; choice: string; rationale: string }>;
  readonly errorMessage: string | null;
  /** Root to this node, inclusive. */
  readonly path: readonly NodeTranscriptCrumb[];
  readonly codeUsed: string | null;
}

/** A node id alone is ambiguous: a workspace accumulates every tree it grew. */
export interface NodeTranscriptRef {
  readonly runId: string;
  readonly nodeId: string;
}

/** One node's transcript, scoped by `runId` on both paths. */
export function readNodeTranscript(
  sql: SqlExecutor,
  actor: ActorHandle,
  node: NodeTranscriptRef,
  request: PageRequest = {},
): NodeTranscriptView | null {
  return readHeadTranscript(sql, actor, node, request) ?? readRolloutTranscript(sql, actor, node);
}

interface Branchy {
  readonly id: string;
  readonly parent_id: string | null;
  readonly depth: number;
  readonly status: string;
}

/**
 * Root to `node` over rows already in hand. `seen` guards against parent chains that close on
 * themselves in resumed searches; a chain leaving the rows stops there.
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
  actor: ActorHandle,
  node: NodeTranscriptRef,
  request: PageRequest,
): NodeTranscriptView | null {
  const { runId, nodeId } = node;
  const journal = new HeadJournal(sql, actor);
  // Steps are read per head so opening one branch never pays for its siblings' traces.
  const rows = journal.readTree(runId);
  const row = rows.find((candidate) => candidate.id === nodeId);

  if (!row) return null;
  const head = journal.readHeadView(nodeId);

  if (!head) return null;

  const path = ancestorCrumbs(row, rows, (ancestor) => ancestor.task);
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
  actor: ActorHandle,
  ref: NodeTranscriptRef,
): NodeTranscriptView | null {
  const { runId, nodeId } = ref;
  const nodes = readSearchTree(sql, actor, runId);
  const node = nodes.find((candidate) => candidate.id === nodeId);

  if (!node) return null;

  // The root crumb uses the run name: MCTS records the root with `action: ''`.
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
    lastStepAt: null,
    wallClockMs: 0,
    // Rollout usage goes to the mission ledger with no per-node column; absent, not zero.
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
