// Behavior tests for AGENTS.md discovery — the nearest-file-wins walk-up
// chain (agents.md standard) feeding core's renderAgentsMdSection.
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverAgentsMd } from '../src/agents-md';

const roots: string[] = [];
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'proteus-agentsmd-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('discoverAgentsMd', () => {
  test('collects the walk-up chain ordered root-most first, nearest last', () => {
    const root = makeTree();
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    writeFileSync(join(root, 'packages', 'AGENTS.md'), 'packages rules');
    writeFileSync(join(nested, 'AGENTS.md'), 'app rules');

    const files = discoverAgentsMd(nested);
    const inTree = files.filter((f) => f.path.startsWith(root));
    expect(inTree.map((f) => f.content)).toEqual(['root rules', 'packages rules', 'app rules']);
    expect(inTree[2]!.path).toBe(join(nested, 'AGENTS.md'));
  });

  test('skips levels without a file and whitespace-only files', () => {
    const root = makeTree();
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'only root');
    writeFileSync(join(root, 'a', 'AGENTS.md'), '   \n');

    const files = discoverAgentsMd(nested).filter((f) => f.path.startsWith(root));
    expect(files.map((f) => f.content)).toEqual(['only root']);
  });

  test('returns an empty chain when no AGENTS.md exists anywhere up the tree', () => {
    const root = makeTree();
    const files = discoverAgentsMd(root).filter((f) => f.path.startsWith(root));
    expect(files).toEqual([]);
  });
});
