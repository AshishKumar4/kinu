// One table (core AGENT_RPC_ACCESS) names every remotely invokable agent method and its credential class; the
// websocket frame gate here pins scoped sockets to its rows. The CLI's calls are typed by the table, and the wiring
// from edge to ticket to object runs end to end in workerd/cli-scoped-socket.test.ts.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { cliScopesConnectionTag, rejectOutOfScopeRpc } from '../src/cli/rpc-gate';
import {
  AGENT_RPC_ACCESS, extractTicketOrchestratorAgentName, requiredRpcAccess, rpcAccessScope,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

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

describe('a connect ticket names its workspace', () => {
  test('a ticket admits the root and one hosted actor beneath it; a `/sub/` hop names nothing', () => {
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
});

describe('outcome calibration and judging rows', () => {
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
