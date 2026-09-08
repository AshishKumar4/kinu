import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolSet } from 'ai';
import type { SqlExecutor } from '../types/primitives';

export interface TaskPlan {
  readonly id: string;
  readonly revision: number;
  readonly sessionId: string;
}
interface Scope { readonly sql: readonly SqlExecutor[]; readonly plan: TaskPlan | null; readonly transaction: <T>(write: () => T) => T }
// Work-mode context carries no actor store or approval identity. This scope is
// captured once by the trusted turn owner and retained by nested codemode calls.
const scope = new AsyncLocalStorage<Scope | undefined>();
export function taskPlanScope(sql: SqlExecutor): Scope | undefined {
  const current = scope.getStore();
  return current?.sql.includes(sql) ? current : undefined;
}
export function bindTaskPlan<Args extends unknown[], Result>(invoke: (...args: Args) => Result): (...args: Args) => Result {
  const captured = scope.getStore();
  return (...args) => scope.run(captured, () => invoke(...args));
}
export function withTaskPlan(tools: ToolSet, sql: readonly SqlExecutor[],  plan: TaskPlan | null, transaction: Scope['transaction']): ToolSet {
  const bound: ToolSet = {};
  const context: Scope = { sql, plan, transaction };
  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    bound[name] = execute === undefined ? entry : { ...entry,
      execute: (input, options) => scope.run(context, () => execute(input, options)),
    };
  }
  return bound;
}
