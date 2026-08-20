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
import type { IngressDescriptor, SqlExecRow, SqlValue, SubordinateRosterStore } from '@kinu/core';
import * as v from 'valibot';
import { mockAgentsSdk } from './agents-sdk';
import { platformGatewayEnv } from './platform-gateway';

mockAgentsSdk();

const { OrchestratorAgent } = await import('../../src/orchestrator');
const { SubordinateAgent } = await import('../../src/subordinate-agent');

/** The scaffold precondition a turn checks, declared satisfied — the harness
 *  workspace is empty, so nothing has written one. The soul is not declared:
 *  `setObservedSoul` pre-fills the cache the SYNCHRONOUS prompt builders read,
 *  while a turn refreshes that cache from the workspace filesystem below. */
/** The orchestrator a test drives, named so suites import the contract instead
 *  of reaching through `ReturnType<typeof orchestratorHarness>`. */
export class HarnessOrchestratorAgent extends OrchestratorAgent {
  observeRawTools(): ToolSet { return this.getRawTools(); }
  setObservedSoul(text: string): void { this._cachedSoulText = text; }
  declareScaffoldPresent(): void { this._scaffoldReady = true; }
  /** The parent-side roster the facet gate consults. Exposed rather than
   *  wrapped: the production store IS the API a test seeds a subordinate
   *  through, and a hand-written INSERT would be a second copy of its
   *  status policy. */
  harnessRoster(): SubordinateRosterStore { return this.subordinateRoster; }
  /** One auto-GEPA cadence tick — the call a completed turn makes
   *  (`orchestrator.ts` `onTurnComplete`). */
  tickAutoGepa(): void { this.maybeRunAutoGepa(); }
  /** The cadence a tick reads, and the deliberate disable a tick must respect. */
  observeAutoGepaCadence(): number { return this.config.getAutoGepaEveryNTurns(); }
  setAutoGepaCadence(turns: number): void { this.config.setAutoGepaEveryNTurns(turns); }
  /** Admit one event, through the only writer allowed to: `publish` is the
   *  single admitted author of `kind='event'` rows, so a test that wants an
   *  event in the log goes through it rather than around it with an INSERT. */
  publishHarnessEvent(descriptor: IngressDescriptor, now: number): void {
    this.eventLog.publish({ descriptor, now });
  }
}

class HarnessSubordinateAgent extends SubordinateAgent {
  observeRawTools(): ToolSet { return this.getRawTools(); }
  declareScaffoldPresent(): void { this._scaffoldReady = true; }
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

/**
 * The workspace filesystem, empty — a fresh workspace, which is a state every
 * root is genuinely in.
 *
 * An inert `{}` binding was not one: a turn reads the workspace for real (SOUL.md
 * via readSoul, then AGENTS.md via collectWorkspaceAgentsMd, and both are
 * documented to report a failed read as a failure rather than an absence), so an
 * inert binding turns every one of those reads into a Nimbus SDK TypeError and
 * the harness can only answer it by declaring one more precondition satisfied
 * per read. Answering as an empty session exercises the production path instead.
 *
 * The whole VFS surface `nimbusSessionFiles` binds, and nothing else: there is no
 * shell here, so a test that needs one says so by failing rather than by getting
 * a command that reports success. `unit-nimbus-lifecycle.test.ts` replaces the
 * binding outright where it needs to observe session lifecycle events.
 */
function emptyWorkspaceSession() {
  const files = new Map<string, string>();
  const directories = new Set(['/home', '/home/user']);
  const stub = {
    _rpcReady: async () => ({ ok: true as const, preinstalled: [] }),
    _rpcExists: async (path: string) => files.has(path) || directories.has(path),
    _rpcStat: async (path: string) => {
      const content = files.get(path);
      if (content !== undefined) return { type: 'file', size: content.length, mtime: 0, mode: 0o644 };
      return directories.has(path) ? { type: 'directory', size: 0, mtime: 0, mode: 0o755 } : null;
    },
    _rpcReadFile: async (path: string) => files.get(path) ?? null,
    _rpcReadFileBytes: async (path: string) => {
      const content = files.get(path);
      return content === undefined ? null : new TextEncoder().encode(content);
    },
    _rpcWriteFile: async (path: string, content: string | Uint8Array) => {
      const bytes = v.safeParse(v.instance(Uint8Array), content);
      files.set(path, bytes.success ? new TextDecoder().decode(bytes.output) : v.parse(v.string(), content));
      const parts = path.split('/');
      for (let i = 2; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    },
    _rpcReaddir: async (path: string) => {
      const prefix = `${path.replace(/\/$/, '')}/`;
      const entries = new Map<string, 'file' | 'directory'>();
      for (const directory of directories) {
        const rest = directory.startsWith(prefix) ? directory.slice(prefix.length) : '';
        if (rest && !rest.includes('/')) entries.set(rest, 'directory');
      }
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (rest) entries.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'directory');
      }
      return [...entries].map(([name, type]) => ({ name, type }));
    },
    _rpcMkdir: async (path: string) => { directories.add(path); },
    _rpcDeleteFile: async (path: string) => { files.delete(path); directories.delete(path); },
  };
  return { idFromName: (name: string) => name, get: () => stub };
}

/** Env with the bindings actor construction reaches. LOADER and UserDO are
 *  present-but-inert: deps construction captures them; using them throws. */
function makeEnv(): Env {
  const bindings = {
    KINU_MAX_STEPS: '10',
    LOADER: { get: () => { throw new Error('harness LOADER: codemode is not executable under bun'); } },
    NIMBUS_SESSION: emptyWorkspaceSession(),
    // The platform gateway is the harness's model provider: a parseable gateway
    // URL plus a recording AI binding, since the transport is the binding now.
    ...platformGatewayEnv(),
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
  // `onStart` is synchronous on every Kinu Durable Object (it runs inside
  // `blockConcurrencyWhile`), so the production override can simply be called:
  // its whole schema is in place when it returns.
  if (agent instanceof OrchestratorAgent) {
    OrchestratorAgent.prototype.onStart.call(agent);
  } else {
    SubordinateAgent.prototype.onStart.call(agent);
  }
}

/** A real OrchestratorAgent with a claimed owner, schema ensured. */
export function orchestratorHarness(): ActorHarness<HarnessOrchestratorAgent> {
  const harness = instantiate(HarnessOrchestratorAgent, new Database(':memory:'));
  ensureActorSchema(harness.agent);
  harness.db.prepare(
    "UPDATE workspace_identity SET owner_user_id = 'harness-owner' WHERE id = 'harness-actor'",
  ).run();
  harness.agent.declareScaffoldPresent();
  return harness;
}

/** A real SubordinateAgent with a claimed owner and a seeded identity (what
 *  the parent's setSubordinateIdentity RPC installs), schema ensured. */
export function subordinateHarness(): ActorHarness<HarnessSubordinateAgent> {
  const harness = instantiate(HarnessSubordinateAgent, new Database(':memory:'));
  Object.defineProperty(harness.agent, 'messages', {
    value: [{ role: 'user', metadata: { kinuEvent: 'subordinate_task' } }],
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
  harness.agent.declareScaffoldPresent();
  return harness;
}
