/**
 * search_nodes rows → the tree(s) the fork view renders.
 *
 * The one fold from the wire shape every transport delivers (the initial
 * snapshot, the `mcts-progress` broadcast, `getSearchTree`, the exploration
 * canvas) into `ForkNode`. It lives here rather than in the socket hook because
 * several surfaces need it and only one of them owns a socket.
 */
import type { ForkNode } from "./protocol";

/** One `search_nodes` row, as every transport serves it. */
export interface MctsRow {
  id: string; parent_id: string | null; depth: number;
  visits: number; value: number; status: ForkNode["status"]; action: string;
  /** Which search this row belongs to. Present on every scoped projection; the
   *  multi-root ones are unfoldable without it. */
  root_id?: string | null;
  task?: string; observation?: string; code_used?: string | null;
  branch_agent_key?: string | null; msg_id?: string | null; created_at?: number;
}

/**
 * Split a multi-root payload into one row list per search, in arrival order.
 *
 * The canvas reads every tree in one projection, and folding that with
 * {@link buildTree} directly would keep exactly ONE of them — which is the bug
 * `root_id` scoping was introduced to end. Rows whose `root_id` is absent are
 * dropped rather than pooled under a sentinel: a row that cannot say which tree
 * it belongs to cannot be drawn in one.
 */
export function groupByRoot(rows: readonly MctsRow[]): Map<string, MctsRow[]> {
  const byRoot = new Map<string, MctsRow[]>();
  for (const row of rows) {
    if (!row.root_id) continue;
    const list = byRoot.get(row.root_id);
    if (list) list.push(row); else byRoot.set(row.root_id, [row]);
  }
  return byRoot;
}

/**
 * Fold rows into the tree. The server scopes rows to one search; if a payload
 * still carries several searches' roots (an old server, a mid-deploy
 * broadcast), the NEWEST root wins — rooting at the oldest is how the first
 * search a workspace ever ran shadowed every one after it.
 *
 * A search node always carries a score and a rollout count, so these are never
 * null on this path; a merged fork, which has neither, reaches `ForkNode`
 * through `headRunToTree` instead.
 */
export function buildTree(nodes: MctsRow[]): ForkNode {
  const map = new Map<string, ForkNode>();
  for (const n of nodes) {
    map.set(n.id, {
      id: n.id, parentId: n.parent_id, depth: n.depth, visits: n.visits,
      value: n.value, status: n.status, action: n.action,
      task: n.task, observation: n.observation, codeUsed: n.code_used,
      branchAgentKey: n.branch_agent_key, msgId: n.msg_id, createdAt: n.created_at,
      children: [],
    });
  }
  let root: ForkNode | null = null;
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else if (
      !root
      || node.depth < root.depth // a true root beats a stray orphan
      || (node.depth === root.depth && (node.createdAt ?? 0) > (root.createdAt ?? 0))
    ) {
      root = node;
    }
  }
  return root ?? { id: "root", parentId: null, depth: 0, visits: 0, value: 0, status: "open", action: "root", children: [] };
}
