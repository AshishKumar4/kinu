// Behavior tests for the AGENTS.md prompt block — one renderer, both backends
// feed it their discovered files (root-most first, nearest last).
import { describe, test, expect } from 'bun:test';
import { createMemoryVfs, createTestRuntime } from '@kinu/test-utils';
import {
  buildSystemPromptSync, collectWorkspaceAgentsMd, renderAgentsMdSection,
} from '../src/index';
import type { VFS } from '../src/types/primitives';
import type { ExecutorProvider, ExecutorStatus } from '../src/execution/types';

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

interface FakeVfs {
  vfs: VFS;
  /** Paths the plane was asked to exist-check — the discovery probe itself. */
  probes: string[];
  reads: string[];
}

function fakeVfs(files: Readonly<Record<string, string>>): FakeVfs {
  const memory = createMemoryVfs();
  for (const [path, content] of Object.entries(files)) memory.files.set(path, content);
  const probes: string[] = [];
  const reads: string[] = [];
  return {
    vfs: {
      ...memory.vfs,
      exists: async (path) => {
        probes.push(path);
        return memory.vfs.exists(path);
      },
      readFile: async (path, opts) => {
        reads.push(path);
        return memory.vfs.readFile(path, opts);
      },
    },
    probes,
    reads,
  };
}

function fakeSandbox(opts: { active: boolean; files?: VFS }): ExecutorProvider {
  const status: ExecutorStatus = {
    configured: true, available: true, active: opts.active,
    status: opts.active ? 'active' : 'idle',
  };
  const provider: ExecutorProvider = {
    name: 'sandbox', kind: 'sandbox', capabilities: new Set(),
    files: opts.files,
    homeDir: async () => '/workspace',
    isAvailable: () => true,
    getStatus: () => status,
    connect: async () => {}, disconnect: async () => {},
    tools: {},
  };
  return provider;
}

describe('collectWorkspaceAgentsMd — cloud discovery', () => {
  test('reads canonical and active sandbox instructions from their own file planes', async () => {
    const workspace = fakeVfs({
      'AGENTS.md': 'workspace defaults',
      '/workspace/AGENTS.md': 'must not be treated as a parent mount',
      '/sandbox/workspace/AGENTS.md': 'must not be treated as sandbox bytes',
    });
    const sandbox = fakeVfs({ '/workspace/AGENTS.md': 'sandbox project rules' });
    const files = await collectWorkspaceAgentsMd(
      workspace.vfs,
      fakeSandbox({ active: true, files: sandbox.vfs }),
    );
    expect(files.map((f) => f.content)).toEqual(['workspace defaults', 'sandbox project rules']);
    expect(files.map((f) => f.path)).toEqual([
      'AGENTS.md (workspace)',
      '/workspace/AGENTS.md (sandbox)',
    ]);
    expect(workspace.reads).toEqual(['AGENTS.md']);
    expect(sandbox.reads).toEqual(['/workspace/AGENTS.md']);
  });

  test('never touches an inactive sandbox file plane', async () => {
    const workspace = fakeVfs({});
    const sandbox = fakeVfs({ '/workspace/AGENTS.md': 'should be ignored' });
    const files = await collectWorkspaceAgentsMd(
      workspace.vfs,
      fakeSandbox({ active: false, files: sandbox.vfs }),
    );
    expect(files).toEqual([]);
    // The canonical plane is still consulted; the idle sandbox is not asked
    // anything at all, so discovery can never be what provisions a container.
    expect(workspace.probes).toEqual(['AGENTS.md']);
    expect(workspace.reads).toEqual([]);
    expect(sandbox.probes).toEqual([]);
    expect(sandbox.reads).toEqual([]);
  });

  test('a missing or unreadable sandbox file falls back to defaults', async () => {
    const workspace = fakeVfs({ 'AGENTS.md': 'defaults' });
    const sandbox = fakeVfs({});
    const files = await collectWorkspaceAgentsMd(
      workspace.vfs,
      fakeSandbox({ active: true, files: sandbox.vfs }),
    );
    expect(files.map((f) => f.content)).toEqual(['defaults']);
  });

  test('works with no sandbox provider at all', async () => {
    const files = await collectWorkspaceAgentsMd(fakeVfs({ 'AGENTS.md': 'defaults' }).vfs);
    expect(files.map((f) => f.content)).toEqual(['defaults']);
  });
});
