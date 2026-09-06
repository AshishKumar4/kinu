import { expect, test } from 'bun:test';
import { SLATE_READ_MODELS, parseSlateProject } from '@kinu.run/core';
import { AGENT_RPC_ACCESS, requiredRpcAccess } from '../src/cli/rpc-gate';

test('every accepted Slate read model requires only workspace.read', () => {
  for (const method of SLATE_READ_MODELS) {
    parseSlateProject({
      main: 'server.ts', slate: { bindings: { DATA: { kind: 'rpc', methods: [method] } } },
    });
    expect(requiredRpcAccess(method)).toBe('workspace.read');
  }
});

test('Slate RPC declarations reject side effects and privileged host operations', () => {
  for (const [method, access] of Object.entries(AGENT_RPC_ACCESS)) {
    if (access === 'workspace.read') continue;
    expect(() => parseSlateProject({
      main: 'server.ts', slate: { bindings: { DATA: { kind: 'rpc', methods: [method] } } },
    })).toThrow();
  }
});
