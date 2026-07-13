// The unified remote-RPC policy: ONE table (AGENT_RPC_ACCESS) names every
// remotely invokable agent method and its credential class, and BOTH
// transports enforce it — the websocket frame gate here, the HTTP
// /workspaces/:name/rpc dispatcher in cli/routes.ts. Regression for the
// scope-model bypass where every @callable (consent self-approval, approval
// mode, config, fork) was reachable from an exec-scoped CI token, and for the
// pre-unification drift where the REST router and the websocket gate kept two
// mirrored copies of the scope policy.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_RPC_ACCESS,
  CLI_SCOPES_HEADER,
  cliScopesConnectionTag,
  cliScopesFromTags,
  rejectOutOfScopeRpc,
  requiredRpcAccess,
  rpcAccessScope,
} from '../src/cli/rpc-gate.js';

const root = join(import.meta.dir, '..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function rpcFrame(method: string, id = 'req-1'): string {
  return JSON.stringify({ type: 'rpc', id, method, args: [] });
}

const EXEC_ONLY = [cliScopesConnectionTag('workspace.exec')!];
const READ_EXEC = [cliScopesConnectionTag('workspace.read,workspace.exec')!];

describe('connect-ticket scope tags', () => {
  test('interactive sessions carry no tag and stay unrestricted', () => {
    expect(cliScopesConnectionTag(null)).toBeNull();
    expect(cliScopesFromTags([])).toBeNull();
    expect(cliScopesFromTags(['some-other-tag'])).toBeNull();
  });

  test('scoped headers round-trip through the connection tag', () => {
    expect(cliScopesFromTags(READ_EXEC)).toEqual(['workspace.read', 'workspace.exec']);
    expect(cliScopesFromTags(EXEC_ONLY)).toEqual(['workspace.exec']);
  });

  test('an unparseable scope header fails closed, never open', () => {
    const tag = cliScopesConnectionTag('totally-bogus')!;
    expect(cliScopesFromTags([tag])).toEqual([]);
    expect(rejectOutOfScopeRpc([tag], rpcFrame('getAgentStatus'))).not.toBeNull();
  });
});

describe('the scope table', () => {
  test('off-table method names resolve to null — never a scope', () => {
    expect(requiredRpcAccess('claimOwner')).toBeNull();
    expect(requiredRpcAccess('deviceRpc')).toBeNull();
    expect(requiredRpcAccess('sql')).toBeNull();
    expect(requiredRpcAccess('nonexistentMethod')).toBeNull();
  });

  test('prototype-chain names are off-table (no Object.prototype fallthrough)', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(requiredRpcAccess(name)).toBeNull();
    }
  });

  test('destroyAgent is never remotely invokable', () => {
    expect(requiredRpcAccess('destroyAgent')).toBe('never');
    expect(rpcAccessScope('never')).toBeNull();
    const rejection = rejectOutOfScopeRpc(READ_EXEC, rpcFrame('destroyAgent', 'rpc-3'));
    expect(JSON.parse(rejection!).error).toContain('not remotely invokable');
  });

  test('access classes narrow to scopes only for scope-carrying rows', () => {
    expect(rpcAccessScope('workspace.read')).toBe('workspace.read');
    expect(rpcAccessScope('workspace.exec')).toBe('workspace.exec');
    expect(rpcAccessScope('interactive')).toBeNull();
    expect(rpcAccessScope(null)).toBeNull();
  });
});

describe('rpc gate on scoped connections', () => {
  test('interactive (untagged) connections pass every frame through', () => {
    for (const method of ['resolveDeviceConsent', 'setShellApprovalMode', 'setMctsConfig', 'forkAgent']) {
      expect(rejectOutOfScopeRpc([], rpcFrame(method))).toBeNull();
    }
  });

  test('chat frames pass through on scoped connections', () => {
    const chat = JSON.stringify({
      id: 'turn-1',
      init: { method: 'POST', body: '{"messages":[]}' },
      type: 'cf_agent_use_chat_request',
    });
    expect(rejectOutOfScopeRpc(READ_EXEC, chat)).toBeNull();
    expect(rejectOutOfScopeRpc(READ_EXEC, JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'turn-1' }))).toBeNull();
    expect(rejectOutOfScopeRpc(READ_EXEC, new ArrayBuffer(4))).toBeNull();
    expect(rejectOutOfScopeRpc(READ_EXEC, 'not json')).toBeNull();
  });

  test('every workspace.read row is allowed with workspace.read, on either transport', () => {
    for (const [method, access] of Object.entries(AGENT_RPC_ACCESS)) {
      if (access !== 'workspace.read') continue;
      expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method))).toBeNull();
    }
  });

  test('workspace.exec rows are allowed with workspace.exec (same grant REST gave POST /stop and executor exec)', () => {
    for (const method of ['cancelCurrentWork', 'executeInExecutor']) {
      expect(AGENT_RPC_ACCESS[method as keyof typeof AGENT_RPC_ACCESS]).toBe('workspace.exec');
      expect(rejectOutOfScopeRpc(EXEC_ONLY, rpcFrame(method))).toBeNull();
      expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method))).toBeNull();
    }
  });

  test('read RPCs are scope-checked: exec-only tokens get a typed rejection', () => {
    const rejection = rejectOutOfScopeRpc(EXEC_ONLY, rpcFrame('getMemoryContent', 'rpc-7'));
    expect(rejection).not.toBeNull();
    const frame = JSON.parse(rejection!);
    expect(frame).toMatchObject({ type: 'rpc', id: 'rpc-7', success: false });
    expect(frame.error).toContain('workspace.read');
  });

  test('the old websocket-read-allowlist methods are interactive-only now — a read+exec scoped token cannot reach them (no read-only widening)', () => {
    for (const method of [
      'checkpointStatus', 'getEvolutionChangelog', 'getWorkspaceAgents',
      'latestAlternateTakes', 'listFileCheckpoints', 'listMounts', 'planFileRestore',
    ]) {
      expect(AGENT_RPC_ACCESS[method as keyof typeof AGENT_RPC_ACCESS]).toBe('interactive');
      // Denied to a read-only token (the regression this guards) AND to a
      // read+exec token (the strict, non-widening approximation of the old
      // "needs read allowlist + exec to open the socket" requirement).
      expect(rejectOutOfScopeRpc([cliScopesConnectionTag('workspace.read')!], rpcFrame(method))).not.toBeNull();
      expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method))).not.toBeNull();
    }
  });

  test('mutating @callables are rejected with a typed rpc error frame', () => {
    for (const method of [
      'resolveDeviceConsent', 'setShellApprovalMode', 'setMctsConfig',
      'forkAgent', 'revertChangelogEntry', 'restoreFileCheckpoint',
      'pickAlternateTake', 'branchTurn', 'setModel', 'setDisplayName',
      'markChangelogSeen', 'createTimerTrigger',
    ]) {
      const rejection = rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method, 'rpc-9'));
      expect(rejection).not.toBeNull();
      const frame = JSON.parse(rejection!);
      expect(frame).toMatchObject({ type: 'rpc', id: 'rpc-9', success: false });
      expect(frame.error).toContain('proteus auth');
    }
  });

  test('every interactive row is denied to scoped tokens', () => {
    for (const [method, access] of Object.entries(AGENT_RPC_ACCESS)) {
      if (access !== 'interactive') continue;
      expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method))).not.toBeNull();
    }
  });
});

describe('wiring invariants (edge → ticket → DO, one policy table)', () => {
  test('the edge rewrites the scope header from the verified identity', () => {
    const server = source('src/server.ts');
    expect(server).toContain('next.delete(CLI_SCOPES_HEADER)');
    expect(server).toContain('next.set(CLI_SCOPES_HEADER, identity.cliScopes');
    expect(server).toContain('cliScopes: verified.scopes');
    // Tickets only authenticate the agent's root websocket path — sub-paths
    // would expose child-agent callables to scoped sockets. The anchored path
    // regex lives in the agent-routing policy module server.ts routes through.
    expect(source('src/agent-routing.ts')).toContain('([^/]+)$');
  });

  test('ticket verification resolves the bearer scopes at verify time', () => {
    const userDO = source('src/user/user-do.ts');
    expect(userDO).toContain('cliBearerScopes');
    expect(userDO).toContain('getActiveAccessTokenScopes');
    expect(userDO).toContain('scopes: bearerScopes');
  });

  test('the actor substrate gates rpc frames and pins scoped sockets readonly', () => {
    const actor = source('src/actor-agent.ts');
    expect(actor).toContain('rejectOutOfScopeRpc(connection.tags, message)');
    expect(actor).toContain('cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER))');
    expect(actor).toContain('override shouldConnectionBeReadonly');
  });

  test('the HTTP dispatcher consumes THIS table — no second scope policy anywhere', () => {
    const routes = source('src/cli/routes.ts');
    expect(routes).toContain("from './rpc-gate.js'");
    expect(routes).toContain('requiredRpcAccess(');
    // The old mirrored copies are gone: no per-agent-method scope map may
    // exist outside rpc-gate.ts (the catch-all GET /workspaces/:name/*
    // read rule was that mirror on the REST side).
    expect(routes).not.toContain('SCOPED_RPC_ALLOWLIST');
    expect(routes).not.toContain(String.raw`/^\/workspaces\/[^/]+\/[^/]+/`);
  });

  test('the header constant has one home', () => {
    expect(CLI_SCOPES_HEADER).toBe('x-proteus-cli-scopes');
    expect(source('src/server.ts')).not.toContain("'x-proteus-cli-scopes'");
    expect(source('src/orchestrator.ts')).not.toContain("'x-proteus-cli-scopes'");
  });
});
