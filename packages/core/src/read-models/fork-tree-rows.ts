/**
 * A run's stored halves folded into the one `ForkNode` tree every fork view renders.
 * `search_nodes` and `head_journal` fold together; a swarm writes both.
 */
import { headStatusUnsettled, storedHeadReportStatus, type HeadRunView } from '../heads/types';
import type { ForkNode, ForkNodeLifecycle } from '../protocol';

/** One `search_node_scores` row, as every transport serves it. */
export interface MctsRow {
  id: string; parent_id: string | null; depth: number;
  visits: number; value: number; own_score: number | null; status: ForkNode["status"]; action: string;
  /** Which search this row belongs to. */
  root_id?: string | null;
  task?: string; observation?: string; code_used?: string | null;
  branch_agent_key?: string | null; msg_id?: string | null; created_at?: number;
}

/** Tree for a payload linking into no root. No `action`: the band then labels the root from the run name. */
const NO_TREE: ForkNode = {
  id: "root", parentId: null, depth: 0, visits: 0, value: 0,
  status: "open", action: "", children: [],
};

/** Link vertices into one tree; if several roots arrive, the newest wins. */
function linkVertices(vertices: readonly ForkNode[]): ForkNode | null {
  const byId = new Map(vertices.map((vertex) => [vertex.id, vertex]));
  let root: ForkNode | null = null;

  for (const vertex of vertices) {
    const parent = vertex.parentId === null ? undefined : byId.get(vertex.parentId);

    if (parent) {
      parent.children.push(vertex);
    } else if (
      !root
      || vertex.depth < root.depth // a true root beats a stray orphan
      || (vertex.depth === root.depth && (vertex.createdAt ?? 0) > (root.createdAt ?? 0))
    ) {
      root = vertex;
    }
  }

  return root;
}

/**
 * Fold search rows into the tree, each vertex scored by its row's own score. `visits === 0 &&
 * value === 0` is the insert initialiser, not a score, so it maps to null.
 */
export function buildTree(nodes: MctsRow[]): ForkNode {
  const vertices = nodes.map((n): ForkNode => {
    const unevaluated = n.visits === 0 && n.value === 0;

    return {
      id: n.id, parentId: n.parent_id, depth: n.depth,
      visits: unevaluated ? null : n.visits,
      value: unevaluated ? null : n.own_score,
      status: n.status, action: n.action,
      task: n.task, observation: n.observation, codeUsed: n.code_used, createdAt: n.created_at,
      children: [],
    };
  });

  return linkVertices(vertices) ?? NO_TREE;
}

/**
 * A journalled node's status in drawing vocabulary. Never `terminal` (the journal never records a
 * winner). Lossy, so it is never printed; {@link journalLifecycle} carries the exact word.
 */
function journalStatus(status: string): ForkNode["status"] {
  if (status === "running") return "running";

  return status === "completed" ? "open" : "failed";
}

/** The journal's own status word, or absent when the value is not one any journal version writes. */
function journalLifecycle(status: string): ForkNodeLifecycle | undefined {
  if (headStatusUnsettled(status)) return status;

  return storedHeadReportStatus(status) ?? undefined;
}

/** One journalled node as a vertex. `value`/`visits` are null: the journal records no score. */
function journalVertex(head: HeadRunView["heads"][number], parent: ForkNode): ForkNode {
  const lifecycle = journalLifecycle(head.status);

  const vertex: ForkNode = {
    id: head.id,
    parentId: parent.id,
    // The journal's depth holds even when the vertex attaches beneath the visible root.
    depth: head.depth,
    value: null,
    visits: null,
    status: journalStatus(head.status),
    action: head.task,
    task: head.task,
    observation: head.summary ?? head.errorMessage ?? "",
    createdAt: head.spawnedAt,
    children: [],
  };

  // Absent (not undefined-valued) distinguishes an unknown word from no journal row at all.
  if (lifecycle !== undefined) vertex.lifecycle = lifecycle;

  return vertex;
}

/**
 * A run's two halves as one tree, or null when neither was written. `search_nodes` is
 * authoritative for nodes it holds; `head_journal` supplies nodes not yet reported, joined by id.
 */
export function explorationForkTree(entry: {
  readonly tree: readonly MctsRow[];
  readonly head: HeadRunView | null;
}): ForkNode | null {
  const settled = entry.tree.length > 0 ? buildTree([...entry.tree]) : null;

  if (entry.head === null) return settled;

  // The run header's row is the tree's root, not one of its nodes.
  const root = settled ?? {
    id: entry.head.rootId,
    parentId: null,
    depth: 0,
    value: null,
    visits: null,
    status: journalStatus(entry.head.status),
    action: entry.head.task || entry.head.rationale || "(run)",
    task: entry.head.task,
    observation: entry.head.merge?.narrative ?? entry.head.rationale,
    createdAt: entry.head.spawnedAt,
    children: [],
  } satisfies ForkNode;

  const held = new Set(entry.tree.map((row) => row.id));
  const byId = new Map<string, ForkNode>();

  for (const vertex of [root, ...descendants(root)]) byId.set(vertex.id, vertex);

  // Journal order is `(depth, spawned_at)`, so a provisional parent is placed before its child.
  for (const head of entry.head.heads) {
    if (held.has(head.id)) continue;
    // A parent in neither half attaches to the run's root rather than vanishing.
    const parent = (head.parentId === null ? undefined : byId.get(head.parentId)) ?? root;
    const vertex = journalVertex(head, parent);
    parent.children.push(vertex);
    byId.set(vertex.id, vertex);
  }

  return root;
}

/** Every vertex below `node`; a journalled child's parent may be at any depth. */
function descendants(node: ForkNode): ForkNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}
