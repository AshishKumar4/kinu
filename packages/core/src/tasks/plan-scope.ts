import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';
import type { SqlExecutor } from '../types/primitives';

export interface TaskPlan {
  readonly id: string;
  readonly revision: number;
  readonly sessionId: string;
}
export interface TaskPlanContext {
  readonly sql: readonly SqlExecutor[];
  readonly plan: TaskPlan | null;
}
// Work-mode context contains no actor store or approval identity. The trusted
// turn owner captures this scope; the store, not ALS, owns atomic writes.
const scope = new AsyncLocalStorage<TaskPlanContext | undefined>();
export function taskPlanScope(sql: SqlExecutor): TaskPlanContext | undefined {
  const current = scope.getStore();
  return current?.sql.includes(sql) ? current : undefined;
}
export function runTaskPlan<Result>(context: TaskPlanContext | null, invoke: () => Result): Result {
  return scope.run(context ?? undefined, invoke);
}
export function bindTaskPlan<Value, Result>(invoke: (...args: Value[]) => Result, context: TaskPlanContext | null = scope.getStore() ?? null): (...args: Value[]) => Result {
  return (...args) => scope.run(context ?? undefined, () => invoke(...args));
}
export function withTaskPlan(tools: ToolSet, context: TaskPlanContext): ToolSet {
  const bound: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    bound[name] = execute === undefined ? entry : { ...entry,
      execute: (input, options) => scope.run(context, () => execute(input, options)),
    };
  }
  return bound;
}
