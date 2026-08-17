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
  mock.module('cloudflare:workers', () => ({
    RpcTarget: class {},
    WorkerEntrypoint: class {},
    DurableObject: class {},
    tracing: {
      enterSpan: <T>(_name: string, fn: (span: { setAttribute: () => void }) => T): T =>
        fn({ setAttribute: () => {} }),
    },
  }));
}
