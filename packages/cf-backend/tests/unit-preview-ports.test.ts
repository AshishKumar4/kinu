import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  reconcilePreviewPorts,
  type ExecutorPortRefresh,
  type PinnedPreviewPort,
} from '../src/lib/preview-ports';
import { previewPortId, selectPreviewPort } from '../src/components/surfaces/OutputSurface';

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

  test('the hook rejects stale overlapping refresh completions', () => {
    const source = readFileSync(join(import.meta.dir, '../src/hooks/use-kinu.ts'), 'utf8');
    expect(source).toContain('const generation = ++exposedPortsRefreshGeneration.current;');
    expect(source).toContain('if (generation !== exposedPortsRefreshGeneration.current) return;');
    const resetAt = source.indexOf('setLoadGeneration(0);');
    expect(resetAt).toBeGreaterThan(0);
    expect(source.slice(resetAt - 160, resetAt)).toContain('++exposedPortsRefreshGeneration.current;');
  });
});

describe('preview selection', () => {
  test('keeps the same executor and port selected when a partial refresh reorders rows', () => {
    const workspace = port('workspace', 4173);
    const sandbox = port('sandbox', 8080);
    const activeId = previewPortId(workspace);

    expect(selectPreviewPort([sandbox, workspace], activeId)).toEqual(workspace);
  });

  test('falls back only when the selected preview is authoritatively absent', () => {
    const sandbox = port('sandbox', 8080);
    expect(selectPreviewPort([sandbox], 'workspace:4173')).toEqual(sandbox);
    expect(selectPreviewPort([], 'workspace:4173')).toBeNull();
  });
});
