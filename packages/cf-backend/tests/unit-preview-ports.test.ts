import { describe, expect, test } from 'bun:test';
import {
  reconcilePreviewPorts,
  type ExecutorPortRefresh,
  type PinnedPreviewPort,
} from '@kinu.run/core';

const acceptsUrl = (url: string) => url.startsWith('https://preview.example/');

function port(executor: string, number: number): PinnedPreviewPort {
  return { executor, port: number, url: `https://preview.example/${executor}/${number}` };
}

describe('preview port refresh reconciliation', () => {
  test('preserves the last known ports for a failed executor while accepting other results', () => {
    const refreshes: ExecutorPortRefresh[] = [
      { executor: 'workspace', result: { ports: [], error: 'Nimbus is temporarily unavailable' } },
      { executor: 'sandbox', result: { ports: [{ port: 4173, url: 'https://preview.example/sandbox/4173' }] } },
    ];

    expect(reconcilePreviewPorts([port('workspace', 8080)], refreshes, acceptsUrl)).toEqual({
      ports: [port('workspace', 8080), port('sandbox', 4173)],
      error: 'workspace: Nimbus is temporarily unavailable',
    });
  });

  test('a successful empty result removes only that executor\'s prior ports', () => {
    const previous = [port('workspace', 8080), port('sandbox', 4173)];

    const refreshes: ExecutorPortRefresh[] = [
      { executor: 'workspace', result: { ports: [] } },
      { executor: 'sandbox', result: { ports: [{ port: 4173, url: 'https://preview.example/sandbox/4173' }] } },
    ];

    expect(reconcilePreviewPorts(previous, refreshes, acceptsUrl)).toEqual({
      ports: [port('sandbox', 4173)],
      error: null,
    });
  });

  test('a malformed response cannot replace a previously validated preview', () => {
    const refreshes: ExecutorPortRefresh[] = [{
      executor: 'workspace',
      result: { ports: [{ port: 8080, url: 'https://evil.example/' }] },
    }];

    expect(reconcilePreviewPorts([port('workspace', 8080)], refreshes, acceptsUrl)).toEqual({
      ports: [port('workspace', 8080)],
      error: 'workspace: invalid preview registration for port 8080',
    });
  });
});


