/**
 * `kinu evolve` progress through the command with a stub engine: every search event must reach the
 * terminal, and a branch killed by a provider error must say so (the engine scores it 0).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  AgentRuntime, ConvergenceResult, MCTSConfig, MCTSProgressEvent, SessionWriter,
} from '@kinu.run/core';
import { createCliAgent } from '../src/agent-create';
import { AGENT_HOME, agentDir, updateConfigFile } from '../src/config';
import { evolveCommand } from '../src/commands/evolve';

// Dummy provider config so requireLLMConfig succeeds offline.
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

// AGENT_HOME binds at module load, so each test rmSyncs the agent dirs it created.
const created: string[] = [];

afterEach(() => {
  for (const name of created.splice(0)) rmSync(agentDir(name), { recursive: true, force: true });
});

afterAll(async () => {
  await updateConfigFile((config) => {
    if (config.agents) delete config.agents[AGENT_NAME];
  });
});

// Captures are stripped at the seam so the words hold in a pipe, a PTY, or under FORCE_COLOR.

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
    created.push(AGENT_NAME);
    await createCliAgent({ name: AGENT_NAME, mode: 'local', purpose: 'render progress', ...OFFLINE_PROVIDER });

    const lines: string[] = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    // Both sinks: a pipe gets `console.log`, a terminal gets the live row on stdout, and `display.ts`
    // reads `isTTY` once at module load, so the suite cannot pick the mode.
    const capture: typeof process.stdout.write = (chunk) => {
      lines.push(chunk.toString());

      return true;
    };

    process.stdout.write = capture;

    try {
      await evolveCommand(AGENT_NAME, { budget: '2', ...OFFLINE_PROVIDER }, { runMcts: stubEngine });
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }

    const out = Bun.stripANSI(lines.join('\n'));

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
  });
});
