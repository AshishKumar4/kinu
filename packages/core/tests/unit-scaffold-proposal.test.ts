// Regression tests for the scaffold-proposal contract.
//
// The proposal prompt used to instruct "Use only rt.* methods (rt.llm,
// rt.memory, rt.executor, rt.schedule)" — a phantom API: the executor passes
// the task STRING as `rt` and exposes only the `host.*` bridge, so every
// proposal written against those instructions crashed in shadow eval. These
// tests pin the prompt to the real contract and prove a proposal written
// against the documented API survives the executor's smoke path.
import { describe, test, expect } from 'bun:test';
import { buildScaffoldProposalPrompt } from '../src/evolution/engine.js';
import { renderScaffoldHandbook } from '../src/evolution/scaffold-handbook.js';
import { modifyScaffold } from '../src/scaffold/modify.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { readScaffoldVersion } from '../src/scaffold/shadow.js';
import { runScaffold, SCAFFOLD_HOST_TYPES, type ScaffoldEvent } from '../src/scaffold/executor.js';
import type { Executor } from '../src/types/primitives.js';
import { createTestRuntime } from './helpers.js';

/**
 * An executor with DynamicWorkerExecutor's semantics: the code is statements
 * wrapped in an async IIFE, and each provider's fns are visible as a global
 * object named after the provider (host.*, workspace.*, ...).
 */
function evalExecutor(): Executor {
  return {
    async execute(code, providers) {
      const arr = providers as Array<{ name: string; fns: Record<string, (...args: unknown[]) => Promise<unknown>> }>;
      try {
        const fn = new Function(...arr.map((p) => p.name), `return (async () => {\n${code}\n})();`);
        const result = await fn(...arr.map((p) => p.fns));
        return { result };
      } catch (err) {
        return { result: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** A proposal that follows the prompt's documented contract to the letter. */
const CONTRACT_PROPOSAL = `\
async function* run(rt, task) {
  const text = await host.llmStream({
    system: 'You are the agent.',
    messages: [{ role: 'user', content: task }],
  });
  yield { type: 'chunk', data: text };
  await host.appendMemory('memory/MEMORY.md', 'scaffold handled: ' + task);
}`;

describe('buildScaffoldProposalPrompt — documents the real sandbox contract', () => {
  const prompt = buildScaffoldProposalPrompt('async function* run(rt, task) {}', 'be terser');

  test('does NOT advertise the phantom rt.* API', () => {
    expect(prompt).not.toMatch(/rt\.(llm|memory|executor|schedule)/);
  });

  test('documents the host.* bridge verbatim from the executor', () => {
    expect(prompt).toContain(SCAFFOLD_HOST_TYPES);
    expect(prompt).toContain('host');
  });

  test('documents the required signature and that both params are the task string', () => {
    expect(prompt).toContain('async function* run(rt, task)');
    expect(prompt).toMatch(/task STRING/);
  });

  test('leads with the behaviour→site handbook, indexed against the base scaffold', () => {
    expect(prompt.startsWith(renderScaffoldHandbook('async function* run(rt, task) {}'))).toBe(true);
    // …and it indexes the base being proposed against, not some other source.
    const withBridge = buildScaffoldProposalPrompt(
      'async function* run(rt, task) {\n  await host.llmStream({ system: "", messages: [] });\n}',
      'be terser',
    );
    expect(withBridge).toContain('run (generator, line 1) → host.llmStream()');
  });
});

describe('a proposal written against the documented API', () => {
  test('passes the 4-gate pipeline and survives the executor smoke path', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    (rt as { executor: Executor }).executor = evalExecutor();

    // Gates 1-4: structural, parse, version checkpoint, versioned write.
    const mod = await modifyScaffold(
      rt,
      'Session reflection: stream the LLM answer directly and journal each handled task to memory.',
      CONTRACT_PROPOSAL,
    );
    expect(mod.ok).toBe(true);

    // Shadow-eval smoke path: run the pending version exactly like auto-judge does.
    const pendingCode = await readScaffoldVersion(rt, mod.version!);
    expect(pendingCode).toBe(CONTRACT_PROPOSAL);

    const events: ScaffoldEvent[] = [];
    const result = await runScaffold({
      rt,
      task: 'summarize the release notes',
      emit: (e) => { events.push(e); },
      llmStream: async function* () { yield 'the answer'; },
      scaffoldCodeOverride: pendingCode!,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.doneEmitted).toBe(true);
    // The yielded chunk reached the client as a text_delta...
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text);
    expect(deltas).toContain('the answer');
    // ...and host.appendMemory really bridged to rt.memory.
    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('scaffold handled: summarize the release notes');
  });
});
