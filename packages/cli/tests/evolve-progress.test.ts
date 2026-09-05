/**
 * `kinu evolve` progress rendering, driven through the command with a stub
 * search engine. An evolution cycle spends minutes inside runMCTS, so every
 * search event has to reach the terminal — and a branch that died on a
 * provider error has to say so, since the engine scores it 0 and carries on.
 *
 * The stub emits the same event shapes the engine produces; the assertions
 * below pin the WORDS on the terminal, through the command's own onProgress
 * wiring rather than the formatter's former export.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  AgentRuntime, ConvergenceResult, MCTSConfig, MCTSProgressEvent, SessionWriter,
} from '@kinu.run/core';
import { createCliAgent } from '../src/agent-create';
import { agentDir, AGENT_HOME, updateConfigFile } from '../src/config';
import { evolveCommand } from '../src/commands/evolve';

// Dummy provider config so requireLLMConfig succeeds offline — the stub
// engine below never calls a model.
const OFFLINE_PROVIDER = {
  baseUrl: 'http://localhost:0/v1',
  auth: 'Bearer evolve-progress',
  model: 'openai-compatible/evolve-progress-model',
};

// Same rule as conformance.test.ts: AGENT_HOME binds at module load, so only
// the preload-provided throwaway home may receive the agent this file creates.
if (resolve(AGENT_HOME) === resolve(join(homedir(), '.kinu'))
  || !resolve(AGENT_HOME).startsWith(resolve(tmpdir()))) {
  throw new Error(
    `evolve-progress suite refuses to run against a real Kinu home (${AGENT_HOME}). `
    + 'Run it as `bun test packages/cli/tests/evolve-progress.test.ts` from the repo root so '
    + 'scripts/test-preload.ts provides a throwaway KINU_HOME.',
  );
}

const AGENT_NAME = `evolve-progress-${Date.now()}`;

afterAll(() => {
  rmSync(agentDir(AGENT_NAME), { recursive: true, force: true });
  updateConfigFile((config) => {
    if (config.agents) delete config.agents[AGENT_NAME];
  });
});

/** The renderer colours for a terminal; these tests assert its WORDS. Stripping
 *  at the seam keeps them true in a pipe, a PTY and under FORCE_COLOR alike —
 *  the deploy runs in a terminal and every local run was a pipe, which is how
 *  a green suite hid a red deploy twice in one day. */
function plain(text: string): string {
  return Bun.stripANSI(text);
}

/** A search engine that emits one of every progress shape, then converges. */
async function stubEngine(
  _rt: AgentRuntime, _session: SessionWriter, _task: string, config: MCTSConfig,
): Promise<ConvergenceResult> {
  const emit = (event: MCTSProgressEvent) => config.onProgress?.(event);
  emit({ rootId: 'r1', type: 'phase', phase: 'explore', iteration: 1, remainingBudget: 2, branches: 3 });
  emit({ rootId: 'r1', type: 'phase', phase: 'evaluate', iteration: 1, remainingBudget: 1, branches: 1 });
  emit({ rootId: 'r1', type: 'phase', phase: 'reflect', iteration: 1, remainingBudget: 1, branches: 1 });
  emit({
    rootId: 'r1', type: 'branch-failed', stage: 'explore', iteration: 2,
    branchId: 'a1b2c3d4-e5f6g7h8', error: 'Failed after 3 attempts. Last error: 429 rate limited',
  });
  emit({ rootId: 'r1', type: 'iteration-complete', iteration: 1, remainingBudget: 1, scores: [0.82, 0] });
  emit({
    rootId: 'r1', type: 'grounding-unavailable', language: 'rust',
    canRun: ['javascript', 'python'], iteration: 2, remainingBudget: 1,
  });
  return { winnerId: 'w', winnerValue: 0.82, converged: true, trajectory: [] };
}
describe('evolve progress rendering', () => {
  test('every search event reaches the terminal through the command', async () => {
    await createCliAgent({ name: AGENT_NAME, mode: 'local', purpose: 'render progress', ...OFFLINE_PROVIDER });

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await evolveCommand(AGENT_NAME, { budget: '2', ...OFFLINE_PROVIDER }, { runMcts: stubEngine });
    } finally {
      console.log = originalLog;
    }
    const out = plain(lines.join('\n'));

    expect(out).toContain('[1/2]');
    expect(out).toContain('exploring 3 branches');
    expect(out).toContain('[1/2] evaluating 1 branch...');
    expect(out).toContain('[1/2] reflecting on 1 branch...');
    expect(out).toContain('a1b2c3d4-e5f6g7h8');
    expect(out).toContain('(explore)');
    expect(out).toContain('Failed after 3 attempts. Last error: 429 rate limited');
    expect(out).toContain('scores 0.82, 0.00');
    expect(out).toContain('cannot run rust');
    expect(out).toContain('runnable: javascript, python');
    expect(out).toContain('Converged');
  }, 60_000);
});
