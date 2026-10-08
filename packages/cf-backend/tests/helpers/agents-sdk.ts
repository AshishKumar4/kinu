import * as workersModule from 'cloudflare:workers';
import type { CodemodeLauncher, CodemodeLauncherProps } from '../../src/codemode-sandbox';
import { mock } from 'bun:test';
import * as v from 'valibot';
import type { AgentContext, Connection, ConnectionContext, FiberRecoveryContext, WSMessage } from 'agents';
import { Lifecycle } from 'agents/lifecycle';
import { parseJsonValue, type JsonObject, type JsonValue, type SqlValue } from '@kinu.run/core';
import type { McpCredentialTransport } from '../../src/user/mcp';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

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

export function harnessFibersRunning(): boolean {
  return harnessFiberBodies.size > 0;
}

/** Work each object holds open through `keepAliveWhile`, as production keeps it alive for it (a drain debounce, say). */
const harnessKeepAlives = new WeakMap<workersModule.DurableObject, Set<Promise<unknown>>>();

/** Resolves when the work `agent` holds open through `keepAliveWhile` has settled. */
export async function joinHarnessKeepAlives(agent: workersModule.DurableObject): Promise<void> {
  const open = harnessKeepAlives.get(agent);

  while (open !== undefined && open.size > 0) await Promise.allSettled(open);
}

/** A lane's body (`ActorAgent.holdLane`), joined with the fibers. */
export function trackHarnessLane<Result>(lane: Promise<Result>): Promise<Result> {
  harnessFiberBodies.add(lane);

  return lane.finally(() => { harnessFiberBodies.delete(lane); });
}

/** Resolves when every `runFiber` body and lane started so far has settled. */
export async function joinHarnessFibers(): Promise<void> {
  while (harnessFiberBodies.size > 0) await Promise.all(harnessFiberBodies);
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
      /** The vendor base builds the one manager in its constructor (`agents/dist/src-5W6JNKVb.js:821`);
       *  since cloudflare/agents#1897 that is the only way a manager reaches storage. */
      readonly mcp = new FakeMCPClientManager();
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

        harnessFiberBodies.add(body);

        try {
          return await body;
        } finally {
          harnessActiveFibers.delete(id);
          harnessFiberBodies.delete(body);
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
       *  Recipient-set behaviour is measured in `tests/workerd/public-surface.test.ts`. */
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
  // UserDO imports these at module load; the double records the manager's writable state
  // (server rows, live connections), a second truth beside `user_mcp_servers`.
  registerSynchronousMock('agents/mcp/client', () => ({ MCPClientManager: FakeMCPClientManager }));
  // `connectToServer` reads `authUrl` (queued by `queueMcpAuthUrl`) and `clientId` off the provider.
  registerSynchronousMock('agents/mcp/do-oauth-client-provider', () => ({
    DurableObjectOAuthClientProvider: class {
      serverId = '';
      clientId: string | null = null;
      authUrl: string | null = pendingMcpAuthUrl;
      /** `auth()` reads this off the constructor's third argument, as the real one does. */
      readonly redirectUrl: string;
      constructor(_storage: DurableObjectStorage, _clientName?: string, baseRedirectUrl = '') {
        this.redirectUrl = baseRedirectUrl;
        pendingMcpAuthUrl = null;
      }

      // Answered as empty storage answers, so the real SDK auth flow runs against it.
      get clientMetadata() { return {}; }
      async clientInformation(): Promise<undefined> { return undefined; }
      async saveClientInformation(): Promise<void> {}
      async tokens(): Promise<undefined> { return undefined; }
      async saveTokens(): Promise<void> {}
      async codeVerifier(): Promise<string> { return 'test-code-verifier'; }
      async saveCodeVerifier(): Promise<void> {}
      async state(): Promise<string> { return `st.${this.serverId}`; }
      redirectToAuthorization(url: URL): void { this.authUrl = url.toString(); }
      async invalidateCredentials(): Promise<void> {}
    },
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

export function renderNativeSpanTree(): string {
  const lines: string[] = [];

  const walk = (parent: number | null, depth: number): void => {
    for (const [index, span] of nativeSpans.entries()) {
      if (span.parent !== parent) continue;

      const shown = [...span.attributes]
        .filter(([key]) => key !== 'kinu.self_path')
        .map(([key, value]) => `${key.replace('kinu.', '')}=${String(value)}`)
        .join(' ');

      lines.push(`${'  '.repeat(depth)}${span.name}${shown === '' ? '' : `  [${shown}]`}`);
      walk(index, depth + 1);
    }
  };

  walk(null, 0);

  return lines.join('\n');
}

/** The fields the fake's `connectToServer` and `seedMcpAuthContinuation` read or write. */
export interface RecordedMcpAuthProvider {
  authUrl?: string | null;
  clientId?: string | null;
  serverId?: string;
}

export interface RecordedMcpTransport {
  fetch?: McpCredentialTransport['fetch'];
  type?: string;
  headers?: Record<string, string>;
  requestInit?: RequestInit;
  /** Off the current whitelist, but a plaintext-era row can carry it
   *  (`a080f8d2a^:src/user/mcp.ts:270-287`). */
  eventSourceInit?: { fetch?: McpCredentialTransport['fetch'] };
  authProvider?: RecordedMcpAuthProvider;
  reconnectionOptions?: { maxRetries?: number };
  skipIssuerMetadataValidation?: boolean;
  onInsufficientScope?: () => void;
  maxStepUpRetries?: number;
  sessionId?: string;
  protocolVersion?: string;
}

/** A `cf_agents_mcp_servers` row: derived from `user_mcp_servers` and must never disagree with it. */
export interface RecordedMcpServer {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly callbackUrl: string;
  readonly clientId: string | null;
  readonly authUrl: string | null;
  readonly transport: RecordedMcpTransport;
  /** `encodeMcpServerOptions` of the transport (`:1036-1046`); `restoreConnectionsFromStorage`
   *  rebuilds from this, so credential-custody questions are asked of it. */
  readonly server_options: string | null;
}

/** `persistTransportOptions`' whitelist (agents/dist/client-zqKcsyFa.js:1022-1035) plus `eventSourceInit`.
 *  `fetch` is absent: the whitelist drops it, which is why a credential travels as a closure. */
const SDK_PERSISTED_TRANSPORT_KEYS = [
  'type', 'headers', 'requestInit', 'eventSourceInit', 'reconnectionOptions',
  'skipIssuerMetadataValidation', 'onInsufficientScope', 'maxStepUpRetries',
  'sessionId', 'protocolVersion',
] as const;

/** `encodeMcpServerOptions` (`:1036-1046`) by picking, so a key the SDK would not keep cannot reach the row. */
function encodeSdkServerOptions(transport: RecordedMcpTransport): string {
  return JSON.stringify({
    transport: Object.fromEntries(
      SDK_PERSISTED_TRANSPORT_KEYS
        .filter((key) => transport[key] !== undefined)
        .map((key) => [key, transport[key]]),
    ),
  });
}

export interface RecordedMcpConnection {
  connectionState: string;
  connectionError: string | null;
  tools: { name: string; description?: string; title?: string; inputSchema: unknown; annotations?: Tool['annotations'] }[];
  options: { transport: RecordedMcpTransport };
  /** The connection's MCP client, as far as a raw `tools/list` read goes; no `transport` once it closed. */
  client?: { request(): Promise<object>; transport?: object | undefined };
  sessionId?: string;
  clearResumedSession?(): void;
}

/** `restored` / `waited` are call counts: they prove a read did not touch the connection machinery. */
export interface RecordedMcpLifecycle {
  established: readonly string[];
  discovered: readonly string[];
  restored: number;
  waited: number;
}

const mcpServers = new Map<string, RecordedMcpServer>();

const mcpEstablished: string[] = [];

const mcpDiscovered: string[] = [];

let mcpCallToolFailure: Error | null = null;

let mcpCallToolAnswer: CallToolResult | undefined;

let mcpCallToolHeld = false;

const mcpToolAborts: unknown[] = [];

const mcpToolCalls: { serverId: string; name: string; arguments?: JsonObject }[] = [];

/** Every `callTool` the manager received, in order, as the SDK was handed it. */
export function recordedMcpToolCalls(): readonly { serverId: string; name: string; arguments?: JsonObject }[] {
  return mcpToolCalls;
}

export function seedMcpAnswer(answer: CallToolResult): void {
  mcpCallToolAnswer = answer;
}

/** The next `callTool` is held, as a server holding the request holds it: only its signal settles it, as the SDK's request settles. */
export function holdNextMcpToolCall(): void {
  mcpCallToolHeld = true;
}

/** A Streamable-HTTP session: a 404 on it is renewed. */
export function seedMcpSession(id: string, sessionId: string): void {
  const connection = liveMcpManager?.mcpConnections[id];

  if (!connection) throw new Error(`No live MCP connection for ${id}.`);
  connection.sessionId = sessionId;
  connection.clearResumedSession = () => { connection.sessionId = undefined; };
}

/** Each held call's abort reason: on it the SDK tells the server the request is cancelled. */
export function recordedMcpToolAborts(): readonly unknown[] {
  return mcpToolAborts;
}

/** Queued apart from the dispatch failure: in production the probe (`client-zqKcsyFa.js:762-764`)
 *  and the dispatch are two different requests failing. */
let mcpDiscoveryFailure: Error | null = null;

let mcpRemoveFailure: Error | null = null;

/** `userMcp_add` constructs the provider itself, so the provider stub picks this up at construction. */
let pendingMcpAuthUrl: string | null = null;

export function queueMcpAuthUrl(authUrl: string): void {
  pendingMcpAuthUrl = authUrl;
}

let liveMcpManager: { mcpConnections: Record<string, RecordedMcpConnection> } | null = null;

let mcpRestored = 0;

let mcpWaited = 0;

let mcpEstablishGate: Promise<void> | null = null;

let mcpRestoreGate: Promise<void> | null = null;

let mcpRestoreArrived: (() => void) | null = null;

let mcpEstablishArrived: (() => void) | null = null;

/** Named by the harness, not construction order: every stand-in Agent has its own manager. */
export function rememberMcpManager(manager: { mcpConnections: Record<string, RecordedMcpConnection> }): void {
  liveMcpManager = manager;
}

export function recordedMcpServers(): readonly RecordedMcpServer[] {
  return [...mcpServers.values()];
}

function credentialClosure(
  transport: RecordedMcpTransport | undefined,
): McpCredentialTransport['fetch'] | null {
  return transport?.fetch ?? null;
}

export function recordedMcpFetch(id: string): McpCredentialTransport['fetch'] | null {
  return credentialClosure(mcpServers.get(id)?.transport);
}

/** The closure the live connection runs on, as opposed to what the row was handed. */
export function liveMcpFetch(id: string): McpCredentialTransport['fetch'] | null {
  return credentialClosure(liveMcpManager?.mcpConnections[id]?.options.transport);
}

export function recordedMcpLifecycle(): RecordedMcpLifecycle {
  return { established: mcpEstablished, discovered: mcpDiscovered, restored: mcpRestored, waited: mcpWaited };
}

export interface McpEstablishGate {
  entered: Promise<void>;
  release: () => void;
}

/**
 * Blocks every `establishConnection` until `release` (the real one awaits `_connectWithRetry` unbounded,
 * `client-zqKcsyFa.js:2046,2073`). Await `entered`, not a delay: a synchronous check reads "not yet" as "never".
 */
export function hangMcpEstablish(): McpEstablishGate {
  const gate = Promise.withResolvers<void>();
  const arrival = Promise.withResolvers<void>();
  mcpEstablishGate = gate.promise;
  mcpEstablishArrived = () => { arrival.resolve(); };

  return { entered: arrival.promise, release: () => { gate.resolve(); } };
}

/**
 * Holds every dial `restoreConnectionsFromStorage` starts, as a dial still on the wire is held: the connection
 * stays `connecting` until `release`. Unheld, a restored dial lands at once.
 */
export function holdMcpRestore(): McpEstablishGate {
  const gate = Promise.withResolvers<void>();
  const arrival = Promise.withResolvers<void>();
  mcpRestoreGate = gate.promise;
  mcpRestoreArrived = () => { arrival.resolve(); };

  return { entered: arrival.promise, release: () => { gate.resolve(); } };
}

/** The transport under a ready connection closed: the SDK keeps the state `ready`, and its client has no transport. */
export function closeMcpTransport(id: string): void {
  const connection = liveMcpManager?.mcpConnections[id];

  if (!connection) throw new Error(`No live MCP connection for ${id}.`);
  connection.client = { request: async () => { throw new SdkError(SdkErrorCode.NotConnected, 'Not connected'); }, transport: undefined };
}

/** Every failure this seam classifies is an `Error` subclass, as the SDK's transports raise. */
export function failNextMcpToolCall(error: Error): void {
  mcpCallToolFailure = error;
}

/** Fails the SDK's own probe in `discoverIfConnected`; a mid-session revocation refuses both it and dispatch. */
export function failNextMcpDiscovery(error: Error): void {
  mcpDiscoveryFailure = error;
}

export function failNextMcpRemove(error: Error): void {
  mcpRemoveFailure = error;
}

/** Seeds the manager's own storage as an earlier activation left it; with no config row it is an orphan. */
export function seedSdkMcpServer(
  id: string,
  transport: RecordedMcpTransport = {},
  row: { callbackUrl?: string; clientId?: string | null } = {},
): void {
  mcpServers.set(id, {
    id, name: id, url: `https://${id}.example/sse`,
    callbackUrl: row.callbackUrl ?? '', clientId: row.clientId ?? null, authUrl: null, transport,
    server_options: encodeSdkServerOptions(transport),
  });
}

/** The state a cold activation presents before hydration re-registers a credentialed row. */
export function dropLiveMcpFetch(id: string): void {
  delete liveMcpManager?.mcpConnections[id]?.options.transport.fetch;
}

export function liveMcpTransport(id: string): RecordedMcpTransport | undefined {
  return liveMcpManager?.mcpConnections[id]?.options.transport;
}

/** Stands in for the authorization redirect: the `authUrl` the SDK reads while authenticating
 *  (`client-zqKcsyFa.js:1704-1706`) and `userMcp_list` renders as the reconnect link. */
export function seedMcpAuthContinuation(id: string, authUrl: string): void {
  const manager = liveMcpManager;

  if (!manager) throw new Error('No MCP manager has been constructed yet.');
  const connection = manager.mcpConnections[id];

  if (!connection) throw new Error(`No live MCP connection for ${id}.`);
  connection.options.transport.authProvider = {
    authUrl, clientId: 'test-client', serverId: id,
  };
}

/** The manager the Agent base built for this instance, the one the SDK's lifecycle restores on start. */
export function inheritedMcpManager(agent: { mcp: unknown }): {
  mcpConnections: Record<string, RecordedMcpConnection>;
  restoreConnectionsFromStorage(clientName: string): Promise<void>;
} {
  const manager = agent.mcp;

  if (!(manager instanceof FakeMCPClientManager)) {
    throw new Error('this agent was not built on the harness Agent base');
  }

  return manager;
}

/** Gives a configured server a live connection with tools, as discovery does. */
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

/** The state a failed discovery leaves: `connected`, no tools, and a client that answers `tools/list` raw. */
export function seedUndiscoveredMcpTools(id: string, answer: () => Promise<object>): void {
  const manager = liveMcpManager;

  if (!manager) throw new Error('No MCP manager has been constructed yet.');
  manager.mcpConnections[id] ??= {
    connectionState: 'connected', connectionError: null, tools: [], options: { transport: {} },
  };
  const connection = manager.mcpConnections[id];
  connection.connectionState = 'connected';
  connection.tools = [];
  connection.client = { request: answer, transport: {} };
}

/** As the SDK's request: an aborted signal rejects it at once, a later abort when it comes, with the signal's reason. */
function heldCall(signal: AbortSignal | undefined): Promise<CallToolResult> {
  return new Promise<CallToolResult>((_resolve, reject) => {
    const stop = (): void => {
      mcpToolAborts.push(signal?.reason);
      reject(signal?.reason);
    };

    if (signal?.aborted === true) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

export function resetRecordedMcp(): void {
  mcpCallToolAnswer = undefined;
  mcpCallToolHeld = false;
  mcpToolAborts.length = 0;
  mcpToolCalls.length = 0;
  mcpServers.clear();
  mcpEstablished.length = 0;
  mcpDiscovered.length = 0;
  mcpCallToolFailure = null;
  mcpDiscoveryFailure = null;

  mcpRemoveFailure = null;
  pendingMcpAuthUrl = null;
  liveMcpManager = null;
  mcpRestored = 0;
  mcpWaited = 0;
  mcpEstablishGate = null;
  mcpEstablishArrived = null;
  mcpRestoreGate = null;
  mcpRestoreArrived = null;
}

/** The pinned SDK's probe status read (`client-zqKcsyFa.js:204-210`). */
function mcpProbeStatus(error: Error): number | undefined {
  const code = v.safeParse(v.object({ code: v.number() }), error);

  if (code.success) return code.output.code;
  const status = v.safeParse(v.object({ status: v.number() }), error);

  if (status.success) return status.output.status;
  const nested = v.safeParse(v.object({ data: v.object({ status: v.number() }) }), error);

  if (nested.success) return nested.output.data.status;

  return undefined;
}

/** The pinned SDK's cause walk (`client-zqKcsyFa.js:211-214`). */
function mcpProbeCause(error: Error): Error | undefined {
  const direct = v.safeParse(v.object({ cause: v.unknown() }), error);

  if (direct.success && direct.output.cause instanceof Error) return direct.output.cause;
  const nested = v.safeParse(v.object({ data: v.object({ cause: v.unknown() }) }), error);

  if (nested.success && nested.output.data.cause instanceof Error) return nested.output.data.cause;

  return undefined;
}

/** The pinned SDK's unauthorized predicate (`client-zqKcsyFa.js:215-222`), deliberately not production's
 *  `isMcpTransportUnauthorized`: sharing it would make tests agree with production by construction. */
function isMcpDiscoveryUnauthorized(error: Error): boolean {
  if (mcpProbeStatus(error) === 401) return true;
  const cause = mcpProbeCause(error);

  if (cause !== undefined && cause !== error && isMcpDiscoveryUnauthorized(cause)) return true;

  return error.message.includes('Unauthorized') || error.message.includes('401');
}

/** What the vendor's `Event` subscription returns. */
interface HarnessDisposable {
  dispose(): void;
}

/**
 * Mirrors the real manager (`client-zqKcsyFa.js`): register does not connect (`:478`), reuse keeps a live
 * transport (`:1719-1720`), remove drops row and connection (`:2299-2305`), probe failure keeps cached tools.
 */
class FakeMCPClientManager {
  mcpConnections: Record<string, RecordedMcpConnection> = {};
  /** The vendor's restore-once flag; the host's write to it is the contract under test. */
  _isRestored = false;

  /** Dials in flight, as `_pendingConnections` holds them (`client-zqKcsyFa.js`): `waitForConnections` waits on these. */
  private readonly pending = new Set<Promise<void>>();

  private readonly stateListeners = new Set<() => void>();

  /** The vendor's `Event<void>`: a listener, and a disposable that removes it. */
  onServerStateChanged = (listener: () => void): HarnessDisposable => {
    this.stateListeners.add(listener);

    return { dispose: () => { this.stateListeners.delete(listener); } };
  };

  /** No event is fired here: the state listener sees every change this fake makes. */
  onObservabilityEvent = (_listener: (event: { type: string }) => void): HarnessDisposable => ({ dispose: () => {} });

  private changed(): void {
    for (const listener of this.stateListeners) listener();
  }

  private track(dial: Promise<void>): void {
    const tracked = dial.finally(() => { this.pending.delete(tracked); });
    this.pending.add(tracked);
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
      // Register re-persists the column: that is how a rewrite removes a credential.
      server_options: encodeSdkServerOptions(transport),
    });
    this.mcpConnections[id] ??= {
      connectionState: 'connecting', connectionError: null, tools: [], options: { transport },
    };
    this.changed();

    return id;
  }

  /** `cf_agents_mcp_servers` row shape (snake_case), as production sees it. */
  listServers(): {
    id: string; name: string; server_url: string; callback_url: string;
    client_id: string | null; auth_url: string | null; server_options: string | null;
  }[] {
    return [...mcpServers.values()].map((row) => ({
      id: row.id,
      name: row.name,
      server_url: row.url,
      callback_url: row.callbackUrl,
      client_id: row.clientId,
      auth_url: row.authUrl,
      server_options: row.server_options,
    }));
  }

  async removeServer(id: string): Promise<void> {
    const failure = mcpRemoveFailure;

    if (failure) {
      mcpRemoveFailure = null;
      throw failure;
    }

    delete this.mcpConnections[id];
    mcpServers.delete(id);
    this.changed();
  }

  /** Returns early once restored (`_isRestored`, `client-zqKcsyFa.js:1533-1534`); each restored connection starts
   *  `connecting` with its dial tracked, not awaited (`:1541-1580`). */
  async restoreConnectionsFromStorage(): Promise<void> {
    if (this._isRestored) return;
    mcpRestored += 1;

    for (const row of mcpServers.values()) {
      if (this.mcpConnections[row.id]) continue;

      const connection: RecordedMcpConnection = {
        connectionState: 'connecting', connectionError: null, tools: [], options: { transport: row.transport },
      };

      this.mcpConnections[row.id] = connection;
      this.track(this.restoreDial(connection));
    }

    this._isRestored = true;
  }

  /** `_restoreServer`: connect, then discover. Unheld, it lands before restore returns. */
  private async restoreDial(connection: RecordedMcpConnection): Promise<void> {
    if (mcpRestoreGate) {
      mcpRestoreArrived?.();
      await mcpRestoreGate;
    }

    connection.connectionState = 'ready';
    this.changed();
  }

  establishConnection(id: string): Promise<void> {
    mcpEstablished.push(id);
    const dial = this.establish(id);
    this.track(dial);

    return dial;
  }

  private async establish(id: string): Promise<void> {
    // The real one awaits `_connectWithRetry` unbounded.
    if (mcpEstablishGate) {
      mcpEstablishArrived?.();
      await mcpEstablishGate;
    }

    const connection = this.mcpConnections[id];

    if (connection) connection.connectionState = 'ready';
    this.changed();
  }

  async waitForConnections(): Promise<void> {
    mcpWaited += 1;
    await Promise.allSettled(this.pending);
  }

  /** A provider with no queued `authUrl` models a server that needed no sign-in. */
  async connectToServer(id: string): Promise<
    | { state: 'failed'; error: string }
    | { state: 'authenticating'; authUrl: string; clientId?: string }
    | { state: 'connected' }
  > {
    const connection = this.mcpConnections[id];

    if (!connection) return { state: 'failed', error: `no registered server ${id}` };

    const provider = connection.options.transport.authProvider;

    if (provider?.authUrl) {
      connection.connectionState = 'authenticating';

      return {
        state: 'authenticating',
        authUrl: provider.authUrl,
        clientId: provider.clientId ?? undefined,
      };
    }

    connection.connectionState = 'connected';

    if (connection.client) connection.client.transport = {};
    this.changed();

    return { state: 'connected' };
  }

  /** Early return without a connection (`client-zqKcsyFa.js:1991-2001`); a probe failure lands as the
   *  connection's catch does (`:762-764`) and does not clear tools. */
  async discoverIfConnected(id: string): Promise<void> {
    mcpDiscovered.push(id);
    const connection = this.mcpConnections[id];

    if (!connection) return;
    const probe = mcpDiscoveryFailure;
    mcpDiscoveryFailure = null;

    if (probe === null) {
      connection.connectionState = 'ready';
      this.changed();

      return;
    }

    connection.connectionState = isMcpDiscoveryUnauthorized(probe) ? 'authenticating' : 'connected';
    this.changed();
  }

  async callTool(params: { serverId: string; name: string; arguments?: JsonObject }, options?: { signal?: AbortSignal }): Promise<CallToolResult> {
    const connection = this.mcpConnections[params.serverId];

    // The client refuses a request on a transport that is not connected, before sending it (`Protocol.request`).
    if (connection === undefined || connection.connectionState === 'connecting'
      || (connection.client !== undefined && connection.client.transport === undefined)) {
      throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
    }

    mcpToolCalls.push(params);

    if (mcpCallToolHeld) {
      mcpCallToolHeld = false;

      return await heldCall(options?.signal);
    }

    const failure = mcpCallToolFailure;

    if (failure !== null) {
      mcpCallToolFailure = null;
      throw failure;
    }

    const answer = mcpCallToolAnswer;
    mcpCallToolAnswer = undefined;

    return answer ?? { content: [] };
  }
}
