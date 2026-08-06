import { mock } from 'bun:test';

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
      readonly ctx: unknown;
      readonly env: unknown;
      constructor(ctx?: unknown, env?: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
    /** The real decorator only attaches RPC metadata. */
    callable: () => (method: unknown) => method,
    // Named imports @cloudflare/think binds at module load. bun resolves the
    // whole import list eagerly, so a missing name is a load-time SyntaxError
    // for any test that reaches an ActorAgent subclass.
    getCurrentAgent: () => ({ agent: undefined, connection: undefined, request: undefined }),
    __DO_NOT_USE_WILL_BREAK__agentContext: { getStore: () => undefined, run: (_store: unknown, fn: () => unknown) => fn() },
    __DO_NOT_USE_WILL_BREAK__withInvocationScope: (_scope: unknown, fn: () => unknown) => fn(),
    isDurableObjectMemoryLimitReset: () => false,
    isPlatformTransientError: () => false,
    getAgentByName: async (namespace: DurableObjectNamespace, name: string) =>
      namespace.get(namespace.idFromName(name)),
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
  // workerd-only module at load.
  mock.module('cloudflare:workers', () => ({
    RpcTarget: class {},
    WorkerEntrypoint: class {},
    DurableObject: class {},
  }));
}
