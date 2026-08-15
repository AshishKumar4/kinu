/**
 * Instantiate a REAL cf actor class under bun — the platform mocked at its
 * genuine seams (agents SDK base class, DO storage over bun:sqlite, env
 * bindings), everything above them the production code itself.
 *
 * Until this harness existed, no test constructed an ActorAgent at all: the
 * cf turn pipeline was verified only by reading its own source, which is how
 * a composition root can be green in every unit test while a capability it
 * forgot to wire never exists in production. The conformance suite runs the
 * real `ensureSchema` and the real `getRawTools` through this and observes
 * what actually comes out.
 *
 * Boundaries stated honestly: nothing here can RUN a model turn (Think's loop
 * needs workerd) or execute codemode (env.LOADER is a stub that throws). This
 * harness is for observing composition output, not for driving inference.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { AgentContext } from 'agents';
import type { ToolSet } from 'ai';
import type { SqlExecRow, SqlValue } from '@proteus/core';
import { mockAgentsSdk } from './agents-sdk.js';

mockAgentsSdk();

const { OrchestratorAgent } = await import('../../src/orchestrator.js');
const { SubordinateAgent } = await import('../../src/subordinate-agent.js');

class HarnessOrchestratorAgent extends OrchestratorAgent {
  observeRawTools(): ToolSet { return this.getRawTools(); }
  setObservedSoul(text: string): void { this._cachedSoulText = text; }
}

class HarnessSubordinateAgent extends SubordinateAgent {
  observeRawTools(): ToolSet { return this.getRawTools(); }
}

export interface ActorHarness<T> {
  readonly agent: T;
  readonly db: Database;
  /** All user tables currently in the actor's storage. */
  tableNames(): string[];
}

function nativeBindings(values: SqlValue[]): SQLQueryBindings[] {
  return values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

function makeCtx(db: Database): AgentContext {
  const sqlExec = (query: string, ...bindings: SqlValue[]) => {
    const stmt = db.prepare<SqlExecRow, SQLQueryBindings[]>(query);
    const bound = nativeBindings(bindings);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
      const rows = stmt.all(...bound);
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    }
    stmt.run(...bound);
    const rows: SqlExecRow[] = [];
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  };
  const context = {
    storage: {
      sql: { exec: sqlExec },
      // Real, not a callback passthrough: the durable filesystem's atomicity
      // rests on this, and a fake turns every atomic write into a torn one
      // that still reports success. Nimbus refuses to boot without it.
      transactionSync: <T>(closure: () => T): T => db.transaction(closure)(),
      get: async () => undefined,
      put: async () => {},
      setAlarm: async () => {},
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    id: { toString: () => 'harness-actor', name: 'harness-actor' },
    waitUntil: () => {},
    blockConcurrencyWhile: <Result>(fn: () => Promise<Result>): Promise<Result> => fn(),
    abort: () => {},
  };
  const partialContext: Partial<AgentContext> = {};
  Object.assign(partialContext, context);
  // SAFETY: the Agent constructor contract stores this locally constructed
  // context, and actor schema initialization only calls the implemented SQL,
  // transaction, identity, alarm, and concurrency members above.
  return partialContext as AgentContext;
}

/** Env with the bindings actor construction reaches. LOADER and UserDO are
 *  present-but-inert: deps construction captures them; using them throws. */
function makeEnv(): Env {
  const bindings = {
    PROTEUS_MAX_STEPS: '10',
    LOADER: { get: () => { throw new Error('harness LOADER: codemode is not executable under bun'); } },
    // Runtime construction now requires the hosted-workspace binding. The
    // handle remains lazy, so surface-composition tests do not call this stub.
    NIMBUS_SESSION: {},
    AI_GATEWAY_URL: 'https://gateway.invalid/v1',
    AI_GATEWAY_AUTH: 'harness-token',
    UserDO: {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => new Proxy({}, {
        get: (_t, prop) => {
          if (prop === 'then') return undefined;
          return async () => { throw new Error(`harness UserDO: ${String(prop)} is not reachable under bun`); };
        },
      }),
    },
  };
  const env: Partial<Env> = {};
  Object.assign(env, bindings);
  // SAFETY: the ActorAgent dependency contract only reads the constructed
  // LOADER, NIMBUS_SESSION, UserDO, and gateway bindings in this harness; each
  // unsupported operation throws if schema composition begins invoking it.
  return env as Env;
}

function instantiate<T extends object>(Actor: new (ctx: AgentContext, env: Env) => T, db: Database): ActorHarness<T> {
  const agent = new Actor(makeCtx(db), makeEnv());
  return {
    agent,
    db,
    tableNames: () => db.prepare<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND type='table' ORDER BY name",
    ).all().map((row) => row.name),
  };
}

function ensureActorSchema(
  agent: InstanceType<typeof OrchestratorAgent> | InstanceType<typeof SubordinateAgent>,
): void {
  // Think wraps `onStart` with asynchronous SDK initialization. Invoke the
  // production overrides directly: both create their complete schema before
  // their first await, which is the lifecycle behavior this harness observes.
  if (agent instanceof OrchestratorAgent) {
    void OrchestratorAgent.prototype.onStart.call(agent);
  } else {
    void SubordinateAgent.prototype.onStart.call(agent);
  }
}

/** A real OrchestratorAgent with a claimed owner, schema ensured. */
export function orchestratorHarness(): ActorHarness<HarnessOrchestratorAgent> {
  const harness = instantiate(HarnessOrchestratorAgent, new Database(':memory:'));
  ensureActorSchema(harness.agent);
  harness.db.prepare(
    "UPDATE workspace_identity SET owner_user_id = 'harness-owner' WHERE id = 'harness-actor'",
  ).run();
  return harness;
}

/** A real SubordinateAgent with a claimed owner and a seeded identity (what
 *  the parent's setSubordinateIdentity RPC installs), schema ensured. */
export function subordinateHarness(): ActorHarness<HarnessSubordinateAgent> {
  const harness = instantiate(HarnessSubordinateAgent, new Database(':memory:'));
  Object.defineProperty(harness.agent, 'messages', {
    value: [{ role: 'user', metadata: { proteusEvent: 'subordinate_task' } }],
    configurable: true,
  });
  ensureActorSchema(harness.agent);
  harness.db.prepare(
    "UPDATE workspace_identity SET owner_user_id = 'harness-owner' WHERE id = 'harness-actor'",
  ).run();
  harness.db.prepare(
    `INSERT OR REPLACE INTO subordinate_identity
       (id, name, display_name, role, mission, parent_workspace, owner_user_id)
     VALUES (1, 'harness-sub', 'Harness Sub', 'specialist', 'observe conformance', 'harness-parent', 'harness-owner')`,
  ).run();
  return harness;
}
