// Scope enforcement at the agent-websocket boundary: a `pta_…` access token
// with workspace.exec can mint a connect ticket, so the DO must pin that socket
// to chat frames + read-only RPCs. Regression for the scope-model bypass
// where every @callable (consent self-approval, approval mode, config, fork)
// was reachable from an exec-scoped CI token.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLI_SCOPES_HEADER,
  cliScopesConnectionTag,
  cliScopesFromTags,
  rejectOutOfScopeRpc,
} from '../src/cli/ws-rpc-gate.js';

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
    expect(rejectOutOfScopeRpc([tag], rpcFrame('getEvolutionChangelog'))).not.toBeNull();
  });
});

describe('rpc gate on scoped connections', () => {
  test('interactive (untagged) connections pass every frame through', () => {
    for (const method of ['resolveDeviceConsent', 'setShellApprovalMode', 'setAgentConfig', 'forkAgent']) {
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

  test('read RPCs are allowed with workspace.read', () => {
    for (const method of [
      'getEvolutionChangelog', 'latestAlternateTakes',
      'listFileCheckpoints', 'planFileRestore', 'checkpointStatus',
    ]) {
      expect(rejectOutOfScopeRpc(READ_EXEC, rpcFrame(method))).toBeNull();
    }
  });

  test('read RPCs are scope-checked: exec-only tokens get a typed rejection', () => {
    const rejection = rejectOutOfScopeRpc(EXEC_ONLY, rpcFrame('listFileCheckpoints', 'rpc-7'));
    expect(rejection).not.toBeNull();
    const frame = JSON.parse(rejection!);
    expect(frame).toMatchObject({ type: 'rpc', id: 'rpc-7', success: false });
    expect(frame.error).toContain('workspace.read');
  });

  test('mutating @callables are rejected with a typed rpc error frame', () => {
    for (const method of [
      'resolveDeviceConsent', 'setShellApprovalMode', 'setAgentConfig',
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
});

describe('wiring invariants (edge → ticket → DO)', () => {
  test('the edge rewrites the scope header from the verified identity', () => {
    const server = source('src/server.ts');
    expect(server).toContain('next.delete(CLI_SCOPES_HEADER)');
    expect(server).toContain('next.set(CLI_SCOPES_HEADER, identity.cliScopes');
    expect(server).toContain('cliScopes: verified.scopes');
    // Tickets only authenticate the agent's root websocket path — sub-paths
    // would expose child-agent callables to scoped sockets.
    expect(server).toContain('([^/]+)$');
  });

  test('ticket verification resolves the bearer scopes at verify time', () => {
    const userDO = source('src/user/user-do.ts');
    expect(userDO).toContain('cliBearerScopes');
    expect(userDO).toContain('getActiveAccessTokenScopes');
    expect(userDO).toContain('scopes: bearerScopes');
  });

  test('the orchestrator gates rpc frames and pins scoped sockets readonly', () => {
    const orchestrator = source('src/orchestrator.ts');
    expect(orchestrator).toContain('rejectOutOfScopeRpc(connection.tags, message)');
    expect(orchestrator).toContain('cliScopesConnectionTag(ctx.request.headers.get(CLI_SCOPES_HEADER))');
    expect(orchestrator).toContain('override shouldConnectionBeReadonly');
  });

  test('the header constant has one home', () => {
    expect(CLI_SCOPES_HEADER).toBe('x-proteus-cli-scopes');
    expect(source('src/server.ts')).not.toContain("'x-proteus-cli-scopes'");
    expect(source('src/orchestrator.ts')).not.toContain("'x-proteus-cli-scopes'");
  });
});
