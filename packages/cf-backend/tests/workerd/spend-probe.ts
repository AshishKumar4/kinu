/**
 * `RunEventRecorder.spendByProducer` on real DO SQLite: it uses `WITH` CTEs and JSON1 `json_extract`,
 * which `bun:sqlite` passing does not prove workerd supports. Production recorder; only the SqlExecutor
 * adapter is local.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  bindActorHandle, initRunEventTables, RunEventRecorder, WORKSPACE_RUN_ID,
  type ActorHandle, type SpendSource, type SqlExecutor, type SqlValue, type Usage,
} from '@kinu.run/core';

/** Flattened: a `Map` is not structured-cloneable through a DO stub. */
export interface ProbeTally {
  readonly source: SpendSource;
  readonly calls: number;
  readonly callsWithoutUsage: number;
  readonly unpricedCalls: number;
  readonly usage: Usage;
  readonly usd: number | null;
}

export class SpendProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly sql: SqlExecutor = <Row,>(
    query: TemplateStringsArray, ...values: SqlValue[]
  ): Row[] => this.ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>(query.join('?'), ...values).toArray();

  /** `run_events` is actor-scoped; no directory here, so one bound identity serves both halves. */
  private actor(): ActorHandle {
    return this._actor ??= bindActorHandle(this.sql, {
      actorId: 'spend-probe-actor', workspaceId: 'spend-probe-workspace', parentActorId: null,
      name: 'spend-probe', storageKey: 'agent:spend-probe-actor',
    }, () => {});
  }

  private _actor: ActorHandle | undefined;

  private recorder(): RunEventRecorder {
    initRunEventTables((ddl) => { this.ctx.storage.sql.exec(ddl); });

    return new RunEventRecorder(this.sql, this.actor());
  }

  /** `steps` carries a `messages` array: `step_finish` is the payload kind whose JSON walk is expensive. */
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

    // No usage field at all (Workers AI utility bindings): counted in calls, absent from tokens.
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

  /** So the assertion can state the sum covered every row, not a window's worth. */
  rows(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM run_events WHERE actor_id = ?', this.actor().actorId,
      ).one().n;
  }
}
