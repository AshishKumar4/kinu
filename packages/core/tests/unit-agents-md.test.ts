// Behavior tests for the AGENTS.md prompt block — one admission policy and one
// renderer, both backends discover their files and feed them here (root-most
// first, nearest last). A file is admitted on its size before its bytes are
// asked for, so the tests below prove what was READ, not only what rendered.
import { describe, test, expect } from 'bun:test';
import { createMemoryVfs, createTestRuntime } from '@kinu.run/test-utils';
import {
  admitAgentsMd, buildSystemPromptSync, collectWorkspaceAgentsMd, renderAgentsMdSection,
  stepContextLimit, CHARS_PER_TOKEN,
  type InstructionTrustResolver, type ModelWindow,
} from '../src/index';
import type { VFS } from '../src/types/primitives';
import type { ExecutorProvider, ExecutorStatus } from '../src/execution/types';

/** A window whose answer reservation is its own declared maximum, so the
 *  instruction budget is the other half of it. */
const WINDOW: ModelWindow = { contextWindow: 800, modelOutputLimit: 400 };
/** Derived, never a literal: the same two facts the allocator is built from. */
const BUDGET = stepContextLimit(WINDOW) * CHARS_PER_TOKEN;
/** The owner's answer, stubbed both ways. Discovery asks per path and digest;
 *  these tests are about what was READ and how it renders, so each one states
 *  which answer it is standing on rather than reaching for a real store. */
const APPROVED: InstructionTrustResolver = () => 'approved';
const UNVERIFIED: InstructionTrustResolver = () => 'unverified';

describe('admitAgentsMd', () => {
  test('spends the budget nearest-first: a giant root file never crowds out the nearest one', () => {
    const root = { path: '/root/AGENTS.md', bytes: BUDGET };
    const nearest = { path: '/root/nested/AGENTS.md', bytes: 24 };
    const admission = admitAgentsMd([root, nearest], WINDOW);
    expect(admission.admit).toEqual([nearest]);
    expect(admission.referenced).toEqual([root]);
  });

  test('a broader file that still fits after the nearest one is admitted too', () => {
    const candidates = [
      { path: '/AGENTS.md', bytes: BUDGET / 4 },
      { path: '/pkg/AGENTS.md', bytes: BUDGET },
      { path: '/pkg/app/AGENTS.md', bytes: BUDGET / 4 },
    ];
    const admission = admitAgentsMd(candidates, WINDOW);
    // The middle file cannot fit beside the nearest one; the root file can, and
    // is not punished for being broader than the file that did not fit.
    expect(admission.admit.map((ref) => ref.path)).toEqual(['/AGENTS.md', '/pkg/app/AGENTS.md']);
    expect(admission.referenced.map((ref) => ref.path)).toEqual(['/pkg/AGENTS.md']);
  });

  test('every candidate is either admitted or referenced — none disappears', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      path: `/level${String(i)}/AGENTS.md`, bytes: 500,
    }));
    const admission = admitAgentsMd(candidates, WINDOW);
    expect([...admission.admit, ...admission.referenced].map((ref) => ref.path).sort())
      .toEqual(candidates.map((ref) => ref.path).sort());
  });

  test('the budget IS the model window: a wider window admits more, a bigger answer allowance admits less', () => {
    const chain = Array.from({ length: 12 }, (_, i) => ({
      path: `/level${String(i)}/AGENTS.md`, bytes: 400,
    }));
    const admitted = (limits: ModelWindow): number => admitAgentsMd(chain, limits).admit.length;
    const fits = (limits: ModelWindow): number =>
      Math.floor(stepContextLimit(limits) * CHARS_PER_TOKEN / 400);

    const narrow: ModelWindow = { contextWindow: 800, modelOutputLimit: 400 };
    const wide: ModelWindow = { contextWindow: 8_000, modelOutputLimit: 400 };
    const talkative: ModelWindow = { contextWindow: 800, modelOutputLimit: 100 };

    expect(admitted(wide)).toBeGreaterThan(admitted(narrow));
    // Same window, bigger answer reservation → less room for instructions.
    expect(admitted(narrow)).toBeLessThan(admitted(talkative));
    expect(admitted(narrow)).toBe(fits(narrow));
    expect(admitted(talkative)).toBe(fits(talkative));
  });
});

describe('renderAgentsMdSection', () => {
  test('renders a delimited block with provenance and precedence guidance', () => {
    const section = renderAgentsMdSection({
      admitted: [
        { path: '/repo/AGENTS.md', content: 'Use bun for everything.', trust: 'approved' },
        { path: '/repo/pkg/AGENTS.md', content: 'This package uses vitest.', trust: 'approved' },
      ],
      referenced: [],
    }, 'system');
    expect(section).toContain('## Project instructions (AGENTS.md)');
    expect(section).toMatch(/closest to the working directory wins/);
    // Root-most renders first, nearest last (later = higher precedence).
    expect(section.indexOf('/repo/AGENTS.md')).toBeLessThan(section.indexOf('/repo/pkg/AGENTS.md'));
    expect(section).toContain('Use bun for everything.');
    expect(section).toContain('This package uses vitest.');
  });

  test('returns nothing when nothing was discovered, or nothing has content', () => {
    expect(renderAgentsMdSection({ admitted: [], referenced: [] }, 'system')).toBe('');
    expect(renderAgentsMdSection({
      admitted: [{ path: 'AGENTS.md', content: '  \n ', trust: 'approved' }], referenced: [],
    }, 'system')).toBe('');
  });

  test('names a referenced file with its size instead of clipping it', () => {
    const section = renderAgentsMdSection({
      admitted: [
        { path: '/repo/pkg/AGENTS.md', content: 'nearest instructions win', trust: 'approved' },
      ],
      referenced: [{ path: '/repo/AGENTS.md', bytes: 5_242_880 }],
    }, 'system');
    expect(section).toContain('nearest instructions win');
    expect(section).toContain('/repo/AGENTS.md (5242880 bytes)');
    expect(section).toMatch(/file tool/);
    expect(section).not.toContain('truncated');
  });

  test('a section of nothing but references still reports them', () => {
    const section = renderAgentsMdSection({
      admitted: [], referenced: [{ path: '/repo/AGENTS.md', bytes: 900_000 }],
    }, 'system');
    expect(section).toContain('## Project instructions (AGENTS.md)');
    expect(section).toContain('/repo/AGENTS.md (900000 bytes)');
  });
});

describe('buildSystemPromptSync — agentsMd option', () => {
  test('injects the AGENTS.md block when files are supplied', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      agentsMd: {
        admitted: [
          { path: '/proj/AGENTS.md', content: 'Always run the linter.', trust: 'approved' },
        ],
        referenced: [],
      },
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
  /** Paths the plane was asked to size — the discovery probe itself. */
  stats: string[];
  reads: string[];
}

function fakeVfs(files: Readonly<Record<string, string>>): FakeVfs {
  const memory = createMemoryVfs();
  for (const [path, content] of Object.entries(files)) memory.files.set(path, content);
  const stats: string[] = [];
  const reads: string[] = [];
  return {
    vfs: {
      ...memory.vfs,
      stat: async (path) => {
        stats.push(path);
        return memory.vfs.stat(path);
      },
      readFile: async (path, opts) => {
        reads.push(path);
        return memory.vfs.readFile(path, opts);
      },
    },
    stats,
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
    const sources = await collectWorkspaceAgentsMd(
      workspace.vfs,
      WINDOW,
      APPROVED,
      fakeSandbox({ active: true, files: sandbox.vfs }),
    );
    expect(sources.admitted.map((f) => f.content)).toEqual(['workspace defaults', 'sandbox project rules']);
    expect(sources.admitted.map((f) => f.path)).toEqual([
      'AGENTS.md (workspace)',
      '/workspace/AGENTS.md (sandbox)',
    ]);
    expect(sources.referenced).toEqual([]);
    expect(workspace.reads).toEqual(['AGENTS.md']);
    expect(sandbox.reads).toEqual(['/workspace/AGENTS.md']);
  });

  test('a file that fits is sized once and read once, and renders whole', async () => {
    const workspace = fakeVfs({ 'AGENTS.md': 'Use bun for everything.' });
    const sources = await collectWorkspaceAgentsMd(workspace.vfs, WINDOW, APPROVED);
    expect(workspace.stats).toEqual(['AGENTS.md']);
    expect(workspace.reads).toEqual(['AGENTS.md']);
    expect(renderAgentsMdSection(sources, 'system')).toContain('Use bun for everything.');
  });

  test('an oversized AGENTS.md is sized, never read, and rendered as a sized reference', async () => {
    const oversized = 'B'.repeat(BUDGET + 1);
    const workspace = fakeVfs({ 'AGENTS.md': oversized });
    const sources = await collectWorkspaceAgentsMd(workspace.vfs, WINDOW, APPROVED);

    expect(workspace.stats).toEqual(['AGENTS.md']);
    expect(workspace.reads).toEqual([]);
    expect(sources.admitted).toEqual([]);
    expect(sources.referenced).toEqual([
      { path: 'AGENTS.md (workspace)', bytes: oversized.length },
    ]);

    const section = renderAgentsMdSection(sources, 'system');
    expect(section).toContain('AGENTS.md (workspace)');
    expect(section).toContain(`${oversized.length} bytes`);
    expect(section).not.toContain('BBBB');
  });

  test('a giant workspace file is referenced while the nearer sandbox file is read', async () => {
    const workspace = fakeVfs({ 'AGENTS.md': 'W'.repeat(BUDGET) });
    const sandbox = fakeVfs({ '/workspace/AGENTS.md': 'sandbox project rules' });
    const sources = await collectWorkspaceAgentsMd(
      workspace.vfs,
      WINDOW,
      APPROVED,
      fakeSandbox({ active: true, files: sandbox.vfs }),
    );
    expect(workspace.reads).toEqual([]);
    expect(sandbox.reads).toEqual(['/workspace/AGENTS.md']);
    expect(sources.admitted.map((f) => f.content)).toEqual(['sandbox project rules']);
    expect(sources.referenced.map((ref) => ref.path)).toEqual(['AGENTS.md (workspace)']);
  });

  test('never touches an inactive sandbox file plane', async () => {
    const workspace = fakeVfs({});
    const sandbox = fakeVfs({ '/workspace/AGENTS.md': 'should be ignored' });
    const sources = await collectWorkspaceAgentsMd(
      workspace.vfs,
      WINDOW,
      APPROVED,
      fakeSandbox({ active: false, files: sandbox.vfs }),
    );
    expect(sources).toEqual({ admitted: [], referenced: [] });
    // The canonical plane is still consulted; the idle sandbox is not asked
    // anything at all, so discovery can never be what provisions a container.
    expect(workspace.stats).toEqual(['AGENTS.md']);
    expect(workspace.reads).toEqual([]);
    expect(sandbox.stats).toEqual([]);
    expect(sandbox.reads).toEqual([]);
  });

  test('a missing sandbox file falls back to defaults', async () => {
    const workspace = fakeVfs({ 'AGENTS.md': 'defaults' });
    const sandbox = fakeVfs({});
    const sources = await collectWorkspaceAgentsMd(
      workspace.vfs,
      WINDOW,
      APPROVED,
      fakeSandbox({ active: true, files: sandbox.vfs }),
    );
    expect(sources.admitted.map((f) => f.content)).toEqual(['defaults']);
    expect(sandbox.reads).toEqual([]);
  });

  test('works with no sandbox provider at all', async () => {
    const sources = await collectWorkspaceAgentsMd(
      fakeVfs({ 'AGENTS.md': 'defaults' }).vfs, WINDOW, APPROVED,
    );
    expect(sources.admitted.map((f) => f.content)).toEqual(['defaults']);
  });

  test('the owner\'s answer rides with the bytes it was asked about', async () => {
    // Discovery does not decide placement, but it is what carries the decision:
    // the same read, unapproved, reaches the model as reference material only.
    const workspace = fakeVfs({ 'AGENTS.md': 'Use bun for everything.' });
    const sources = await collectWorkspaceAgentsMd(workspace.vfs, WINDOW, UNVERIFIED);
    expect(sources.admitted.map((f) => f.trust)).toEqual(['unverified']);
    expect(renderAgentsMdSection(sources, 'system')).toBe('');
    expect(renderAgentsMdSection(sources, 'unverified')).toContain('Use bun for everything.');
  });
});
