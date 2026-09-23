// One table (AGENT_RPC_ACCESS) names every remotely invokable agent method and its credential class, and both
// transports enforce it: the websocket frame gate here and the /workspaces/:name/rpc dispatcher in cli/routes.ts.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_RPC_ACCESS,
  CLI_BEARER_HEADER,
  CLI_SCOPES_HEADER,
  SESSION_BEARER_HEADER,
  appendIdentityHeaders,
  cliScopesConnectionTag,
  rejectOutOfScopeRpc,
  requiredRpcAccess,
  rpcAccessScope,
} from '../src/cli/rpc-gate';
import { extractTicketOrchestratorAgentName } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { mockAgentsSdk } from './helpers/agents-sdk';

// The /api app's module graph reaches the Agents SDK: mocked before it loads.
mockAgentsSdk();

const { api } = await import('../src/api/app');

const root = join(import.meta.dir, '..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function rpcFrame(method: string, id = 'req-1'): string {
  return JSON.stringify({ type: 'rpc', id, method, args: [] });
}

function scopeTag(scopes: string): string {
  const tag = cliScopesConnectionTag(scopes);

  if (!tag) throw new Error(`Expected a connection tag for scopes: ${scopes}`);

  return tag;
}

const RpcErrorFrameSchema = v.object({ error: v.string() });

const EXEC_ONLY = [scopeTag('workspace.exec')];

const READ_EXEC = [scopeTag('workspace.read,workspace.exec')];

describe('connect-ticket scope tags', () => {
  test('interactive sessions carry no tag and stay unrestricted', () => {
    expect(cliScopesConnectionTag(null)).toBeNull();
    expect(rejectOutOfScopeRpc([], rpcFrame('getAgentStatus'))).toBeNull();
    expect(rejectOutOfScopeRpc(['some-other-tag'], rpcFrame('setModel'))).toBeNull();
  });

  test('scoped headers round-trip through the connection tag', () => {
    expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame('getAgentStatus'))).toBeNull();
    expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame('executeInExecutor'))).toBeNull();
    expect(rejectOutOfScopeRpc(EXEC_ONLY, rpcFrame('executeInExecutor'))).toBeNull();
    expect(rejectOutOfScopeRpc(EXEC_ONLY, rpcFrame('getAgentStatus'))).not.toBeNull();
  });

  test('an unparseable scope header fails closed, never open', () => {
    const tag = scopeTag('totally-bogus');
    expect(rejectOutOfScopeRpc([tag], rpcFrame('getAgentStatus'))).not.toBeNull();
    expect(rejectOutOfScopeRpc([tag], rpcFrame('setModel'))).not.toBeNull();
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
    expect(v.parse(RpcErrorFrameSchema, JSON.parse(rejection ?? '')).error).toContain('not remotely invokable');
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
    for (const method of ['cancelCurrentWork', 'executeInExecutor'] as const) {
      expect(AGENT_RPC_ACCESS[method]).toBe('workspace.exec');
      expect(rejectOutOfScopeRpc(EXEC_ONLY, rpcFrame(method))).toBeNull();
      expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method))).toBeNull();
    }
  });

  test('read RPCs are scope-checked: exec-only tokens get a typed rejection', () => {
    const rejection = present(rejectOutOfScopeRpc(EXEC_ONLY, rpcFrame('getMemoryContent', 'rpc-7')), 'the out-of-scope rejection');
    const frame = JSON.parse(rejection);
    expect(frame).toMatchObject({ type: 'rpc', id: 'rpc-7', success: false });
    expect(frame.error).toContain('workspace.read');
  });

  test('the old websocket-read-allowlist methods are interactive-only now — a read+exec scoped token cannot reach them (no read-only widening)', () => {
    for (const method of [
      'checkpointStatus', 'getEvolutionChangelog', 'listSubordinates',
      'latestAlternateTakes', 'listFileCheckpoints', 'listMounts', 'planFileRestore',
    ] as const) {
      expect(AGENT_RPC_ACCESS[method]).toBe('interactive');
      // Denied to read-only and read+exec tokens: the strict, non-widening class.
      expect(rejectOutOfScopeRpc([scopeTag('workspace.read')], rpcFrame(method))).not.toBeNull();
      expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method))).not.toBeNull();
    }
  });

  test('mutating @callables are rejected with a typed rpc error frame', () => {
    for (const method of [
      'resolveDeviceConsent', 'setShellApprovalMode', 'setMctsConfig',
      'forkAgent', 'revertChangelogEntry', 'restoreFileCheckpoint',
      'pickAlternateTake', 'branchTurn', 'setModel', 'setDisplayName',
      'markChangelogSeen', 'createTimerTrigger', 'createSubordinateAgent',
      'renameSubordinateAgent', 'dismissSubordinate',
      'savePlanReviewAnnotations', 'decidePlanReview',
    ]) {
      const rejection = present(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method, 'rpc-9')), `the out-of-scope rejection of ${method}`);
      const frame = JSON.parse(rejection);
      expect(frame).toMatchObject({ type: 'rpc', id: 'rpc-9', success: false });
      expect(frame.error).toContain('kinu auth');
    }
  });

  test('plan review RPCs use the owner boundary appropriate to their effect', () => {
    expect(AGENT_RPC_ACCESS.getActivePlanReview).toBe('workspace.read');
    expect(AGENT_RPC_ACCESS.savePlanReviewAnnotations).toBe('interactive');
    expect(AGENT_RPC_ACCESS.decidePlanReview).toBe('interactive');
  });

  test('instruction-trust RPCs are interactive-only — a scoped token cannot grant system placement', () => {
    // KINU-N028: agent-written bytes cannot authorise themselves, so approving (and the listing, which previews
    // content) is interactive rather than a CI-reachable workspace scope.
    expect(AGENT_RPC_ACCESS.approveInstruction).toBe('interactive');
    expect(AGENT_RPC_ACCESS.revokeInstruction).toBe('interactive');
    expect(AGENT_RPC_ACCESS.listInstructionApprovals).toBe('interactive');
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
    // A client's own identity headers never survive the edge: each is rewritten from the verified
    // identity, or removed when the identity has none.
    const forged = new Headers({
      [CLI_SCOPES_HEADER]: 'workspace.exec',
      [CLI_BEARER_HEADER]: 'forged:9',
      [SESSION_BEARER_HEADER]: 'forged',
    });

    const browser = appendIdentityHeaders(forged, {
      userId: 'user-1', email: 'owner@example.com', sub: 'sub', authTime: 5, sessionTokenHash: 'session-1',
    });

    expect(browser.get(SESSION_BEARER_HEADER)).toBe('session-1');
    expect(browser.has(CLI_SCOPES_HEADER)).toBe(false);
    expect(browser.has(CLI_BEARER_HEADER)).toBe(false);

    const ticket = appendIdentityHeaders(forged, {
      userId: 'user-1', email: 'owner@example.com', sub: 'cli', authTime: 5,
      cliScopes: ['workspace.read'], cliBearer: { tokenHash: 'token-1', generation: 2 },
    });

    expect(ticket.get(CLI_SCOPES_HEADER)).toBe('workspace.read');
    expect(ticket.get(CLI_BEARER_HEADER)).toBe('token-1:2');
    expect(ticket.has(SESSION_BEARER_HEADER)).toBe(false);
    expect(source('src/server.ts')).toContain('if (verified.scopes) identity.cliScopes = verified.scopes');
    // Tickets admit the root and one hosted actor beneath it; a `/sub/` hop names nothing.
    expect(extractTicketOrchestratorAgentName('/agents/orchestrator-agent/workspace')).toBe('workspace');
    expect(extractTicketOrchestratorAgentName(
      '/agents/orchestrator-agent/workspace/actor/researcher',
    )).toBe('workspace');
    expect(extractTicketOrchestratorAgentName(
      '/agents/orchestrator-agent/workspace/sub/subordinate-agent/researcher',
    )).toBeNull();
    expect(extractTicketOrchestratorAgentName(
      '/agents/orchestrator-agent/workspace/sub/subordinate-agent/researcher/sub/subordinate-agent/nested',
    )).toBeNull();
    expect(extractTicketOrchestratorAgentName('/agents/user-d-o/victim')).toBeNull();
  });

  test('ticket verification resolves the bearer scopes at verify time', () => {
    const userDO = source('src/user/user-do.ts');
    expect(userDO).toContain('cliBearerScopes');
    expect(userDO).toContain('getActiveAccessTokenScopes');
    expect(userDO).toContain("if (bearerScopes !== 'all') verification.scopes = bearerScopes");
  });

  test('the actor substrate gates rpc frames and pins scoped sockets readonly', () => {
    const actor = source('src/actor-agent.ts');
    expect(actor).toContain('rejectOutOfScopeRpc(connection.tags, message)');
    expect(actor).toContain('cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER))');
    expect(actor).toContain('override shouldConnectionBeReadonly');
  });

  test('the HTTP dispatcher consumes THIS table — no second scope policy anywhere', () => {
    // One route in the whole /api app dispatches agent RPC. Hono dispatches in registration order, so
    // its place in the table is its policy: after the CLI bearer, ahead of the access-token route
    // policy (`/api/cli*` then holds [bearer, route policy, not-found]), so this table decides alone.
    const rpc = api.routes.filter((route) => route.path.endsWith('/rpc'));
    expect(rpc.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /api/cli/workspaces/:name/rpc']);

    const cliGates = api.routes.flatMap((route, index) => (route.method === 'ALL' && route.path === '/api/cli*' ? [index] : []));
    const at = api.routes.indexOf(present(rpc[0], 'the RPC route'));
    expect(cliGates).toHaveLength(3);
    expect(present(cliGates[0], 'the CLI bearer')).toBeLessThan(at);
    expect(at).toBeLessThan(present(cliGates[1], 'the access-token route policy'));
  });

  test('the header constant has one home', () => {
    expect(CLI_SCOPES_HEADER).toBe('x-kinu-cli-scopes');
    expect(source('src/server.ts')).not.toContain("'x-kinu-cli-scopes'");
    expect(source('src/orchestrator.ts')).not.toContain("'x-kinu-cli-scopes'");
  });
});

describe('the table is the CLI dispatch allowlist, not documentation', () => {
  // cli/routes.ts dispatches only AGENT_RPC_ACCESS keys, so a @callable the CLI calls but the table omits
  // fails against every cloud workspace while passing every local test.
  const CLI_SRC = join(root, '../cli/src');

  function cliInvokedNames(): string[] {
    const files = readdirSync(CLI_SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'));

    const names = new Set<string>();

    for (const file of files) {
      const src = readFileSync(join(CLI_SRC, file), 'utf8');

      for (const call of src.matchAll(/\b\w*[Rr]pc\w*\s*(?:<[^>]*>)?\s*\(([^()]*?)\)/gs)) {
        for (const literal of call[1].matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)) names.add(literal[1]);
      }
    }

    return [...names];
  }

  function orchestratorCallables(): Set<string> {
    return new Set([...source('src/orchestrator.ts')
      .matchAll(/@callable\([^)]*\)\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
      .map((match) => match[1]));
  }

  test('every orchestrator RPC the CLI invokes is in the table', () => {
    const callables = orchestratorCallables();
    const invoked = cliInvokedNames().filter((name) => callables.has(name));
    expect(invoked.length).toBeGreaterThan(20);
    expect(invoked.filter((name) => !(name in AGENT_RPC_ACCESS)).sort()).toEqual([]);
  });

  test('the calibration flow is reachable at the class each step needs', () => {
    expect(AGENT_RPC_ACCESS.getOutcomeCalibration).toBe('workspace.read');
    expect(AGENT_RPC_ACCESS.sampleOutcomeLabeling).toBe('workspace.read');
    expect(AGENT_RPC_ACCESS.recordOutcomeLabeling).toBe('interactive');
    expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame('recordOutcomeLabeling'))).not.toBeNull();
  });

  test('reading the judge panel is a read; running it is not', () => {
    // It spends the owner's model budget and writes verdicts, so it sits with the mutations.
    expect(AGENT_RPC_ACCESS.getOutcomeEnsemble).toBe('workspace.read');
    expect(AGENT_RPC_ACCESS.runOutcomeEnsemble).toBe('interactive');
    expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame('runOutcomeEnsemble'))).not.toBeNull();
  });
});
