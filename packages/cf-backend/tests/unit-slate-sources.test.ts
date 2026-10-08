import { expect, test } from 'bun:test';
import { AGENT_RPC_ACCESS, SLATE_READ_MODELS, requiredRpcAccess, routeSlateCall } from '@kinu.run/core';

const read = (method: string) => routeSlateCall({ id: 'reader', request: { path: ['reads', method], args: [], invocation: null }, chain: [] });

test('every read model a slate reaches requires only workspace.read', () => {
  for (const method of SLATE_READ_MODELS) {
    expect(read(method).route).toEqual({ kind: 'rpc', method });
    expect(requiredRpcAccess(method)).toBe('workspace.read');
  }
});

test('a slate\'s reads refuse side effects and privileged host operations', () => {
  for (const [method, access] of Object.entries(AGENT_RPC_ACCESS)) {
    if (access === 'workspace.read') continue;
    expect(() => read(method), method).toThrow(expect.objectContaining({ code: 'missing' }));
  }
});
