/**
 * A run's stored halves → the ONE tree the fork views render.
 *
 * The one fold from the wire shape every transport delivers (the initial
 * snapshot, the `mcts-progress` broadcast, `getSearchTree`, the exploration
 * canvas) into `ForkNode`. It lives here rather than in the socket hook because
 * several surfaces need it and only one of them owns a socket.
 *
 * BOTH halves fold here, and they fold TOGETHER. A run scoped by one root id
 * writes up to two stores — `search_nodes` for the tree, `head_journal` for each
 * tool-using node's transcript — and an agent-unit swarm writes both. Choosing
 * between them is what drew a running swarm as a lone root: the tree half holds
 * the root row from dispatch, so it is never empty, and the journal half holding
 * every node currently executing was therefore never read.
 */
import { headStatusUnsettled, storedHeadReportStatus, type HeadRunView } from "@kinu.run/core";
import type { ForkNode, ForkNodeLifecycle } from "./protocol";

/** One `search_nodes` row, as every transport serves it. */
export interface MctsRow {
  id: string; parent_id: string | null; depth: number;
  visits: number; value: number; status: ForkNode["status"]; action: string;
  /** Which search this row belongs to. Present on every scoped projection, and
   *  carried through so a fold can assert a row belongs to the tree it is being
   *  drawn in. */
  root_id?: string | null;
  task?: string; observation?: string; code_used?: string | null;
  branch_agent_key?: string | null; msg_id?: string | null; created_at?: number;
}

/** The empty tree, for a payload whose vertices link into no root at all — every
 *  caller guards the empty case, so this is the malformed one. No `action`: the
 *  band labels its root from the RUN's name when the node carries none, and the
 *  word `root` in this slot is what a reader saw instead of the search's name. */
const NO_TREE: ForkNode = {
  id: "root", parentId: null, depth: 0, visits: 0, value: 0,
  status: "open", action: "", children: [],
};

/**
 * Link loose search vertices into one tree and elect its root.
 *
 * The server scopes rows to one search; if a payload still carries several
 * searches' roots (an old server, a mid-deploy broadcast), the NEWEST root wins
 * — rooting at the oldest is how the first search a workspace ever ran shadowed
 * every one after it.
 */
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
 * Fold search rows into the tree.
 *
 * A row that nothing has been backpropagated through carries NO score. Its
 * `visits` and `value` are both 0 because `SearchNode.value` is a `number`
 * initialised to 0 at insert, and the engine writes a search's root row at
 * dispatch — so the root of a search that has evaluated nothing holds a real,
 * stored 0 and was drawn `0%`. That is the caption in the incident's screenshot,
 * and it is the same lie as the missing nodes: 0 is the initialiser, not a
 * measurement.
 *
 * `visits === 0` is the store's own way of saying so, so the test is that and not
 * a rule about zeroes: three rollouts that all returned 0 IS a measurement and
 * survives, and an unvisited row that somehow carries a value keeps it, because
 * then the number is the only evidence there is.
 */
export function buildTree(nodes: MctsRow[]): ForkNode {
  const vertices = nodes.map((n): ForkNode => {
    const unevaluated = n.visits === 0 && n.value === 0;
    return {
      id: n.id, parentId: n.parent_id, depth: n.depth,
      visits: unevaluated ? null : n.visits,
      value: unevaluated ? null : n.value,
      status: n.status, action: n.action,
      task: n.task, observation: n.observation, codeUsed: n.code_used,
      branchAgentKey: n.branch_agent_key, msgId: n.msg_id, createdAt: n.created_at,
      children: [],
    };
  });
  return linkVertices(vertices) ?? NO_TREE;
}

/**
 * A journalled node's lifecycle in the tree's own vocabulary.
 *
 * Never `terminal`: that state means "the branch the run settled on", and the
 * journal records that a node ran, never that it won. Claiming a winner here
 * would be the one thing this fold must not do.
 *
 * LOSSY BY NECESSITY, which is why {@link journalLifecycle} rides beside it: the
 * drawing vocabulary has one word for every ending that is not `completed`, so
 * this collapses `budget_exceeded`, `aborted`, `errored` and `interrupted` into
 * `failed` and `completed` into `open`. That is right for a hollow dot and wrong
 * for a sentence, and the graph used to print this word at the reader.
 */
function journalStatus(status: string): ForkNode["status"] {
  if (status === "running") return "running";
  return status === "completed" ? "open" : "failed";
}

/**
 * The same status as the JOURNAL's own word, or absent when the column holds one
 * no version of this journal writes.
 *
 * Read through core's two unions rather than re-listed here, so the words a
 * reader is shown are the words `head_journal.status` can hold and a status
 * added there cannot quietly become "failed" on this surface. Absent is honest:
 * an unrecognised column value is not a lifecycle this client can name, and
 * naming it anyway is how an invented word gets on screen.
 */
function journalLifecycle(status: string): ForkNodeLifecycle | undefined {
  if (headStatusUnsettled(status)) return status;
  return storedHeadReportStatus(status) ?? undefined;
}

/**
 * One journalled node as a vertex.
 *
 * `value` and `visits` are null, deliberately: the journal records what a node
 * DID, never what it scored, so the renderer must drop every encoding that
 * would otherwise be drawn from a zero no node earned. A running node rendered
 * at 0% is the exact lie the incident's lone root told.
 */
function journalVertex(head: HeadRunView["heads"][number], parent: ForkNode): ForkNode {
  const lifecycle = journalLifecycle(head.status);
  const vertex: ForkNode = {
    id: head.id,
    parentId: parent.id,
    // The journal's depth is authoritative even when its parent is not in this
    // snapshot and the vertex has to attach beneath the visible root.
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
  // Assigned rather than declared: an unrecognised status must leave the key
  // ABSENT, because a reader distinguishes "this store recorded no word I know"
  // from "this node has no journal row at all".
  if (lifecycle !== undefined) vertex.lifecycle = lifecycle;
  return vertex;
}

/**
 * A run's two halves as ONE tree, or null for a run that wrote neither.
 *
 * THE SETTLED HALF DECIDES, THE JOURNAL FILLS IN THE REST. `search_nodes` is
 * what the engine selected on and is therefore authoritative for every node it
 * holds; `head_journal` is the only record of a node that is still working,
 * because the engine writes a node's tree row when that node REPORTS. The two
 * are joined on the node id they share — `swarm-run.ts` journals a spawn and
 * later inserts its search row under the same id — so a node that has reported
 * appears once, settled, and a node still running appears once, provisional.
 *
 * This is the fold that used to choose. It read the tree half whenever that half
 * was non-empty, and a swarm's tree half holds its root row from the moment it
 * is dispatched, so every running node of every real swarm was discarded here:
 * a lone root at 0% with "0 branches" for runs the agent was actively driving.
 * There is no state in which one half is the whole run, so there is no longer a
 * choice to get wrong.
 */
export function explorationForkTree(entry: {
  readonly tree: readonly MctsRow[];
  readonly head: HeadRunView | null;
}): ForkNode | null {
  const settled = entry.tree.length > 0 ? buildTree([...entry.tree]) : null;
  if (entry.head === null) return settled;
  // The run header's own row is the tree's root, not one of its nodes: a swarm
  // journals a header keyed on the root id, and a recursive sub-split journals
  // the parent head that IS the run.
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
  // Parent before child: the journal reads in `(depth, spawned_at)` order, so a
  // provisional node's provisional parent is already placed when it arrives.
  for (const head of entry.head.heads) {
    if (held.has(head.id)) continue;
    // A parent in neither half attaches to the run's root rather than vanishing.
    // Dropping it would be this same defect at one node's scale.
    const parent = (head.parentId === null ? undefined : byId.get(head.parentId)) ?? root;
    const vertex = journalVertex(head, parent);
    parent.children.push(vertex);
    byId.set(vertex.id, vertex);
  }
  return root;
}

/** Every vertex below `node`. The overlay indexes the WHOLE settled tree, not
 *  just its root, because a journalled child's parent may be at any depth. */
function descendants(node: ForkNode): ForkNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}
