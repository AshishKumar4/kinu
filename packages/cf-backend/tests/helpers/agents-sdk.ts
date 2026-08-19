import { mock } from 'bun:test';
import type { AgentContext } from 'agents';
import type { SqlValue } from '@proteus/core';

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
  mock.module('agents', () => ({
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
        }
      }
      /** The SDK's DO heartbeat. Production uses it for work that outlives the
       *  call that started it (the drain timer, the genesis turn), so the stand-in
       *  runs the body — without it those paths throw here and are untestable. */
      async keepAliveWhile<Result>(fn: () => Promise<Result>): Promise<Result> {
        return fn();
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
       *  `proteus.self_path` and it is the ONLY discriminator that exists — a
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
    __DO_NOT_USE_WILL_BREAK__withInvocationScope: <Scope, Result>(_scope: Scope, fn: () => Result): Result => fn(),
    isDurableObjectMemoryLimitReset: () => false,
    isPlatformTransientError: () => false,
    getAgentByName: async (namespace: DurableObjectNamespace, name: string) =>
      namespace.get(namespace.idFromName(name)),
    /** The Worker entry's transport for `/agents/*`. Returning undefined is the
     *  SDK's "not my path" answer, which drops the request to the SPA fallback. */
    routeAgentRequest: async (): Promise<Response | undefined> => undefined,
  }));
  // UserDO imports these at module load; the real ones reach `cloudflare:*`.
  // No test exercises the live MCP client — the per-user MCP surface is covered
  // through its pure helpers in unit-user-mcp.test.ts.
  mock.module('agents/mcp/client', () => ({
    MCPClientManager: class {
      mcpConnections = {};
      async removeServer() {}
      async restoreConnectionsFromStorage() {}
    },
  }));
  mock.module('agents/mcp/do-oauth-client-provider', () => ({
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
  mock.module('cloudflare:workers', () => ({
    RpcTarget: class {},
    WorkerEntrypoint: class {},
    DurableObject: class {},
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
        .filter(([key]) => key !== 'proteus.self_path')
        .map(([key, value]) => `${key.replace('proteus.', '')}=${String(value)}`)
        .join(' ');
      lines.push(`${'  '.repeat(depth)}${span.name}${shown === '' ? '' : `  [${shown}]`}`);
      walk(index, depth + 1);
    });
  };
  walk(null, 0);
  return lines.join('\n');
}
