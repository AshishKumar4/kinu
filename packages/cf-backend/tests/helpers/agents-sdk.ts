import { mock } from 'bun:test';
import * as v from 'valibot';
import type { AgentContext, FiberRecoveryContext } from 'agents';
import { parseJsonValue, type JsonObject, type JsonValue, type SqlValue } from '@kinu.run/core';
import type { McpCredentialTransport } from '../../src/user/mcp';

type ModuleMockFactory = Parameters<typeof mock.module>[1];

function registerSynchronousMock(id: string, factory: ModuleMockFactory): void {
  const completion = mock.module(id, factory);
  if (completion !== undefined) {
    throw new Error(`mock.module(${id}) must register synchronously`);
  }
}

/** Fiber ids, monotonic per process so a test can read them in creation order.
 *  The real SDK uses `nanoid()`; only uniqueness is contractual. */
let harnessFiberSeq = 0;

/** Schedule row ids, monotonic per process. The real SDK uses `nanoid()`; only
 *  uniqueness is contractual. */
let harnessScheduleSeq = 0;

/** Fibers RUNNING in this process, so the interrupted scan skips them exactly
 *  as `_runFiberActiveFibers` does. Dynamic membership, hence a Set. */
const harnessActiveFibers = new Set<string>();

/** The live bodies of those fibers, so a test can JOIN what the production
 *  code detaches on purpose instead of guessing at its clock. Dynamic
 *  membership, hence a Set. */
const harnessFiberBodies = new Set<Promise<unknown>>();

/** `cf_agents_runs`, as `agents/dist/index.js:663` declares it. */
interface RunRow {
  id: string;
  name: string;
  snapshot: string | null;
  created_at: number;
}

/** One managed fiber as `listFibers` reports it. */
interface HarnessFiber {
  fiberId: string;
  name: string;
  status: string;
  createdAt: number;
}

/** The row schemas, beside the interfaces they parse into. */
const RUN_ROW_SCHEMA = v.object({
  id: v.string(),
  name: v.string(),
  snapshot: v.union([v.string(), v.null()]),
  created_at: v.number(),
});
const MANAGED_ROW_SCHEMA = v.object({
  fiber_id: v.string(),
  name: v.string(),
  status: v.string(),
  created_at: v.number(),
});
/** One `cf_agents_schedules` row, as the production sweep and `armTimer` read
 *  it. */
const SCHEDULE_ROW_SCHEMA = v.object({
  id: v.string(),
  callback: v.string(),
  type: v.string(),
  time: v.number(),
});
export type HarnessScheduleRow = v.InferOutput<typeof SCHEDULE_ROW_SCHEMA>;

/** What a recovery hook may hand back. `undefined` is the pre-`FiberRecoveryResult`
 *  shape the SDK still accepts (a `void` return), so the harness must too. */
type FiberRecoveryOutcome = { status: string } | undefined;

/**
 * Rows of a harness-owned fiber table, parsed rather than cast.
 *
 * The two tables are created by {@link mockAgentsSdk} itself, so the column
 * shape is this file's own and not outside-controlled input — the schema here
 * is the same fact said in a form the compiler and the gate can both check.
 */
function fiberRows<Row extends object>(
  schema: v.GenericSchema<Row>, sql: SqlStorage, query: string, ...bindings: SqlValue[]
): Row[] {
  return sql.exec(query, ...bindings).toArray().map((row) => v.parse(schema, row));
}

/**
 * The row a DEAD activation left: a `cf_agents_runs` row with no live fiber
 * behind it.
 *
 * This is the one state an eviction cannot be simulated without, and it cannot
 * be produced by running a fiber in-process: `runFiber` removes its id from the
 * active set and deletes its row in a `finally`, and the active set is
 * in-memory, so a real isolate loses the set and keeps the row. Seeding the row
 * directly reproduces exactly that pair — the same INSERT `runFiber` performs
 * (`agents/dist/index.js:2899`), minus the body the isolate took with it.
 */

/** Resolves when every `runFiber` body started so far has settled — the
 *  deterministic join for a lane the production code detaches on purpose. */
export async function joinHarnessFibers(): Promise<void> {
  while (harnessFiberBodies.size > 0) await Promise.all(harnessFiberBodies);
}

export function seedOrphanFiberRow(
  storage: DurableObjectStorage, name: string, snapshot: JsonValue, createdAt = Date.now(),
): string {
  const id = `orphan-${String(++harnessFiberSeq)}`;
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_runs (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    snapshot TEXT,
    created_at INTEGER NOT NULL
  )`);
  storage.sql.exec(
    `INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)`,
    id, name, snapshot === undefined ? null : JSON.stringify(snapshot), createdAt,
  );
  return id;
}

/** The recovery context the interrupted scan hands a hook, built from the row
 *  the dead activation left. `snapshot` is parsed here — the boundary between
 *  the stored JSON text and the domain value the hook reads. */
function recoveryContextOf(row: RunRow, managed: boolean): FiberRecoveryContext {
  const ctx: FiberRecoveryContext = {
    id: row.id,
    name: row.name,
    snapshot: row.snapshot === null ? null : parseJsonValue(row.snapshot),
    createdAt: row.created_at,
    recoveryReason: 'interrupted',
  };
  if (managed) ctx.status = 'interrupted';
  return ctx;
}

/** Hook throws the interrupted scan retained rows for, in scan order. The
 *  retained-row path records here rather than failing silently — the same
 *  observability the span list gives tracing. */
const retainedHookErrors: { fiberId: string; error: unknown }[] = [];

/** Retained-row hook failures since process start, for a retention assertion. */
export function recordedRetainedHookErrors(): readonly { fiberId: string; error: unknown }[] {
  return retainedHookErrors;
}

/**
 * Stub the Agent SDK so bun can import the DO-layer src modules that depend on
 * it — the real `agents` dist imports `cloudflare:*` modules that exist only
 * inside workerd.
 *
 * bun keeps ONE mock per specifier for the whole run (the first registration
 * wins), so every test that needs it must go through this single shape.
 * Call it before importing the module under test.
 */
export function mockAgentsSdk(): void {
  registerSynchronousMock('agents', () => ({
    /** Base-class token. Used as a `subAgent` class key, and as the real base
     *  for DO classes a test instantiates directly (UserDO) — hence the ctx/env
     *  assignment the real Agent constructor also performs. */
    Agent: class {
      readonly ctx: AgentContext | undefined;
      readonly env: Env | undefined;
      constructor(ctx?: AgentContext, env?: Env) {
        this.ctx = ctx;
        this.env = env;
        if (ctx) {
          Object.defineProperty(this, 'name', {
            configurable: true,
            value: ctx.id.name ?? ctx.id.toString(),
          });
          Object.defineProperty(this, 'sql', {
            configurable: true,
            value: (strings: TemplateStringsArray, ...values: SqlValue[]) => {
              const query = strings.reduce(
                (text, part, index) => text + part + (index < values.length ? '?' : ''),
                '',
              );
              return ctx.storage.sql.exec(query, ...values).toArray();
            },
          });
          this._ensureSchema();
        }
      }
      /**
       * The vendor's own migration, at the moment the vendor runs it.
       *
       * The real `Agent._ensureSchema` is called BY THE CONSTRUCTOR on every wake
       * and is documented as protected precisely so a test agent can re-run the
       * real migration path; `cf_agents_schedules` is one of the tables it
       * creates. The stand-in used to create that table lazily inside its own
       * schedule helpers instead, and the ORDER was the defect: an actor's
       * activation sweep (`orchestrator.ts` — the unrunnable-row DELETE) ran
       * before anything had created the table, so it failed with `no such table`
       * and swept nothing, while a subordinate never observed the table at all.
       * A production-present table was therefore outside the conformance census
       * on one root and invisible on the other.
       *
       * Only the schedules table is mirrored, because the schedule registry is
       * what this stand-in implements and what the timer chain reads. The SDK's
       * other internal tables (`cf_agents_state`, `cf_agents_queues`,
       * `cf_agents_mcp_servers`) have no reader here, and manifesting an
       * observation nothing exercises would be worse than not observing it.
       */
      protected _ensureSchema(): void {
        this.ctx?.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_schedules (
          id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
          callback TEXT,
          payload TEXT,
          type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron', 'interval')),
          time INTEGER,
          delayInSeconds INTEGER,
          cron TEXT,
          intervalSeconds INTEGER,
          running INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch()),
          execution_started_at INTEGER,
          retry_options TEXT,
          owner_path TEXT,
          owner_path_key TEXT
        )`);
      }

      /** The SDK's DO heartbeat. Production uses it for work that outlives the
       *  call that started it (the drain timer, the genesis turn), so the stand-in
       *  runs the body — without it those paths throw here and are untestable. */
      async keepAliveWhile<Result>(fn: () => Promise<Result>): Promise<Result> {
        return fn();
      }

      /**
       * `cf_agents_schedules` — the SDK's schedule registry, copied rather than
       * approximated, for the same reason the sub-agent registry below is: in
       * the real SDK it is pure SQL over the DO's own storage, and the timer
       * chain is decided by WHICH ROWS EXIST. A test about the chain that ran
       * against a stand-in registry would prove things about the stand-in.
       *
       * The ALARM is not faked here and cannot be: workerd owns it, and
       * `tests/workerd/do-alarm.test.ts` fires a real one. What this covers is
       * the row bookkeeping around it.
       */
      async schedule(when: Date, callback: string, payload?: JsonValue): Promise<{
        id: string; callback: string; payload: JsonValue; type: string; time: number;
      }> {
        const row = {
          id: `sched-${String(++harnessScheduleSeq)}`,
          callback,
          payload: payload ?? null,
          type: 'scheduled',
          time: Math.floor(when.getTime() / 1000),
        };
        this.#scheduleTable().exec(
          `INSERT INTO cf_agents_schedules (id, callback, payload, type, time)
           VALUES (?, ?, ?, ?, ?)`,
          row.id, row.callback, JSON.stringify(row.payload), row.type, row.time,
        );
        return row;
      }

      async listSchedules(): Promise<Array<v.InferOutput<typeof SCHEDULE_ROW_SCHEMA>>> {
        return this.#scheduleTable()
          .exec(`SELECT id, callback, type, time FROM cf_agents_schedules ORDER BY time`)
          .toArray()
          .map((row) => v.parse(SCHEDULE_ROW_SCHEMA, row));
      }

      async cancelSchedule(id: string): Promise<boolean> {
        return this.#scheduleTable()
          .exec(`DELETE FROM cf_agents_schedules WHERE id = ? RETURNING id`, id)
          .toArray().length > 0;
      }

      /** The storage the registry lives in. The table itself is created by
       *  `_ensureSchema` at construction, exactly as the vendor does it, so a
       *  schedule call cannot be the thing that brings it into existence. */
      #scheduleTable(): SqlStorage {
        const sql = this.ctx?.storage.sql;
        if (!sql) throw new Error('harness Agent: schedules need a ctx');
        return sql;
      }

      /** The vendor base's tracing seam: every startup and submission-drain
       *  bracket goes through it, so a stand-in without it fails every drain.
       *  There is no tracer here — the span is the body — but `run` still gets
       *  an attribute-writer, because think stamps turn outcomes through it. */
      _withAgentSpan<Result>(
        _operation: string,
        _storagePhase: string,
        _attributes: Record<string, string | number | boolean>,
        run: (update: (patch: Record<string, string | number | boolean>) => void) => Promise<Result>,
      ): Promise<Result> {
        return run(() => {});
      }

      /** The vendor base's observability emit; think brackets submissions and
       *  rpc with it, so a stand-in without it fails every durable submission.
       *  There is no observability sink here — the event is dropped, exactly
       *  as the vendor's own no-sink path drops one. */
      _emit(_type: string, _payload: Record<string, string | number | boolean> = {}): void {}

      /** The recovery hook. The vendor's base declares none and a subclass
       *  overrides it as a prototype method — so this stand-in declares a
       *  METHOD, not an optional field: an instance-field declaration would
       *  shadow the subclass's prototype method with `undefined` under class-
       *  field semantics, and recovery would find no hook at all. */
      async onFiberRecovered(_ctx: FiberRecoveryContext): Promise<FiberRecoveryOutcome> {
        return undefined;
      }

      /**
       * The durable-fiber lifecycle, reproduced rather than faked — the same
       * decision the sub-agent registry below records, and for the same reason:
       * the recovery contract IS the SQL, so a stand-in that only pretended to
       * hold a row could not tell a released row from a retained one, which is
       * the whole difference between recovery that converges and recovery that
       * re-enters until an age bound discards it.
       *
       * Copied from `agents/dist/index.js`: the `cf_agents_runs` DDL at 663, the
       * insert at 2899, the snapshot update at 2917, the delete-in-finally at
       * 2979, and the interrupted-fiber scan at 3022 including its deletion rule
       * — a row is released when the hook RETURNS and retained when it THROWS.
       *
       * What cannot exist here is the facet half (`_cf_registerFacetRun` needs
       * `ctx.facets`) and `keepAlive`'s alarm, which has no clock outside
       * workerd. Neither is observable from the recovery contract: the row is.
       */
      async runFiber<Result>(
        name: string,
        fn: (ctx: { id: string; signal: AbortSignal; stash(data: JsonValue): void; snapshot: JsonValue | null }) => Promise<Result>,
      ): Promise<Result> {
        const sql = this.#fiberTables();
        const id = `fiber-${String(++harnessFiberSeq)}`;
        sql.exec(
          `INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, NULL, ?)`,
          id, name, Date.now(),
        );
        harnessActiveFibers.add(id);
        const body = fn({
          id,
          signal: new AbortController().signal,
          stash: (data: JsonValue) => {
            sql.exec(
              `UPDATE cf_agents_runs SET snapshot = ? WHERE id = ?`,
              JSON.stringify(data), id,
            );
          },
          snapshot: null,
        });
        harnessFiberBodies.add(body);
        try {
          return await body;
        } finally {
          harnessActiveFibers.delete(id);
          harnessFiberBodies.delete(body);
          sql.exec(`DELETE FROM cf_agents_runs WHERE id = ?`, id);
        }
      }
      /**
       * The alarm's housekeeping pass, which is where the interrupted-fiber scan
       * runs when NOTHING is connected: with no request and no socket the
       * persisted keepAlive alarm fires on its own and the SDK reaches
       * `_checkRunFibers` from here (`agents/dist/index.js:3022`, called by
       * `_onAlarmHousekeeping`). Modelled at the PUBLIC entry point so a test
       * drives the path production drives, rather than the private scan or — far
       * worse — the hook itself, which would assert a decision and nothing about
       * the row the decision releases.
       */
      async _onAlarmHousekeeping(): Promise<void> {
        const sql = this.#fiberTables();
        const rows = fiberRows(
          RUN_ROW_SCHEMA, sql, `SELECT id, name, snapshot, created_at FROM cf_agents_runs`,
        );
        for (const row of rows) {
          if (harnessActiveFibers.has(row.id)) continue;
          const managed = fiberRows(
            v.pick(MANAGED_ROW_SCHEMA, ['status']),
            sql, `SELECT status FROM cf_agents_fibers WHERE fiber_id = ?`, row.id,
          )[0];
          if (managed) {
            sql.exec(
              `UPDATE cf_agents_fibers SET status = 'interrupted', snapshot = ?, completed_at = ?
               WHERE fiber_id = ? AND status IN ('pending','running')`,
              row.snapshot, Date.now(), row.id,
            );
          }
          let recovered: boolean;
          let result: FiberRecoveryOutcome;
          try {
            // The base mock declares a no-op hook; the subclass under test
            // overrides it. The harness IS the dispatcher the real
            // `_checkRunFibers` is and has the same reach into `this`.
            result = await this.onFiberRecovered(recoveryContextOf(row, managed !== undefined));
            recovered = true;
          } catch (error) {
            // The retained-row path. The SDK keeps the row so the hook is
            // re-offered on the next activation, bounded only by
            // `fiberRecoveryMaxAgeMs`; nothing here shortens that. Recorded so
            // a retained row says WHY it survived instead of failing silently.
            retainedHookErrors.push({ fiberId: row.id, error });
            recovered = false;
          }
          if (managed && result !== undefined) {
            sql.exec(
              `UPDATE cf_agents_fibers SET status = ?, completed_at = ?
               WHERE fiber_id = ? AND status = 'interrupted'`,
              result.status, Date.now(), row.id,
            );
          }
          if (recovered) sql.exec(`DELETE FROM cf_agents_runs WHERE id = ?`, row.id);
        }
      }
      /** Managed-fiber acceptance. Nothing in production starts one today, so
       *  this exists for the ONE reason its absence would be a lie: `listFibers`
       *  answers "is durably-accepted work still open", and a test that seeds
       *  such work must seed it through the ledger the answer reads. */
      async startFiber(
        name: string,
        fn: (ctx: { id: string; signal: AbortSignal; stash(data: JsonValue): void; snapshot: JsonValue | null }) => Promise<void>,
        options?: { fiberId?: string; idempotencyKey?: string; metadata?: JsonObject },
      ): Promise<{ fiberId: string; name: string; status: string; accepted: boolean; createdAt: number }> {
        const sql = this.#fiberTables();
        const fiberId = options?.fiberId ?? `fiber-${String(++harnessFiberSeq)}`;
        const existing = fiberRows(
          MANAGED_ROW_SCHEMA,
          sql,
          `SELECT fiber_id, name, status, created_at FROM cf_agents_fibers WHERE fiber_id = ?`,
          fiberId,
        )[0];
        if (existing) {
          return {
            fiberId: existing.fiber_id, name: existing.name, status: existing.status,
            createdAt: existing.created_at, accepted: false,
          };
        }
        const now = Date.now();
        sql.exec(
          `INSERT INTO cf_agents_fibers
             (fiber_id, idempotency_key, name, status, snapshot, metadata_json,
              error_message, created_at, started_at, completed_at)
           VALUES (?, ?, ?, 'running', NULL, ?, NULL, ?, ?, NULL)`,
          fiberId, options?.idempotencyKey ?? null, name,
          options?.metadata ? JSON.stringify(options.metadata) : null, now, now,
        );
        void this.runFiber(name, fn)
          .then(() => {
            sql.exec(
              `UPDATE cf_agents_fibers SET status = 'completed', completed_at = ?
               WHERE fiber_id = ? AND status = 'running'`, Date.now(), fiberId,
            );
          })
          .catch(() => {
            sql.exec(
              `UPDATE cf_agents_fibers SET status = 'error', completed_at = ?
               WHERE fiber_id = ? AND status = 'running'`, Date.now(), fiberId,
            );
          });
        return { fiberId, name, status: 'running', createdAt: now, accepted: true };
      }
      /** The managed-fiber ledger read `hasSandboxBackgroundWork` asks. */
      async listFibers(options?: { status?: string | string[] }): Promise<HarnessFiber[]> {
        const wanted = options?.status === undefined
          ? null
          : new Set(Array.isArray(options.status) ? options.status : [options.status]);
        return fiberRows(
          MANAGED_ROW_SCHEMA,
          this.#fiberTables(),
          `SELECT fiber_id, name, status, created_at FROM cf_agents_fibers ORDER BY created_at`,
        )
          .filter((row) => wanted === null || wanted.has(row.status))
          .map((row) => ({
            fiberId: row.fiber_id, name: row.name, status: row.status, createdAt: row.created_at,
          }));
      }
      /** Both fiber tables, verbatim from `agents/dist/index.js:663,684`. */
      #fiberTables(): SqlStorage {
        const sql = this.ctx?.storage.sql;
        if (!sql) throw new Error('harness Agent: durable fibers need a ctx');
        sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_runs (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          snapshot TEXT,
          created_at INTEGER NOT NULL
        )`);
        sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_fibers (
          fiber_id TEXT PRIMARY KEY,
          idempotency_key TEXT UNIQUE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          snapshot TEXT,
          metadata_json TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        )`);
        return sql;
      }
      /** WebSocket fan-out to connected clients. Think's own `broadcast`
       *  override delegates here, so a stand-in without it turns every
       *  broadcasting path — signal cards, roster updates — into a TypeError;
       *  with no connections the real one is a no-op, which is what this is. A
       *  test that observes broadcasts overrides it on the instance
       *  (unit-mcts-broadcast.test.ts). */
      broadcast(_message: string | ArrayBuffer | ArrayBufferView, _without?: string[]): void {}
      /** The sub-agent registry, reproduced rather than faked. `subAgent` and
       *  `hasSubAgent` are the pair the parent facet gate is built on, and in
       *  the real SDK the registry half of both is pure SQL over the DO's own
       *  storage (`agents/dist/index.js`: the table at 5803, the row
       *  `_cf_resolveSubAgent` writes at 5737, the count `hasSubAgent` reads
       *  at 5870). A gate that admits a registered child is only meaningful
       *  against the registry the SDK actually keeps, so that SQL is copied
       *  rather than approximated.
       *
       *  What genuinely cannot exist here is the facet: `ctx.facets` and
       *  `ctx.exports` are workerd-only, and the real `subAgent` refuses
       *  without them. So the stub returned here throws on every call —
       *  registration is the observable half, and it is the half the gate
       *  reads. */
      async subAgent(cls: { name: string }, name: string): Promise<object> {
        this.#subAgentRegistry().exec(
          `INSERT OR IGNORE INTO cf_agents_sub_agents (class, name, created_at) VALUES (?, ?, ?)`,
          cls.name, name, Date.now(),
        );
        return new Proxy({}, {
          get: (_target, prop) => {
            if (prop === 'then') return undefined;
            return async () => {
              throw new Error(`harness subAgent: ${cls.name} "${name}".${String(prop)} needs a facet, which is workerd-only`);
            };
          },
        });
      }
      listSubAgents(cls: { name: string }): Array<{ className: string; name: string; createdAt: number }> {
        return this.#subAgentRegistry().exec(
          `SELECT class, name, created_at FROM cf_agents_sub_agents
           WHERE class = ? ORDER BY created_at, name`,
          cls.name,
        ).toArray().map((row) => ({
          className: String(row.class),
          name: String(row.name),
          createdAt: Number(row.created_at),
        }));
      }
      /** The SDK declares a second overload taking the class, and reduces it
       *  to `cls.name` (:5868); the registry key is the class NAME either way.
       *  Only the name form is modelled, because that is the form the code
       *  under test uses (`actor-agent.ts` passes `child.className`). A
       *  class-form call added later would miss every row and turn the facet
       *  gate red rather than pass quietly. */
      hasSubAgent(className: string, name: string): boolean {
        const rows = this.#subAgentRegistry().exec(
          `SELECT COUNT(*) AS n FROM cf_agents_sub_agents WHERE class = ? AND name = ?`,
          className, name,
        ).toArray();
        return Number(rows[0]?.n ?? 0) > 0;
      }
      #subAgentRegistry(): SqlStorage {
        const sql = this.ctx?.storage.sql;
        if (!sql) throw new Error('harness Agent: the sub-agent registry needs a ctx');
        sql.exec(`CREATE TABLE IF NOT EXISTS cf_agents_sub_agents (
          class TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          identity_version TEXT,
          identity_name TEXT,
          PRIMARY KEY (class, name)
        )`);
        return sql;
      }
      /** Ancestor chain + self, root-first. Copied from the SDK's own getter
       *  (`agents/dist/index.js:4205`: `[...this._parentPath, { className:
       *  this.constructor.name, name: this.name }]`) rather than approximated,
       *  because the tracing seam renders it into every span's
       *  `kinu.self_path` and it is the ONLY discriminator that exists — a
       *  facet's `ctx.id` reports under its root's `durableObjectId`. A
       *  stand-in that answered `[]` would make every span read `root`, which
       *  is the one value that cannot occur in production. Top-level here, so
       *  `_parentPath` is empty. */
      get selfPath(): ReadonlyArray<{ className: string; name: string }> {
        return [{ className: this.constructor.name, name: String(this.name) }];
      }
      /** Present for the same reason `selfPath` is: the SDK exposes it, and a
       *  missing member is an `undefined` at use rather than a load error. */
      get parentPath(): ReadonlyArray<{ className: string; name: string }> {
        return [];
      }
      readonly name: string = '';
    },
    /** The real decorator only attaches RPC metadata. */
    callable: () => <Method>(method: Method): Method => method,
    // Named imports @cloudflare/think binds at module load. bun resolves the
    // whole import list eagerly, so a missing name is a load-time SyntaxError
    // for any test that reaches an ActorAgent subclass.
    getCurrentAgent: () => ({ agent: undefined, connection: undefined, request: undefined }),
    __DO_NOT_USE_WILL_BREAK__agentContext: {
      getStore: <Store>(): Store | undefined => undefined,
      run: <Store, Result>(_store: Store, fn: () => Result): Result => fn(),
    },
    // The vendor's signature is (body, options) — think passes the turn body
    // FIRST, so a stale (scope, fn) mock calls the body object as a function.
    __DO_NOT_USE_WILL_BREAK__withInvocationScope: <Result>(body: () => Result): Result => body(),
    isDurableObjectMemoryLimitReset: () => false,
    isPlatformTransientError: () => false,
    getAgentByName: async (namespace: DurableObjectNamespace, name: string) =>
      namespace.get(namespace.idFromName(name)),
    /** The Worker entry's transport for `/agents/*`. Returning undefined is the
     *  SDK's "not my path" answer, which drops the request to the SPA fallback. */
    routeAgentRequest: async (): Promise<Response | undefined> => undefined,
  }));
  // UserDO imports these at module load; the real ones reach `cloudflare:*`.
  // The double records the manager's WRITABLE state — its server rows and its
  // live connections — because that state is a second truth beside
  // `user_mcp_servers`, and the reconciliation and credential-seam contracts are
  // statements about it (see `recordedMcpServers`).
  registerSynchronousMock('agents/mcp/client', () => ({ MCPClientManager: FakeMCPClientManager }));
  registerSynchronousMock('agents/mcp/do-oauth-client-provider', () => ({
    DurableObjectOAuthClientProvider: class { serverId = ''; },
  }));
  // The DO layer reaches the runtime + codemode module graph (a head builds a
  // CF runtime and an execute_tools tool), both of which import this
  // workerd-only module at load. So does `@cloudflare/sandbox`, and its import
  // list grew in 0.12.0: it now names `tracing` as well as `RpcTarget`, and an
  // ES named import that the mock does not provide is a SyntaxError at module
  // load, not an undefined at use — which is why omitting one takes out every
  // suite whose graph reaches the SDK rather than just the code that calls it.
  // `enterSpan(name, fn)` is what the SDK invokes, and it hands `fn` a span it
  // stamps attributes on. The stub runs the body and accepts the attributes, so
  // the traced path is the one under test — the SDK also has a no-tracer
  // fallback, and a mock that triggered it would leave that path unexercised.
  //
  // The stub RECORDS, and that placement is the point: `tracing.enterSpan` is the
  // platform boundary, so everything above it — `createWorkersTracer`,
  // `createAgentTracing`, the call sites — is production code running unmodified.
  // A test that substituted our own `Tracer` would be asserting about the
  // substitute. Nesting comes from the call stack, with a span held open until an
  // async body SETTLES, exactly as workerd holds it, so the recorded `parent` is
  // the one the runtime would nest under.
  registerSynchronousMock('cloudflare:workers', () => ({
    RpcTarget: class {},
    WorkerEntrypoint: class {},
    WorkflowEntrypoint: class {},
    WorkflowEvent: class {},
    DurableObject: class {},
    exports: {},
    // Reading platform env under bun is a test reaching for state that does
    // not exist here; failing by name beats an undefined that reads as
    // "unbound". Platform bindings are exercised in tests/workerd under
    // vitest.
    env: new Proxy({}, {
      get(_target, property) {
        throw new Error(
          `cloudflare:workers env.${String(property)} does not exist under bun test`,
        );
      },
    }),
    tracing: {
      enterSpan: <T>(name: string, fn: (span: NativeSpanStub) => T): T => {
        const index = nativeSpans.length;
        const attributes = new Map<string, string | number | boolean>();
        nativeSpans.push({ name, parent: openSpans.at(-1) ?? null, attributes });
        openSpans.push(index);
        const close = (): void => {
          const top = openSpans.lastIndexOf(index);
          if (top >= 0) openSpans.splice(top, 1);
        };
        let closesLater = false;
        try {
          const result = fn({
            isTraced: true,
            setAttribute: (key: string, value: string | number | boolean) => { attributes.set(key, value); },
          });
          if (result instanceof Promise) {
            closesLater = true;
            // `then(ok, err)` and not `finally`: `finally` derives a promise that
            // rejects whenever `result` does, and nothing awaits this one — an
            // unhandled rejection from inside the stub, which surfaced the moment
            // a traced production path first rejected (unit-head-fork). Both arms
            // settle it; `result` still rejects for the test that awaits it.
            void result.then(close, close);
          }
          return result;
        } finally {
          if (!closesLater) close();
        }
      },
      /**
       * The Agents SDK's own entry point (`RuntimeTracer.activate`). Records
       * into the same span log as `enterSpan`, so a test reads ONE trace
       * regardless of which native API opened a span. The writer's `end()` is
       * caller-owned, exactly as the platform's is; a body that never ends its
       * span leaves it open, which is what a nesting assertion should see.
       */
      startActiveSpan: <T>(
        name: string,
        fn: (span: NativeSpanStub & { end(): void }) => T,
      ): T => {
        const index = nativeSpans.length;
        const attributes = new Map<string, string | number | boolean>();
        nativeSpans.push({ name, parent: openSpans.at(-1) ?? null, attributes });
        openSpans.push(index);
        const close = (): void => {
          const top = openSpans.lastIndexOf(index);
          if (top >= 0) openSpans.splice(top, 1);
        };
        return fn({
          isTraced: true,
          setAttribute: (key: string, value: string | number | boolean) => { attributes.set(key, value); },
          end: close,
        });
      },
    },
  }));
}

interface NativeSpanStub {
  readonly isTraced: boolean;
  setAttribute(key: string, value: string | number | boolean): void;
}

/** One span the platform stub was asked to open. */
export interface NativeSpanRecord {
  readonly name: string;
  /** Index in `nativeSpans` of the span this opened inside, or null at a root. */
  readonly parent: number | null;
  readonly attributes: ReadonlyMap<string, string | number | boolean>;
}

const nativeSpans: NativeSpanRecord[] = [];
const openSpans: number[] = [];

/** Spans opened since the last `resetNativeSpans`, in open order. An EMPTY array
 *  is the shape of instrumentation that was never reached, which is the defect a
 *  tracing test exists to catch — so assert a non-zero length before anything
 *  else. */
export function recordedNativeSpans(): readonly NativeSpanRecord[] {
  return nativeSpans;
}

export function resetNativeSpans(): void {
  nativeSpans.length = 0;
  openSpans.length = 0;
}

/** The recorded spans as an indented tree, parents before children. What a
 *  reader actually needs from a trace, and what a flat list of names cannot
 *  show. */
export function renderNativeSpanTree(): string {
  const lines: string[] = [];
  const walk = (parent: number | null, depth: number): void => {
    nativeSpans.forEach((span, index) => {
      if (span.parent !== parent) return;
      const shown = [...span.attributes]
        .filter(([key]) => key !== 'kinu.self_path')
        .map(([key, value]) => `${key.replace('kinu.', '')}=${String(value)}`)
        .join(' ');
      lines.push(`${'  '.repeat(depth)}${span.name}${shown === '' ? '' : `  [${shown}]`}`);
      walk(index, depth + 1);
    });
  };
  walk(null, 0);
  return lines.join('\n');
}

/**
 * The transport option bag `registerServer` is handed, NAMED.
 *
 * The SDK accepts whatever it is given, so this was a `Record<string, unknown>`
 * and every caller that wanted to read `fetch` asserted a signature it had not
 * established. Naming it costs nothing and buys the two facts every test here
 * asks about: the credential arrives as a CLOSURE (`fetch`, the one option the
 * SDK's persistence whitelist does not keep), and the credential never arrives
 * as DATA (`headers` / `requestInit`, which it does keep). `fetch` reuses the
 * production contract rather than restating it.
 *
 * The remaining fields are the rest of `persistTransportOptions`' whitelist
 * (agents/dist/client-zqKcsyFa.js:1022-1035); the mock inspects none of them,
 * they exist so a test can assert what a row WOULD persist.
 */
export interface RecordedMcpTransport {
  fetch?: McpCredentialTransport['fetch'];
  type?: string;
  headers?: Record<string, string>;
  requestInit?: RequestInit;
  authProvider?: { authUrl?: string | null; clientId?: string | null; serverId?: string };
  reconnectionOptions?: { maxRetries?: number };
  skipIssuerMetadataValidation?: boolean;
  onInsufficientScope?: () => void;
  maxStepUpRetries?: number;
  sessionId?: string;
  protocolVersion?: string;
}

/** A row of the SDK's own `cf_agents_mcp_servers` table — the state that is
 *  DERIVED from `user_mcp_servers` and must never disagree with it. */
export interface RecordedMcpServer {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly callbackUrl: string;
  readonly clientId: string | null;
  readonly authUrl: string | null;
  /** Exactly what was handed to `registerServer`. A test that asks what the real
   *  SDK would PERSIST applies its whitelist to this. */
  readonly transport: RecordedMcpTransport;
}

interface RecordedMcpConnection {
  connectionState: string;
  connectionError: string | null;
  tools: { name: string; description?: string; title?: string; inputSchema: unknown }[];
  options: { transport: RecordedMcpTransport };
}

/** What the manager was asked to do, and how often. `established` /
 *  `discovered` are server ids; `restored` / `waited` are call counts, which is
 *  what proves a read did NOT touch the connection machinery. */
export interface RecordedMcpLifecycle {
  established: readonly string[];
  discovered: readonly string[];
  restored: number;
  waited: number;
}

const mcpServers = new Map<string, RecordedMcpServer>();
const mcpEstablished: string[] = [];
const mcpDiscovered: string[] = [];
/** The failure the next `callTool` throws. An `Error`, because that is what the
 *  SDK's transports raise and what the classification under test reads. */
let mcpCallToolFailure: Error | null = null;

/** The failure the next `removeServer` throws, exercising the credential-seam
 * teardown boundary rather than letting a test model it as a successful remove. */
let mcpRemoveFailure: Error | null = null;
let liveMcpManager: { mcpConnections: Record<string, RecordedMcpConnection> } | null = null;
let mcpRestored = 0;
let mcpWaited = 0;
/** Set while establishment is gated: `establishConnection` blocks on it. */
let mcpEstablishGate: Promise<void> | null = null;
/** Called the first time a caller reaches the gate — the arrival signal
 *  `hangMcpEstablish` hands back, so a test awaits the real event. */
let mcpEstablishArrived: (() => void) | null = null;

/** Remember the manager an activation just built, so a test can ask what it
 *  holds. Its own function because the alternative is `this` leaving a
 *  constructor through an assignment. */
function rememberMcpManager(manager: { mcpConnections: Record<string, RecordedMcpConnection> }): void {
  liveMcpManager = manager;
}

/** The manager's server rows, in registration order. */
export function recordedMcpServers(): readonly RecordedMcpServer[] {
  return [...mcpServers.values()];
}

/** The credential CLOSURE on a transport, or null when the seam is absent —
 *  which is the other fact these tests ask about. Typed by the production
 *  contract, so nothing here narrows or asserts. */
function credentialClosure(
  transport: RecordedMcpTransport | undefined,
): McpCredentialTransport['fetch'] | null {
  return transport?.fetch ?? null;
}

/** The closure `registerServer` was HANDED for this server. */
export function recordedMcpFetch(id: string): McpCredentialTransport['fetch'] | null {
  return credentialClosure(mcpServers.get(id)?.transport);
}

/** The closure the LIVE connection is running on — a different question from
 *  what the row was handed, and the cold-start ordering invariant. */
export function liveMcpFetch(id: string): McpCredentialTransport['fetch'] | null {
  return credentialClosure(liveMcpManager?.mcpConnections[id]?.options.transport);
}

export function recordedMcpLifecycle(): RecordedMcpLifecycle {
  return { established: mcpEstablished, discovered: mcpDiscovered, restored: mcpRestored, waited: mcpWaited };
}

/** A gate held over `establishConnection`: `entered` settles when a caller
 *  reaches it, `release` lets that caller through. */
export interface McpEstablishGate {
  entered: Promise<void>;
  release: () => void;
}

/**
 * Block every `establishConnection` until `release` is called — a third party
 * that accepts the socket and never finishes. The real one awaits
 * `_connectWithRetry` with no bound here (`client-zqKcsyFa.js:2046,2073`).
 *
 * `entered` settles when a caller ACTUALLY reaches the gate. A test needs that
 * signal rather than a delay: the lane opens a sealed header before it gets
 * here, so a check taken synchronously after dispatch observes it before it has
 * begun and would read "not yet started" as "never started" — which turns a
 * gate assertion vacuous instead of merely early. Awaiting the arrival is
 * awaiting the real event.
 */
export function hangMcpEstablish(): McpEstablishGate {
  const gate = Promise.withResolvers<void>();
  const arrival = Promise.withResolvers<void>();
  mcpEstablishGate = gate.promise;
  mcpEstablishArrived = () => { arrival.resolve(); };
  return { entered: arrival.promise, release: () => { gate.resolve(); } };
}

/** Make the next `callTool` fail, the way a server whose session stopped being
 *  authorized does. An `Error` because every failure this seam classifies is
 *  one — the SDK's transports raise `StreamableHTTPError`, `SseError` and
 *  `UnauthorizedError`, all of them `Error` subclasses. */
export function failNextMcpToolCall(error: Error): void {
  mcpCallToolFailure = error;
}

/** Make the next SDK-server teardown fail. */
export function failNextMcpRemove(error: Error): void {
  mcpRemoveFailure = error;
}

/** Seed an SDK server row directly — the manager's own storage as some earlier
 *  activation left it. With no config row behind it that is an ORPHAN (what a
 *  failed rollback or a dropped name twin leaves); with `transport` it is
 *  whatever a previous build persisted there. */
export function seedSdkMcpServer(id: string, transport: RecordedMcpTransport = {}): void {
  mcpServers.set(id, {
    id, name: id, url: `https://${id}.example/sse`,
    callbackUrl: '', clientId: null, authUrl: null, transport,
  });
}

/** Remove the live credential closure, the state a cold activation presents
 * before hydration re-registers a credentialed row. Test-only because the
 * production seam creates this state through activation eviction. */
export function dropLiveMcpFetch(id: string): void {
  delete liveMcpManager?.mcpConnections[id]?.options.transport.fetch;
}

/** The transport options the LIVE connection is running on, which is a
 *  different question from what the row persisted. */
export function liveMcpTransport(id: string): RecordedMcpTransport | undefined {
  return liveMcpManager?.mcpConnections[id]?.options.transport;
}

/** Give a configured server a live connection with tools, the way discovery
 *  does. Reaches the manager UserDO built, which is private to it — the state
 *  under test is what the manager holds, not who holds a reference. */
export function seedMcpTools(id: string, tools: RecordedMcpConnection['tools']): void {
  const manager = liveMcpManager;
  if (!manager) throw new Error('No MCP manager has been constructed yet.');
  manager.mcpConnections[id] ??= {
    connectionState: 'ready', connectionError: null, tools: [], options: { transport: {} },
  };
  const connection = manager.mcpConnections[id];
  connection.connectionState = 'ready';
  connection.tools = tools;
}

export function resetRecordedMcp(): void {
  mcpServers.clear();
  mcpEstablished.length = 0;
  mcpDiscovered.length = 0;
  mcpCallToolFailure = null;

  mcpRemoveFailure = null;
  liveMcpManager = null;
  mcpRestored = 0;
  mcpWaited = 0;
  mcpEstablishGate = null;
  mcpEstablishArrived = null;
}

/**
 * The MCP client manager, faithful in the four respects the per-user plane's
 * contracts are about:
 *
 *  - `registerServer` records what it was handed and does NOT connect, leaving
 *    the connection in `connecting` exactly as the real one does
 *    (`client-zqKcsyFa.js:478`) — which is what makes the restore skip it.
 *  - `createConnection`'s reuse rule: registering over a live connection leaves
 *    that connection's transport untouched (`:1719-1720`).
 *  - `restoreConnectionsFromStorage` connects only rows with no connection yet.
 *  - `removeServer` drops the row AND the connection (`:2299-2305`).
 */
class FakeMCPClientManager {
  mcpConnections: Record<string, RecordedMcpConnection> = {};

  constructor() {
    // Handed over as an ARGUMENT rather than aliased into a variable: what the
    // tests need is a way to reach the manager UserDO built, and passing the
    // instance says so without `this` escaping through an assignment.
    rememberMcpManager(this);
  }

  async registerServer(id: string, options: {
    url: string; name: string; callbackUrl?: string; clientId?: string; authUrl?: string;
    transport?: RecordedMcpTransport;
  }): Promise<string> {
    const transport = { ...options.transport };
    mcpServers.set(id, {
      id,
      name: options.name,
      url: options.url,
      callbackUrl: options.callbackUrl ?? '',
      clientId: options.clientId ?? null,
      authUrl: options.authUrl ?? null,
      transport,
    });
    this.mcpConnections[id] ??= {
      connectionState: 'connecting', connectionError: null, tools: [], options: { transport },
    };
    return id;
  }

  listServers(): RecordedMcpServer[] {
    return [...mcpServers.values()];
  }

  async removeServer(id: string): Promise<void> {
    const failure = mcpRemoveFailure;
    if (failure) {
      mcpRemoveFailure = null;
      throw failure;
    }
    delete this.mcpConnections[id];
    mcpServers.delete(id);
  }

  async restoreConnectionsFromStorage(): Promise<void> {
    mcpRestored += 1;
    for (const row of mcpServers.values()) {
      this.mcpConnections[row.id] ??= {
        connectionState: 'ready', connectionError: null, tools: [], options: { transport: row.transport },
      };
    }
  }

  async establishConnection(id: string): Promise<void> {
    mcpEstablished.push(id);
    // The real one awaits `_connectWithRetry` with no bound, so a gated server
    // holds its caller here for as long as the test wants.
    if (mcpEstablishGate) {
      mcpEstablishArrived?.();
      await mcpEstablishGate;
    }
    const connection = this.mcpConnections[id];
    if (connection) connection.connectionState = 'ready';
  }

  async waitForConnections(): Promise<void> {
    mcpWaited += 1;
  }

  async discoverIfConnected(id: string): Promise<void> {
    mcpDiscovered.push(id);
  }

  /** The SDK's `CallToolResult`, as much of it as this mock produces: an empty
   *  content list, or the seeded failure. `content` blocks are the SDK's
   *  discriminated `{ type, text? }` shape rather than `unknown`, so a caller
   *  reading a result gets a contract. */
  async callTool(): Promise<{ content: { type: string; text?: string }[] }> {
    const failure = mcpCallToolFailure;
    if (failure !== null) {
      mcpCallToolFailure = null;
      throw failure;
    }
    return { content: [] };
  }
}
