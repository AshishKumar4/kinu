// The agent's own task list, written only by the `tasks` tool; deliberately one level deep, not a workflow
// engine. Ids `t1`, `t2`, … come from the owning actor's sequence; lists are private per actor (manifest.ts).

import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import * as v from 'valibot';
import type { ActiveRoster } from '../prompting/volatile-context';
import { sqlCheckList } from '../identity/schema';
import { taskPlanScope, type TaskPlan } from './plan-scope';

export const TASK_STATUSES = ['open', 'active', 'done', 'dropped'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TaskStatusSchema = v.picklist(TASK_STATUSES);

const OPEN_STATUSES: ReadonlySet<string> = new Set(['open', 'active']);

export interface AgentTask {
  id: string;
  parentId: string | null;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  /** Operator annotation from `tasks.update`; own table because agent_tasks is genesis-locked. */
  readonly note: string | null;
}

export interface AgentTaskTree extends AgentTask {
  subtasks: AgentTask[];
}

const AgentTaskSchema = v.object({ id: v.string(), parentId: v.nullable(v.string()), title: v.string(), status: TaskStatusSchema, createdAt: v.number(), updatedAt: v.number(), note: v.nullable(v.string()) });

export const AgentTaskTreeSchema = v.object({ ...AgentTaskSchema.entries, subtasks: v.array(AgentTaskSchema) });

/** Read-only plan progress for one actor, usable without a write handle; scoped on both sides of the join. */
export function readPlanTasks(sql: SqlExecutor, actor: ActorHandle, plan: TaskPlan): AgentTaskTree[] {
  actor.assertCurrent();

  return nest(sql<Row>`SELECT t.id,t.parent_id,t.title,t.status,t.created_at,t.updated_at,n.note
    FROM agent_tasks t INNER JOIN plan_task_links l ON l.task_id=t.id AND l.actor_id=t.actor_id
    LEFT JOIN agent_task_notes n ON n.actor_id=t.actor_id AND n.task_id=t.id
    WHERE t.actor_id=${actor.actorId} AND l.plan_id=${plan.id}
      AND l.revision=${plan.revision} AND l.session_id=${plan.sessionId}
    ORDER BY t.seq`.map(toTask));
}

interface Row {
  id: string; parent_id: string | null; title: string; status: string;
  created_at: number; updated_at: number; note: string | null;
}

function toTask(r: Row): AgentTask {
  // An unknown stored status is corruption, never open (reads would disagree); name it for the repair.
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
    note: r.note,
  };
}

export function initTaskListTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_tasks (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    parent_id  TEXT,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${sqlCheckList(TASK_STATUSES)})),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  // Per-actor: a table-wide UNIQUE(seq) would collide actors' `t{seq}` numbering.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_seq ON agent_tasks(actor_id, seq)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(actor_id, status)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(actor_id, parent_id)`);
  // Own table: agent_tasks is genesis-locked; reads LEFT JOIN it, so a missing row is a null note.
  execRaw(`CREATE TABLE IF NOT EXISTS agent_task_notes (
    actor_id TEXT NOT NULL,
    task_id  TEXT NOT NULL,
    note     TEXT NOT NULL,
    PRIMARY KEY (actor_id, task_id)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS plan_task_links (actor_id TEXT NOT NULL, task_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (actor_id, task_id))`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_plan_task_revision ON plan_task_links(actor_id,session_id,plan_id,revision)`);
}

/** The model gets the reason, never a silent drop. */
export interface TaskAddRejection {
  readonly title: string;
  readonly reason: string;
}

export interface TaskAddResult {
  readonly added: AgentTask[];
  readonly rejected: TaskAddRejection[];
}

/** Titles arrive from the model; bounded to stay one line in the live context block. */
export const MAX_TASK_TITLE_CHARS = 200;

export class TaskListStore {
  private readonly actorId: string;

  /** `actorId` is captured once so the store cannot be re-pointed. `transactionSync` is required: the
   *  two INSERTs in {@link addLinked} must land or fail together. */
  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    private readonly transactionSync: <T>(write: () => T) => T,
  ) {
    this.actorId = actor.actorId;
  }

  /** Batched: a plan is written at once, avoiding a model round trip per line. */
  add(titles: readonly string[], parentId: string | null, now: number): TaskAddResult {
    this.actor.assertCurrent();
    const scope = taskPlanScope(this.sql);
    const write = () => this.addLinked(titles, parentId, now, scope?.plan ?? null);

    return this.transactionSync(write);
  }

  private addLinked(titles: readonly string[], parentId: string | null, now: number, plan: TaskPlan | null): TaskAddResult {
    // A subtask inherits its parent's plan link, not the actor's live scope.
    const linkedPlan = parentId === null
      ? plan
      : this.sql<TaskPlan>`SELECT plan_id AS id, revision, session_id AS sessionId FROM plan_task_links WHERE actor_id=${this.actorId} AND task_id=${parentId}`[0] ?? null;

    const parent = parentId === null ? null : this.get(parentId);

    if (parentId !== null && !parent) {
      return { added: [], rejected: titles.map((title) => ({ title, reason: `no task ${parentId}` })) };
    }

    // One level on purpose.
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
      void this.sql`INSERT INTO agent_tasks (actor_id, id, seq, parent_id, title, status, created_at, updated_at)
        VALUES (${this.actorId}, ${id}, ${seq}, ${parentId}, ${title}, 'open', ${now}, ${now})`;

      if (linkedPlan) void this.sql`INSERT INTO plan_task_links(actor_id,task_id,plan_id,revision,session_id) VALUES (${this.actorId},${id},${linkedPlan.id},${linkedPlan.revision},${linkedPlan.sessionId})`;
      added.push({ id, parentId, title, status: 'open', createdAt: now, updatedAt: now, note: null });
      seq++;
    }

    return { added, rejected };
  }

  /** A cleared note deletes its row so the LEFT JOIN reads null, not ''. Null when there is no such id. */
  update(id: string, patch: { readonly status?: TaskStatus; readonly note?: string | null }, now: number): AgentTask | null {
    this.actor.assertCurrent();

    if (!this.get(id)) return null;

    if (patch.status !== undefined) {
      void this.sql`UPDATE agent_tasks SET status=${patch.status}, updated_at=${now}
        WHERE actor_id=${this.actorId} AND id=${id}`;
    }

    if (patch.note !== undefined) {
      if (patch.note === null) {
        void this.sql`DELETE FROM agent_task_notes WHERE actor_id=${this.actorId} AND task_id=${id}`;
      } else {
        void this.sql`INSERT INTO agent_task_notes (actor_id, task_id, note) VALUES (${this.actorId}, ${id}, ${patch.note})
          ON CONFLICT(actor_id, task_id) DO UPDATE SET note=excluded.note`;
      }
    }

    return this.get(id);
  }

  get(id: string): AgentTask | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`SELECT t.id, t.parent_id, t.title, t.status, t.created_at, t.updated_at, n.note
      FROM agent_tasks t LEFT JOIN agent_task_notes n ON n.actor_id=t.actor_id AND n.task_id=t.id
      WHERE t.actor_id=${this.actorId} AND t.id=${id} LIMIT 1`;

    return rows[0] ? toTask(rows[0]) : null;
  }

  /** Open or active subtasks; invisible from the parent row. */
  countOpenSubtasks(id: string): number {
    this.actor.assertCurrent();

    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM agent_tasks
      WHERE actor_id=${this.actorId} AND parent_id=${id} AND status IN ('open', 'active')`;

    return rows[0]?.n ?? 0;
  }

  list(limit = 200): AgentTaskTree[] {
    return nest(this.rows(limit));
  }

  /** Live-context roster: a parent is included when it or a subtask is open. Open rows are selected
   *  before `limit`, and `total` counts every open row, so stated elision is true. */
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

  count(): number {
    this.actor.assertCurrent();
    const rows = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM agent_tasks WHERE actor_id=${this.actorId}`;

    return rows[0]?.n ?? 0;
  }

  /** `limit` is a transport bound (-1 = whole list); `listOpen` reads unbounded so its filter runs first. */
  private rows(limit = -1): AgentTask[] {
    this.actor.assertCurrent();

    return this.sql<Row>`SELECT t.id, t.parent_id, t.title, t.status, t.created_at, t.updated_at, n.note
      FROM agent_tasks t LEFT JOIN agent_task_notes n ON n.actor_id=t.actor_id AND n.task_id=t.id
      WHERE t.actor_id=${this.actorId} ORDER BY t.seq ASC LIMIT ${limit}`.map(toTask);
  }

  /** Scoped per actor, so two actors' ids run independently. */
  private nextSeq(): number {
    const rows = this.sql<{ n: number | null }>`SELECT MAX(seq) AS n FROM agent_tasks WHERE actor_id=${this.actorId}`;

    return (rows[0]?.n ?? 0) + 1;
  }
}

/** A task goes under its parent when that parent is in this window, else stands alone. One pass: parents
 *  are always written before their subtasks. */
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
