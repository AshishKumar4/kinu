// Behavior tests for the AGENTS.md prompt block — one renderer, both backends
// feed it their discovered files (root-most first, nearest last).
import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from '@proteus/test-utils';
import {
  buildSystemPromptSync, collectWorkspaceAgentsMd, renderAgentsMdSection,
} from '../src/index.ts';
import type { VFS } from '../src/types/primitives.js';
import type { ExecutorProvider, ExecutorStatus } from '../src/execution/types.js';

describe('renderAgentsMdSection', () => {
  test('renders a delimited block with provenance and precedence guidance', () => {
    const section = renderAgentsMdSection([
      { path: '/repo/AGENTS.md', content: 'Use bun for everything.' },
      { path: '/repo/pkg/AGENTS.md', content: 'This package uses vitest.' },
    ]);
    expect(section).toContain('## Project instructions (AGENTS.md)');
    expect(section).toMatch(/closest to the working directory wins/);
    // Root-most renders first, nearest last (later = higher precedence).
    expect(section.indexOf('/repo/AGENTS.md')).toBeLessThan(section.indexOf('/repo/pkg/AGENTS.md'));
    expect(section).toContain('Use bun for everything.');
    expect(section).toContain('This package uses vitest.');
  });

  test('returns nothing for empty input or whitespace-only files', () => {
    expect(renderAgentsMdSection([])).toBe('');
    expect(renderAgentsMdSection([{ path: 'AGENTS.md', content: '  \n ' }])).toBe('');
  });

  test('caps total size, truncating with a note', () => {
    const section = renderAgentsMdSection(
      [{ path: 'AGENTS.md', content: 'x'.repeat(5000) }],
      1000,
    );
    expect(section.length).toBeLessThan(1400);
    expect(section).toContain('[truncated: 4000 more chars in AGENTS.md]');
  });

  test('spends the cap nearest-first: the nearest file survives a giant root file', () => {
    const section = renderAgentsMdSection(
      [
        { path: '/root/AGENTS.md', content: 'R'.repeat(2000) },
        { path: '/root/nested/AGENTS.md', content: 'nearest instructions win' },
      ],
      1000,
    );
    // The nearest file is intact; the root file is truncated to the remainder.
    expect(section).toContain('nearest instructions win');
    expect(section).toContain('more chars in /root/AGENTS.md]');
    // Render order is still root-first.
    expect(section.indexOf('/root/AGENTS.md')).toBeLessThan(section.indexOf('/root/nested/AGENTS.md'));
  });

  test('omits a broader file outright when the leftover budget is useless', () => {
    const section = renderAgentsMdSection(
      [
        { path: '/root/AGENTS.md', content: 'R'.repeat(2000) },
        { path: '/root/nested/AGENTS.md', content: 'N'.repeat(950) },
      ],
      1000,
    );
    expect(section).toContain('N'.repeat(950));
    expect(section).not.toContain('RRRR');
    expect(section).toContain('omitted by the size cap: /root/AGENTS.md');
  });
});

describe('buildSystemPromptSync — agentsMd option', () => {
  test('injects the AGENTS.md block when files are supplied', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      agentsMd: [{ path: '/proj/AGENTS.md', content: 'Always run the linter.' }],
    });
    expect(prompt).toContain('## Project instructions (AGENTS.md)');
    expect(prompt).toContain('Always run the linter.');
  });

  test('renders no block when absent', () => {
    const { rt } = createTestRuntime();
    expect(buildSystemPromptSync(rt)).not.toContain('Project instructions (AGENTS.md)');
  });
});

function fakeVfs(files: Record<string, string>): VFS {
  return {
    readFile: async (path: string) => {
      if (path in files) return files[path]!;
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
  } as unknown as VFS;
}

/** Only `getStatus().active` matters now — the sandbox file is read through
 *  the composite VFS, never the provider's tools. */
function fakeSandbox(opts: { active: boolean }): ExecutorProvider {
  const status: ExecutorStatus = {
    configured: true, available: true, active: opts.active,
    status: opts.active ? 'active' : 'idle',
  };
  return {
    name: 'sandbox', kind: 'sandbox', capabilities: new Set(),
    isAvailable: () => true,
    getStatus: () => status,
    connect: async () => {}, disconnect: async () => {},
    tools: {},
  } as unknown as ExecutorProvider;
}

describe('collectWorkspaceAgentsMd — cloud discovery', () => {
  test('reads the VFS root file and the active sandbox workspace, nearest last', async () => {
    const files = await collectWorkspaceAgentsMd(
      fakeVfs({
        'AGENTS.md': 'workspace defaults',
        '/sandbox/workspace/AGENTS.md': 'sandbox project rules',
      }),
      fakeSandbox({ active: true }),
    );
    expect(files.map((f) => f.content)).toEqual(['workspace defaults', 'sandbox project rules']);
    expect(files[0]!.path).toContain('agent workspace');
    expect(files[1]!.path).toContain('sandbox');
  });

  test('never touches an inactive sandbox mount, even when its file exists', async () => {
    const files = await collectWorkspaceAgentsMd(
      fakeVfs({ '/sandbox/workspace/AGENTS.md': 'should be ignored' }),
      fakeSandbox({ active: false }),
    );
    expect(files).toEqual([]);
  });

  test('a missing or unreadable sandbox file falls back to defaults', async () => {
    // No /sandbox entry → the composite read throws; the tool-string parsing
    // that once let 'read error: …' masquerade as content is gone entirely.
    const files = await collectWorkspaceAgentsMd(
      fakeVfs({ 'AGENTS.md': 'defaults' }),
      fakeSandbox({ active: true }),
    );
    expect(files.map((f) => f.content)).toEqual(['defaults']);
  });

  test('works with no sandbox provider at all', async () => {
    const files = await collectWorkspaceAgentsMd(fakeVfs({ 'AGENTS.md': 'defaults' }));
    expect(files.map((f) => f.content)).toEqual(['defaults']);
  });
});
