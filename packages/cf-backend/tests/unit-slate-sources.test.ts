import { expect, test } from 'bun:test';
import { AGENT_RPC_ACCESS, SLATE_READ_MODELS, parseSlateProject, requiredRpcAccess } from '@kinu.run/core';

test('every accepted Slate read model requires only workspace.read', () => {
  for (const method of SLATE_READ_MODELS) {
    parseSlateProject({
      main: 'server.ts', slate: { bindings: { DATA: { kind: 'rpc', methods: [method] } } },
    });
    expect(requiredRpcAccess(method)).toBe('workspace.read');
  }
});

test('Slate RPC declarations reject side effects and privileged host operations', async () => {
  const declare = async (method: string) => parseSlateProject({
    main: 'server.ts', slate: { bindings: { DATA: { kind: 'rpc', methods: [method] } } },
  });

  for (const [method, access] of Object.entries(AGENT_RPC_ACCESS)) {
    if (access === 'workspace.read') continue;
    await expect(declare(method)).rejects.toMatchObject({ code: 'bad_input' });
  }
});
