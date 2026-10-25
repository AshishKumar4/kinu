import * as workersModule from 'cloudflare:workers';
import type { CodemodeLauncher, CodemodeLauncherProps } from '../../src/codemode-sandbox';
import { mock } from 'bun:test';
import * as v from 'valibot';
import type { AgentContext, Connection, ConnectionContext, FiberRecoveryContext, WSMessage } from 'agents';
import { Lifecycle } from 'agents/lifecycle';
import { parseJsonValue, type JsonObject, type JsonValue, type SqlValue } from '@kinu.run/core';

type ModuleMockFactory = Parameters<typeof mock.module>[1];

function registerSynchronousMock(id: string, factory: ModuleMockFactory): void {
  const completion = mock.module(id, factory);

  if (completion !== undefined) {
    throw new Error(`mock.module(${id}) must register synchronously`);
  }
}

/** Fiber ids, monotonic per process so a test can read them in creation order. */
let harnessFiberSeq = 0;

/** Fibers running in this process; the interrupted scan skips them, as `_runFiberActiveFibers` does. */
const harnessActiveFibers = new Set<string>();

/** Live fiber and lane bodies, so a test can join what production detaches on purpose. */
const harnessFiberBodies = new Set<Promise<unknown>>();

/** `cf_agents_runs`, as `agents/dist/index.js:663` declares it. */
interface RunRow {
  id: string;
  name: string;
  snapshot: string | null;
  created_at: number;
}

interface HarnessFiber {
  fiberId: string;
  name: string;
  status: string;
  createdAt: number;
}

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

/** `undefined` is the legacy `void` return the SDK still accepts. */
type FiberRecoveryOutcome = { status: string } | undefined;

function fiberRows<Row extends object>(
  schema: v.GenericSchema<Row>, sql: SqlStorage, query: string, ...bindings: SqlValue[]
): Row[] {
  return sql.exec(query, ...bindings).toArray().map((row) => v.parse(schema, row));
}

/**
 * A wait the suite plants inside code the harness runs (a loaded worker's eval): `globalThis[Symbol.for(HOLD)](name)`
 * never settles, and the harness can name what is held. A reset drops them with the fibers.
 */
const held = new Set<string>();

Object.assign(globalThis, {
  [Symbol.for('kinu.test.hold')]: (name: string) => {
    held.add(name);

    return new Promise<never>(() => {});
  },
});

const declaredCallables = new Set<string>();

/** Every method name a loaded class marks `@callable()`, as its decorator ran; `getCallableMethods` still answers none. */
export const harnessCallables = (): ReadonlySet<string> => declaredCallables;

export function harnessHolds(): readonly string[] {
  return [...held];
}

/** Whether a `runFiber` body started so far is still running. */
/** The connection a call runs under while {@link asPane} holds it. */
let paneConnection: { readonly id: string; readonly tags: readonly string[] } | undefined;

/** Runs `call` as a socket carrying `tags` would: the product reads which pane addressed it. */
export async function asPane<T>(tags: readonly string[], call: () => Promise<T>): Promise<T> {
  return await asConnection({ id: crypto.randomUUID(), tags }, call);
}

async function asConnection<T>(connection: { readonly id: string; readonly tags: readonly string[] }, call: () => Promise<T>): Promise<T> {
  paneConnection = connection;

  try {
    return await call();
  } finally {
    paneConnection = undefined;
  }
}

/** A frame the SDK dispatches as a call (`isRPCRequest`, `agents/dist/src-BZeu-SCD.js:1357`). */
const RpcRequestSchema = v.pipe(v.string(), v.parseJson(), v.looseObject({
  type: v.literal('rpc'), id: v.string(), method: v.string(), args: v.array(v.unknown()),
}));

export function harnessFibersRunning(agent: workersModule.DurableObject): boolean {
  return (harnessFiberBodiesOf.get(agent)?.size ?? 0) > 0;
}

/** Work each object holds open through `keepAliveWhile`, as production keeps it alive for it (a drain debounce, say). */
const harnessKeepAlives = new WeakMap<workersModule.DurableObject, Set<Promise<unknown>>>();

/** Resolves when the work `agent` holds open through `keepAliveWhile` has settled. */
export async function joinHarnessKeepAlives(agent: workersModule.DurableObject): Promise<void> {
  const open = harnessKeepAlives.get(agent);

  while (open !== undefined && open.size > 0) await Promise.allSettled(open);
}

/** A lane's body (`ActorAgent.holdLane`), joined with the fibers, and with `agent`'s own when it names its object. */
export function trackHarnessLane<Result>(lane: Promise<Result>, agent?: workersModule.DurableObject): Promise<Result> {
  harnessFiberBodies.add(lane);
  const own = agent === undefined ? undefined : harnessFiberBodiesOf.get(agent) ?? new Set<Promise<unknown>>();

  if (agent !== undefined && own !== undefined) harnessFiberBodiesOf.set(agent, own.add(lane));

  return lane.finally(() => {
    harnessFiberBodies.delete(lane);
    own?.delete(lane);
  });
}

/** Resolves when every `runFiber` body and lane started so far has settled. */
export async function joinHarnessFibers(): Promise<void> {
  while (harnessFiberBodies.size > 0) await Promise.all(harnessFiberBodies);
}

/** Objects whose fibers no suite-wide join waits on: the workspace's own agent's isolate, whose chat turn runs in a fiber a
 *  suite parks at its model call, as the in-object turn it replaced was no fiber. */
const unjoined = new WeakSet<object>();

export function joinedOnlyByItself(agent: workersModule.DurableObject): void {
  unjoined.add(agent);
}

/** Each object's own `runFiber` bodies: an agent's isolate is an object of its own, its turn's fiber among them. */
const harnessFiberBodiesOf = new WeakMap<object, Set<Promise<unknown>>>();

/** Resolves when every `runFiber` body `agent` itself started so far has settled. */
export async function joinHarnessFibersOf(agent: workersModule.DurableObject): Promise<void> {
  const bodies = harnessFiberBodiesOf.get(agent);

  while (bodies !== undefined && bodies.size > 0) await Promise.all(bodies);
}

/**
 * The isolate a reset kills, for the fibers it was running: their bodies never settle and their rows stay, so the next
 * activation's scan finds them interrupted and no join waits on them. A suite whose reset ends an activation with a
 * run still parked calls this before it builds the next activation.
 */
export function abandonHarnessFibers(): void {
  harnessFiberBodies.clear();
  held.clear();
  harnessActiveFibers.clear();
}

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

/** Hook throws the interrupted scan retained rows for, in scan order. */
const retainedHookErrors: { fiberId: string; error: unknown }[] = [];

/** Retained-row hook failures since process start, for a retention assertion. */
export function recordedRetainedHookErrors(): readonly { fiberId: string; error: unknown }[] {
  return retainedHookErrors;
}

/** Sub-agent facets are workerd-only, so every property throws naming the lookup. */
function facetOnlyStub(lookup: string, cls: { name: string }, name: string) {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;

      return async () => {
        throw new Error(`harness ${lookup}: ${cls.name} "${name}".${String(prop)} needs a facet, which is workerd-only`);
      };
    },
  });
}

/** Marks the stub's Agent: a class built on the real `agents` runs fibers no harness join can see. */
export const HARNESS_AGENT = Symbol('kinu.test.harness-agent');

/**
 * Stub the Agent SDK: the real `agents` dist imports workerd-only `cloudflare:*` modules.
 * bun keeps one mock per specifier (first registration wins); call before importing the module under test.
 */
export function mockAgentsSdk(): void {
  registerSynchronousMock('agents', () => ({
    /** Also the real base for DO classes a test instantiates directly (UserDO), hence the ctx/env assignment. */
    Agent: class extends workersModule.DurableObject<Env> {
      readonly [HARNESS_AGENT] = true;
      #lifecycle: Lifecycle | undefined;
      /** The SDK's own Lifecycle: capability services, the start and the job queue are not approximated. */
      get lifecycle(): Lifecycle {
        this.#lifecycle ??= new Lifecycle(this);

        return this.#lifecycle;
      }
      /** The SDK base's default: nothing to start. */
      onStart(): void | Promise<void> {}
      /** Drives due jobs as `Agent.alarm()` does; the platform alarm is workerd's (`tests/workerd/do-alarm.test.ts`). */
      async alarm(): Promise<void> {
        await this.lifecycle.alarm();
      }
      /** `callable` below records nothing, so no method reads as callable. */
      getCallableMethods(): Map<string, object> {
        return new Map();
      }
      constructor(ctx: AgentContext, env: Env) {
        super(ctx, env);
        Object.defineProperty(this, 'name', {
          configurable: true,
          value: ctx.id.name ?? ctx.id.toString(),
        });
        // The SDK's constructor creates its fiber tables (`_ensureSchema`); the actor's sweep relies on it.
        this.#fiberTables();
      }
      /** A prototype method, as the vendor's is (`agents/dist/src-5W6JNKVb.js:574`), so a subclass override runs. */
      sql(strings: TemplateStringsArray, ...values: SqlValue[]) {
        if (!this.ctx) throw new Error('harness Agent: sql needs a ctx');

        const query = strings.reduce(
          (text, part, index) => text + part + (index < values.length ? '?' : ''),
          '',
        );

        return this.ctx.storage.sql.exec(query, ...values).toArray();
      }
      onConnect(_connection: Connection, _ctx: ConnectionContext): void {}
      /** The SDK's dispatch of a call frame (`agents/dist/src-BZeu-SCD.js:2022`): a `@callable` method runs as that
       *  socket's call and answers on it. Streaming methods are not served; any other frame is dropped, as the SDK's own
       *  handler drops it. */
      async onMessage(connection: Connection, message: WSMessage): Promise<void> {
        const frame = v.safeParse(RpcRequestSchema, message);

        if (!frame.success) return;
        const rpc = frame.output;

        try {
          // `this[method]`, as the SDK reads it: the class's own, up its prototype chain.
          const chain: object[] = [];

          for (let owner: object | null = Object.getPrototypeOf(this); owner !== null; owner = Object.getPrototypeOf(owner)) chain.push(owner);
          const method = chain.map((owner) => v.safeParse(v.function(), Object.getOwnPropertyDescriptor(owner, rpc.method)?.value)).find((found) => found.success);

          if (method?.success !== true) throw new Error(`Method ${rpc.method} does not exist`);

          if (!declaredCallables.has(rpc.method)) throw new Error(`Method ${rpc.method} is not callable`);

          connection.send(await asConnection(connection, async () => JSON.stringify({
            done: true, id: rpc.id, result: await method.output.apply(this, rpc.args), success: true, type: 'rpc',
          })));
        } catch (error) {
          connection.send(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred', id: rpc.id, success: false, type: 'rpc' }));
        }
      }
      onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean): void {}
      onRequest(_request: Request): Response {
        return new Response('Not implemented', { status: 404 });
      }

      /** Runs the body, held open for {@link joinHarnessKeepAlives}: production uses it for work that outlives its call. */
      async keepAliveWhile<Result>(fn: () => Promise<Result>): Promise<Result> {
        const work = fn();
        const open = harnessKeepAlives.get(this) ?? new Set<Promise<unknown>>();
        harnessKeepAlives.set(this, open);
        open.add(work);

        try {
          return await work;
        } finally {
          open.delete(work);
        }
      }

      /** A method, not an optional field: a field would shadow the subclass's prototype hook with `undefined`. */
      async onFiberRecovered(_ctx: FiberRecoveryContext): Promise<FiberRecoveryOutcome> {
        return undefined;
      }

      /**
       * Copied from `agents/dist/index.js` (DDL 663, insert 2899, stash 2917, delete-in-finally 2979,
       * interrupted scan 3022): a row is released when the hook returns, retained when it throws.
       */
      async runFiber<Result>(
        name: string,
        fn: (ctx: { id: string; signal: AbortSignal; stash(data: JsonValue): void; snapshot: JsonValue | null }) => Promise<Result>,
      ): Promise<Result> {
        return await this._runFiberWithStashWrapper(name, fn, {});
      }

      /** `initialSnapshot` lands in the same synchronous prefix as the row insert, so no interruption
       *  finds a recoverable lane with a null payload. */
      async _runFiberWithStashWrapper<Result>(
        name: string,
        fn: (ctx: { id: string; signal: AbortSignal; stash(data: JsonValue): void; snapshot: JsonValue | null }) => Promise<Result>,
        options: { initialSnapshot?: JsonValue },
      ): Promise<Result> {
        const sql = this.#fiberTables();
        const id = `fiber-${String(++harnessFiberSeq)}`;
        sql.exec(
          `INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)`,
          id, name,
          options.initialSnapshot === undefined ? null : JSON.stringify(options.initialSnapshot),
          Date.now(),
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

        if (!unjoined.has(this)) harnessFiberBodies.add(body);
        const own = harnessFiberBodiesOf.get(this) ?? new Set<Promise<unknown>>();

        harnessFiberBodiesOf.set(this, own.add(body));

        try {
          return await body;
        } finally {
          harnessActiveFibers.delete(id);
          harnessFiberBodies.delete(body);
          own.delete(body);
          sql.exec(`DELETE FROM cf_agents_runs WHERE id = ?`, id);
        }
      }
      /** The public entry that runs `_checkRunFibers` (`agents/dist/index.js:3022`) when nothing is
       *  connected; tests drive it rather than the private scan or the hook. */
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
            result = await this.onFiberRecovered(recoveryContextOf(row, managed !== undefined));
            recovered = true;
          } catch (error) {
            // The SDK keeps the row so the hook is re-offered next activation,
            // bounded only by `fiberRecoveryMaxAgeMs`.
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
      /** Managed-fiber acceptance: a test seeding open work must seed the ledger `listFibers` reads. */
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
      /** The managed-fiber ledger. */
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
      /** Think's `broadcast` delegates here; with no connections the real one is a no-op.
       *  Tests observing broadcasts override it on the instance (unit-mcts-broadcast.test.ts). */
      broadcast(_message: string | ArrayBuffer | ArrayBufferView, _without?: string[]): void {}
      /** Empty: workerd owns hibernating sockets (real one: `agents/dist/src-5W6JNKVb.js:3175`).
       *  Recipient-set behaviour is measured in `tests/workerd/wide/public-surface.test.ts`. */
      *getConnections(_tag?: string): Iterable<Connection> {}
      /** Registry SQL copied from `agents/dist/index.js` (table 5803, `_cf_resolveSubAgent` 5737,
       *  `hasSubAgent` 5870); the facet (`ctx.facets`) is workerd-only, so the stub throws. */
      async subAgent(cls: { name: string }, name: string): Promise<object> {
        this.#subAgentRegistry().exec(
          `INSERT OR IGNORE INTO cf_agents_sub_agents (class, name, created_at) VALUES (?, ?, ?)`,
          cls.name, name, Date.now(),
        );

        return facetOnlyStub('subAgent', cls, name);
      }
      listSubAgents(cls: { name: string }): Array<{ className: string; name: string; createdAt: number }> {
        return this.#subAgentRegistry().exec(
          `SELECT class, name, created_at FROM cf_agents_sub_agents
           WHERE class = ? ORDER BY created_at, name`,
          cls.name,
        ).toArray().map((row) => ({
          className: v.parse(v.string(), row.class),
          name: v.parse(v.string(), row.name),
          createdAt: Number(row.created_at),
        }));
      }
      /** Only `_forgetSubAgent` of the real `deleteSubAgent` is observable here: a facet whose row is
       *  gone no longer occupies the root's quota. Idempotent, as the SDK's is. */
      async deleteSubAgent(cls: { name: string }, name: string): Promise<void> {
        await Promise.resolve();
        this.#subAgentRegistry().exec(
          `DELETE FROM cf_agents_sub_agents WHERE class = ? AND name = ?`,
          cls.name, name,
        );
      }
      /** The SDK's `destroy()` (`agents/dist/src-5W6JNKVb.js:5447`) minus facets: always the root here. */
      async destroy(): Promise<void> {
        if (!this.ctx) throw new Error('harness Agent: destroy needs a ctx');
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        // Deferred past the returning call (a loop turn), as the SDK defers it.
        setImmediate(() => this.ctx?.abort('destroyed'));
      }

      async _cf_destroyDescendantFacet(path: readonly { className: string; name: string }[]): Promise<void> {
        const parent = this.selfPath;

        if (path.length !== parent.length + 1 || parent.some((step, index) => path[index]?.className !== step.className || path[index]?.name !== step.name)) throw new Error('The fixture can delete only a direct descendant.');
        const child = path.at(-1);

        if (!child) throw new Error('The descendant path is empty.');
        await this.deleteSubAgent({ name: child.className }, child.name);
      }
      /** Name form only (the SDK reduces the class overload to `cls.name`, :5868); a class-form
       *  call would miss every row and turn the facet gate red. */
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
      /** Copied from `agents/dist/index.js:4205`: tracing renders it into `kinu.self_path`, the only
       *  discriminator (a facet's `ctx.id` reports its root's). Top-level here, so `_parentPath` is empty. */
      get selfPath(): ReadonlyArray<{ className: string; name: string }> {
        return [{ className: this.constructor.name, name: String(this.name) }];
      }
      get parentPath(): ReadonlyArray<{ className: string; name: string }> {
        return [];
      }
      readonly name: string = '';
    },
    callable: () => <Method>(method: Method, context: ClassMethodDecoratorContext): Method => {
      declaredCallables.add(String(context.name));

      return method;
    },
    // A harness call has no connection, as a route's or a stub's has none, unless the suite opens one as a pane would.
    getCurrentAgent: () => ({ agent: undefined, connection: paneConnection, request: undefined, email: undefined }),
    getAgentByName: async (namespace: DurableObjectNamespace, name: string) =>
      namespace.get(namespace.idFromName(name)),
    /** Undefined is the SDK's "not my path", which drops the request to the SPA fallback. */
    routeAgentRequest: async (): Promise<Response | undefined> => undefined,
  }));
  // Spread the preload's boundary stub (`scripts/test-preload.ts`) whole: a named import the mock
  // lacks (sandbox 0.12.0 imports `tracing`) is a SyntaxError at load for every suite reaching it.
  // Recording at `tracing.enterSpan` keeps everything above it production code.
  registerSynchronousMock('cloudflare:workers', () => ({
    ...workersModule,
    // The shipped launcher over the in-process loader.
    exports: {
      ...workersModule.exports,
      CodemodeLauncher: ({ props }: { props: CodemodeLauncherProps }) => ({
        run: async (...args: Parameters<CodemodeLauncher['run']>) => {
          const { CodemodeLauncher: Launcher } = await import('../../src/codemode-sandbox');
          const { inProcessWorkerLoader } = await import('./worker-loader');
          const { workerContext } = await import('./bindings');

          return await new Launcher({ ...workerContext(), props }, { LOADER: Object.create(inProcessWorkerLoader()) }).run(...args);
        },
        // One process: a job's context always answers.
        answer: async () => {},
      }),
    },
    tracing: {
      enterSpan: <T>(name: string, fn: (span: NativeSpanStub) => T): T => {
        const { attributes, exceptions, close, setAttributes } = openNativeSpan(name);
        let closesLater = false;

        try {
          const result = fn({
            isTraced: true,
            setAttribute: (key: string, value: string | number | boolean) => { attributes.set(key, value); },
            setAttributes,
            recordException: (failure) => { exceptions.push(failure); },
          });

          if (result instanceof Promise) {
            closesLater = true;
            // `then(ok, err)`, not `finally`: `finally` derives an unawaited promise that rejects unhandled.
            void result.then(close, close);
          }

          return result;
        } finally {
          if (!closesLater) close();
        }
      },
      /**
       * `RuntimeTracer.activate`'s entry, into the same span log; `end()` is caller-owned, as on the platform.
       */
      startActiveSpan: <T>(
        name: string,
        fn: (span: NativeSpanStub & { end(): void }) => T,
      ): T => {
        const { attributes, exceptions, close, setAttributes } = openNativeSpan(name);

        return fn({
          isTraced: true,
          setAttribute: (key: string, value: string | number | boolean) => { attributes.set(key, value); },
          setAttributes,
          recordException: (failure) => { exceptions.push(failure); },
          end: close,
        });
      },
    },
  }));
}

interface NativeSpanStub {
  readonly isTraced: boolean;
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(values: Record<string, string | number | boolean>): void;
  recordException(failure: { name: string; code: string }): void;
}

export interface NativeSpanRecord {
  readonly name: string;
  /** Index in `nativeSpans` of the span this opened inside, or null at a root. */
  readonly parent: number | null;
  readonly attributes: ReadonlyMap<string, string | number | boolean>;
  readonly exceptions: readonly { name: string; code: string }[];
}

const nativeSpans: NativeSpanRecord[] = [];

const openSpans: number[] = [];

function openNativeSpan(name: string) {
  const index = nativeSpans.length;
  const attributes = new Map<string, string | number | boolean>();
  const exceptions: { name: string; code: string }[] = [];
  nativeSpans.push({ name, parent: openSpans.at(-1) ?? null, attributes, exceptions });
  openSpans.push(index);

  return {
    attributes,
    exceptions,
    setAttributes: (values: Record<string, string | number | boolean>): void => {
      for (const [key, value] of Object.entries(values)) attributes.set(key, value);
    },
    close: () => {
      const top = openSpans.lastIndexOf(index);

      if (top >= 0) openSpans.splice(top, 1);
    },
  };
}

/** Spans opened since the last `resetNativeSpans`. Empty means instrumentation was never reached:
 *  assert a non-zero length first. */
export function recordedNativeSpans(): readonly NativeSpanRecord[] {
  return nativeSpans;
}

export function resetNativeSpans(): void {
  nativeSpans.length = 0;
  openSpans.length = 0;
}
