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

import { Database } from 'bun:sqlite';
import { mockAgentsSdk } from './agents-sdk.js';

mockAgentsSdk();

const { OrchestratorAgent } = await import('../../src/orchestrator.js');
const { SubordinateAgent } = await import('../../src/subordinate-agent.js');

export interface ActorHarness<T> {
  readonly agent: T;
  readonly db: Database;
  /** All user tables currently in the actor's storage. */
  tableNames(): string[];
}

function makeCtx(db: Database): unknown {
  const sqlExec = (query: string, ...bindings: unknown[]) => {
    const stmt = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
      const rows = stmt.all(...(bindings as never[])) as Array<Record<string, unknown>>;
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    }
    stmt.run(...(bindings as never[]));
    return { toArray: () => [] as Array<Record<string, unknown>>, [Symbol.iterator]: () => [][Symbol.iterator]() };
  };
  return {
    storage: {
      sql: { exec: sqlExec },
      get: async () => undefined,
      put: async () => {},
      setAlarm: async () => {},
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    id: { toString: () => 'harness-actor', name: 'harness-actor' },
    waitUntil: () => {},
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    abort: () => {},
  };
}

/** Env with the bindings actor construction reaches. LOADER and UserDO are
 *  present-but-inert: deps construction captures them; using them throws. */
function makeEnv(): unknown {
  return {
    PROTEUS_MAX_STEPS: '10',
    LOADER: { get: () => { throw new Error('harness LOADER: codemode is not executable under bun'); } },
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
}

function instantiate<T>(Actor: new (ctx: never, env: never) => T, db: Database): ActorHarness<T> {
  const agent = new Actor(makeCtx(db) as never, makeEnv() as never);
  const dynamic = agent as unknown as Record<string, unknown>;
  // The agents-SDK members the stub base class does not provide: the `sql`
  // tagged template, and the DO's stable `name`.
  dynamic.sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    const stmt = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...(values as never[]));
    stmt.run(...(values as never[]));
    return [];
  };
  Object.defineProperty(agent, 'name', { value: 'harness-actor', configurable: true });
  return {
    agent,
    db,
    tableNames: () => (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND type='table' ORDER BY name")
      .all() as Array<{ name: string }>).map((r) => r.name),
  };
}

/** A real OrchestratorAgent with a claimed owner, schema ensured. */
export function orchestratorHarness(): ActorHarness<InstanceType<typeof OrchestratorAgent>> {
  const harness = instantiate(OrchestratorAgent as never, new Database(':memory:')) as ActorHarness<InstanceType<typeof OrchestratorAgent>>;
  (harness.agent as unknown as { ensureSchema(): void }).ensureSchema();
  harness.db.prepare(
    "INSERT OR REPLACE INTO workspace_identity (id, name, owner_user_id, created_at) VALUES ('harness-id', 'harness-actor', 'harness-owner', ?)",
  ).run(Date.now());
  return harness;
}

/** A real SubordinateAgent with a claimed owner and a seeded identity (what
 *  the parent's setSubordinateIdentity RPC installs), schema ensured. */
export function subordinateHarness(): ActorHarness<InstanceType<typeof SubordinateAgent>> {
  const harness = instantiate(SubordinateAgent as never, new Database(':memory:')) as ActorHarness<InstanceType<typeof SubordinateAgent>>;
  (harness.agent as unknown as { ensureSchema(): void }).ensureSchema();
  harness.db.prepare(
    "INSERT OR REPLACE INTO workspace_identity (id, name, owner_user_id, created_at) VALUES ('harness-id', 'harness-actor', 'harness-owner', ?)",
  ).run(Date.now());
  harness.db.prepare(
    `INSERT OR REPLACE INTO subordinate_identity
       (id, name, display_name, role, mission, parent_workspace, owner_user_id)
     VALUES (1, 'harness-sub', 'Harness Sub', 'specialist', 'observe conformance', 'harness-parent', 'harness-owner')`,
  ).run();
  return harness;
}
