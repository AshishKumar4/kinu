/**
 * The workspace-spend aggregate, run on real Durable Object SQLite.
 *
 * WHY THIS IS A PLATFORM TEST AND NOT A SQL-SHAPE ONE. The totals the Activity
 * panel renders are summed by ONE query (`RunEventRecorder.spendByProducer`)
 * whose whole method is SQLite features the repository had never asked a Durable
 * Object for on a production read path: `WITH` common table expressions and the
 * JSON1 function `json_extract` over the `run_events.payload` column. The
 * recorder's own docstring used to say the opposite — "no production query has
 * ever depended on SQLite's JSON functions being available on both of them" —
 * and every other test of this read runs under `bun test`, i.e. against
 * `bun:sqlite`, whose feature set says nothing whatever about workerd's.
 *
 * So the question is not whether our SQL is right. It is whether the platform
 * answers it at all. A workerd SQLite built without JSON1 would throw
 * `no such function: json_extract` on the first render of the cost panel, in
 * production, with 1,100 green bun tests behind it. That is the exact defect
 * class this layer exists for.
 *
 * The subject is the PRODUCTION recorder over `ctx.storage.sql`, not a
 * reimplementation: the same `initRunEventTables` DDL, the same `emit`, the same
 * `spendByProducer`. Only the SqlExecutor adapter is local, and it is the
 * tagged-template protocol `bindAgentSql` bridges in production.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  initRunEventTables, RunEventRecorder, WORKSPACE_RUN_ID,
  type SpendSource, type SqlExecutor, type Usage,
} from '@kinu.run/core';

/** One producer's row, flattened for the RPC boundary — a `Map` is not
 *  structured-cloneable through a Durable Object stub. */
export interface ProbeTally {
  readonly source: SpendSource;
  readonly calls: number;
  readonly callsWithoutUsage: number;
  readonly unpricedCalls: number;
  readonly usage: Usage;
  readonly usd: number | null;
}

export class SpendProbeDO extends DurableObject<Cloudflare.Env> {
  // SAFETY: the same assertion `bindAgentSql` (runtime.ts:113) makes, at the
  // same boundary and for the same reason. `SqlExecutor` and the platform's
  // `sql.exec` are one tagged-template protocol; `SqlExecutor` additionally
  // admits ArrayBuffer, which Durable Object SQLite binds at runtime and does
  // not type, so the FUNCTION is asserted once rather than each row it returns.
  // The Agents SDK is not hosted in this worker, which is why the bridge is here.
  private readonly sql = ((
    query: TemplateStringsArray, ...values: SqlStorageValue[]
  ) => this.ctx.storage.sql.exec(query.join('?'), ...values).toArray()) as SqlExecutor;

  private recorder(): RunEventRecorder {
    initRunEventTables((ddl) => { this.ctx.storage.sql.exec(ddl); });
    return new RunEventRecorder(this.sql);
  }

  /**
   * Write more rows than any window this read was ever folded over, then sum
   * them the way production does.
   *
   * `steps` carries a `messages` array on purpose: a `step_finish` payload holds
   * the step's model messages, so it is the row kind whose JSON walk is
   * expensive, and a query that only ever met a small payload would not have
   * measured the shape the platform actually stores.
   */
  measure(steps: number, judges: number, silent: number): ProbeTally[] {
    const recorder = this.recorder();
    const messages = [
      { role: 'user' as const, content: 'x'.repeat(600) },
      { role: 'assistant' as const, content: 'y'.repeat(1200) },
    ];
    for (let i = 0; i < steps; i++) {
      recorder.emit('run-1', {
        type: 'step_finish', stepIndex: i, messages,
        usage: { input: 1800, output: 240, cacheRead: 1600, neurons: 3.5 },
        usd: 0.002,
      });
    }
    for (let i = 0; i < judges; i++) {
      recorder.emit(WORKSPACE_RUN_ID, {
        type: 'model_call', source: 'judge', usage: { input: 900, output: 60 },
      });
    }
    // A provider that returns no usage field of any kind — the Workers AI
    // utility bindings. Counted in calls, absent from tokens.
    for (let i = 0; i < silent; i++) {
      recorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'platform' });
    }
    return [...recorder.spendByProducer()].map(([source, tally]) => ({
      source,
      calls: tally.calls,
      callsWithoutUsage: tally.callsWithoutUsage,
      unpricedCalls: tally.unpricedCalls,
      usage: tally.usage,
      usd: tally.usd ?? null,
    }));
  }

  /** How many rows the log holds, so the assertion can state that the sum
   *  covered every one of them rather than a window's worth. */
  rows(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM run_events').one().n;
  }
}
