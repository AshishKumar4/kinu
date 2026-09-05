// The agent's own task list — what it has decided to do, and how far along it
// is. Written by the `tasks` tool and by nothing else; read by the tool, by the
// live dynamic-context block, and by the Tasks surface.
//
// Deliberately NOT a workflow engine. There are no dependencies, priorities,
// due dates or assignees, and nesting stops at one level: an item is either a
// task or a subtask of a task. Anything deeper is a plan the agent should be
// writing down as prose, not a shape this table should learn to hold.
//
// Ids are `t1`, `t2`, … — minted from a per-workspace sequence, short enough
// that the model refers to them in prose ("t4 is blocked on t2") and stable for
// the life of the workspace, which is what makes them referable at all.

import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import * as v from 'valibot';
import type { ActiveRoster } from '../prompting/volatile-context';
import { sqlCheckList } from '../identity/schema';

export const TASK_STATUSES = ['open', 'active', 'done', 'dropped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const TaskStatusSchema = v.picklist(TASK_STATUSES);

const OPEN_STATUSES: ReadonlySet<string> = new Set(['open', 'active']);

export interface AgentTask {
  id: string;
  /** The parent task's id, or null for a top-level task. */
  parentId: string | null;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

/** One top-level task with the subtasks written under it. */
export interface AgentTaskTree extends AgentTask {
  subtasks: AgentTask[];
}

interface Row {
  id: string; parent_id: string | null; title: string; status: string;
  created_at: number; updated_at: number;
}

function toTask(r: Row): AgentTask {
  // An unknown stored status is corruption, never open: answering open here
  // while the open-filtered reads skip the same row shows one item in two
  // places at once. Refuse naming the value so the repair knows what to fix.
  const status = v.safeParse(TaskStatusSchema, r.status);
  if (!status.success) {
    throw new Error(
      `agent_tasks row '${r.id}' stores unknown status '${r.status}'`
      + ` — expected one of ${TASK_STATUSES.join(', ')}`,
    );
  }
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    status: status.output,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function initTaskListTable(execRaw: RawSqlExec, sql: SqlExecutor): void {
  const ddl = `(
    id         TEXT PRIMARY KEY,
    seq        INTEGER NOT NULL,
    parent_id  TEXT,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${sqlCheckList(TASK_STATUSES)})),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
  // Widening the status CHECK: SQLite cannot ALTER one, so a table created
  // before the vocabulary was constrained is renamed aside, recreated, and
  // copied back (the experience/library.ts discipline). The probe is the
  // status LIST itself, so widening the vocabulary is the only edit ever
  // needed here, and `_legacy` is the resume point for a crash mid-sequence:
  // rows stranded there are copied before a bare CREATE starts an empty one.
  const storedDdl = (name: string): string | null => {
    const rows = sql<{ sql: string | null }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
    return rows[0]?.sql ?? null;
  };
  const live = storedDdl('agent_tasks');
  const narrow = live !== null && TASK_STATUSES.some((status) => !live.includes(`'${status}'`));
  const stranded = storedDdl('agent_tasks_legacy') !== null;
  if (narrow) {
    execRaw(`ALTER TABLE agent_tasks RENAME TO agent_tasks_legacy`);
  }
  execRaw(`CREATE TABLE IF NOT EXISTS agent_tasks ${ddl}`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_id)`);
  if (narrow || stranded) {
    execRaw(`INSERT OR IGNORE INTO agent_tasks SELECT * FROM agent_tasks_legacy`);
    execRaw(`DROP TABLE agent_tasks_legacy`);
  }
}

/** What `add` refused, and why — the model gets the reason, never a silent drop. */
export interface TaskAddRejection {
  readonly title: string;
  readonly reason: string;
}

export interface TaskAddResult {
  readonly added: AgentTask[];
  readonly rejected: TaskAddRejection[];
}

/** A title long enough to be a real step, short enough to stay one line in the
 *  live context block. Titles arrive from the model, so the bound is enforced
 *  here rather than trusted. */
export const MAX_TASK_TITLE_CHARS = 200;

export class TaskListStore {
  constructor(private readonly sql: SqlExecutor) {}

  /**
   * Append titles to the list, optionally as subtasks of `parentId`.
   *
   * Batched because a plan is written at once: the alternative is one tool call
   * per step, which costs a model round trip per line of a list it already has
   * in mind.
   */
  add(titles: readonly string[], parentId: string | null, now: number): TaskAddResult {
    const parent = parentId === null ? null : this.get(parentId);
    if (parentId !== null && !parent) {
      return { added: [], rejected: titles.map((title) => ({ title, reason: `no task ${parentId}` })) };
    }
    // One level, on purpose: a subtask of a subtask is a tree, and a tree is
    // the workflow engine this list refuses to become.
    if (parent && parent.parentId !== null) {
      return {
        added: [],
        rejected: titles.map((title) => ({
          title,
          reason: `${parent.id} is itself a subtask — subtasks nest one level only`,
        })),
      };
    }

    const added: AgentTask[] = [];
    const rejected: TaskAddRejection[] = [];
    let seq = this.nextSeq();
    for (const raw of titles) {
      const title = raw.trim();
      if (title.length === 0) {
        rejected.push({ title: raw, reason: 'empty title' });
        continue;
      }
      if (title.length > MAX_TASK_TITLE_CHARS) {
        rejected.push({ title, reason: `title over ${MAX_TASK_TITLE_CHARS} characters` });
        continue;
      }
      const id = `t${seq}`;
      void this.sql`INSERT INTO agent_tasks (id, seq, parent_id, title, status, created_at, updated_at)
        VALUES (${id}, ${seq}, ${parentId}, ${title}, 'open', ${now}, ${now})`;
      added.push({ id, parentId, title, status: 'open', createdAt: now, updatedAt: now });
      seq++;
    }
    return { added, rejected };
  }

  /** Set an item's status. Null when there is no such id. */
  setStatus(id: string, status: TaskStatus, now: number): AgentTask | null {
    if (!this.get(id)) return null;
    void this.sql`UPDATE agent_tasks SET status=${status}, updated_at=${now} WHERE id=${id}`;
    return this.get(id);
  }

  get(id: string): AgentTask | null {
    const rows = this.sql<Row>`SELECT id, parent_id, title, status, created_at, updated_at
      FROM agent_tasks WHERE id=${id} LIMIT 1`;
    return rows[0] ? toTask(rows[0]) : null;
  }

  /** How many of a task's subtasks are still open or active — the one thing an
   *  agent closing a parent cannot see from the parent row. */
  countOpenSubtasks(id: string): number {
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM agent_tasks WHERE parent_id=${id} AND status IN ('open', 'active')`;
    return rows[0]?.n ?? 0;
  }

  /** The whole list in write order, parents each carrying their subtasks. */
  list(limit = 200): AgentTaskTree[] {
    return nest(this.rows(limit));
  }

  /** Only the items still to be done, in write order — the live-context
   *  roster. A parent is included when it or any of its subtasks is still
   *  open, so a subtask never renders orphaned from the task it belongs to.
   *
   *  OPEN items are selected BEFORE the bound: `limit` bounds only the
   *  returned page, while `total` counts every flattened open row — so an
   *  open task behind hundreds of closed siblings is still visible, and the
   *  elision a renderer states from `total` is the truth. */
  listOpen(limit = 200): ActiveRoster<AgentTaskTree> {
    const trees = nest(this.rows());
    const items: AgentTaskTree[] = [];
    let rowsShown = 0;
    let total = 0;
    for (const tree of trees) {
      const subtasks = tree.subtasks.filter((t) => OPEN_STATUSES.has(t.status));
      if (!OPEN_STATUSES.has(tree.status) && subtasks.length === 0) continue;
      const open = { ...tree, subtasks };
      total += 1 + subtasks.length;
      if (rowsShown < limit) {
        items.push(open);
        rowsShown += 1 + subtasks.length;
      }
    }
    return { items, total };
  }

  /** How many items the list holds in total — what a capped read elided. */
  count(): number {
    const rows = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_tasks`;
    return rows[0]?.n ?? 0;
  }

  /** Write order, newest last. `limit` is a transport bound (-1 = whole list);
   *  `listOpen` reads unbounded so its filter runs before any bound. */
  private rows(limit = -1): AgentTask[] {
    return this.sql<Row>`SELECT id, parent_id, title, status, created_at, updated_at
      FROM agent_tasks ORDER BY seq ASC LIMIT ${limit}`.map(toTask);
  }


  private nextSeq(): number {
    const rows = this.sql<{ n: number | null }>`SELECT MAX(seq) AS n FROM agent_tasks`;
    return (rows[0]?.n ?? 0) + 1;
  }
}

/** Group a flat write-ordered list into parents carrying their subtasks: a task
 *  goes under its parent when that parent is in this window, and stands on its
 *  own when it is not. One pass — a parent is always written before its
 *  subtasks, so it is always already in the map by the time they arrive. */
function nest(tasks: readonly AgentTask[]): AgentTaskTree[] {
  const seen = new Map<string, AgentTaskTree>();
  const order: AgentTaskTree[] = [];
  for (const task of tasks) {
    const parent = task.parentId === null ? undefined : seen.get(task.parentId);
    if (parent) {
      parent.subtasks.push(task);
      continue;
    }
    const tree: AgentTaskTree = { ...task, subtasks: [] };
    seen.set(task.id, tree);
    order.push(tree);
  }
  return order;
}
