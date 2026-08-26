// Regression tests for the scaffold-proposal contract.
//
// The proposal prompt used to instruct "Use only rt.* methods (rt.llm,
// rt.memory, rt.executor, rt.schedule)" — a phantom API: the executor passes
// the task STRING as `rt` and exposes only the `host.*` bridge, so every
// proposal written against those instructions crashed in shadow eval. These
// tests pin the prompt to the real contract and prove a proposal written
// against the documented API survives the executor's smoke path.
import { describe, test, expect } from 'bun:test';
import { buildScaffoldProposalPrompt, EvolutionEngine } from '../src/evolution/engine';
import { recordLesson } from '../src/evolution/outcomes';
import { renderScaffoldHandbook } from '../src/evolution/scaffold-handbook';
import { modifyScaffold } from '../src/scaffold/modify';
import { initScaffoldTables } from '../src/scaffold/schemas';
import { readScaffoldVersion } from '../src/scaffold/shadow';
import { runScaffold, SCAFFOLD_HOST_TYPES, type ScaffoldEvent } from '../src/scaffold/executor';
import { createEvalExecutor, createTestRuntime } from './helpers';

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
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    rt.executor = createEvalExecutor();

    // Gates 1-4: structural, parse, version checkpoint, versioned write.
    const mod = await modifyScaffold(
      rt,
      'Session reflection: stream the LLM answer directly and journal each handled task to memory.',
      CONTRACT_PROPOSAL,
    );
    expect(mod.ok).toBe(true);

    // Shadow-eval smoke path: run the pending version exactly like auto-judge does.
    if (mod.version === undefined) throw new Error('expected pending scaffold version');
    const pendingCode = await readScaffoldVersion(rt, mod.version);
    expect(pendingCode).toBe(CONTRACT_PROPOSAL);
    if (!pendingCode) throw new Error('expected pending scaffold source');

    const events: ScaffoldEvent[] = [];
    const result = await runScaffold({
      rt,
      task: 'summarize the release notes',
      emit: (e) => { events.push(e); },
      llmStream: async function* () { yield 'the answer'; },
      scaffoldCodeOverride: pendingCode,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.doneEmitted).toBe(true);
    // The yielded chunk reached the client as a text_delta...
    const deltas = events.filter((event) => event.type === 'text_delta').map((event) => event.text);
    expect(deltas).toContain('the answer');
    // ...and host.appendMemory really bridged to rt.memory.
    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('scaffold handled: summarize the release notes');
  });
});

test('a prose-wrapped typescript fence stores only the scaffold source', async () => {
  const { rt } = createTestRuntime({
    llmResponses: {
      'Recent lessons': 'The loop re-reads files it already read.',
      'Return ONLY the JavaScript code': `Here is the revision:\n\n\`\`\`typescript\n${CONTRACT_PROPOSAL}\n\`\`\`\n\nDone.`,
    },
  });
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  rt.executor = createEvalExecutor();
  await rt.identity.scaffold.write(CONTRACT_PROPOSAL);
  const engine = new EvolutionEngine(rt, { lifetimeEvolutionInterval: 1000 });
  recordLesson(rt.storage.sql, {
    turnIds: ['t1'],
    text: 'The loop re-read the same file.',
    source: 'session_reflection',
    status: 'corroborated',
  });
  const turns = [1, 2, 3].map((number) => ({
    userMessage: 'rotate the staging keys',
    assistantResponse: 'a response with enough substance to be graded on',
    toolCalls: [],
    steps: 1,
    durationMs: 1000,
    feedback: null,
    hadError: number === 1,
    turnId: `t${number}`,
    sessionId: 'default',
    origin: 'user' as const,
  }));
  const window = {
    sessionId: 'test',
    turns,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
  };
  for (let index = 0; index < 3; index++) await engine.onSessionComplete(window);

  const pending = rt.storage.sql<{ version: number }>`
    SELECT version FROM scaffold_versions WHERE status = 'pending'`;
  expect(pending).toHaveLength(1);
  const pendingVersion = pending[0]?.version;
  if (pendingVersion === undefined) throw new Error('expected one pending scaffold version');
  expect(await readScaffoldVersion(rt, pendingVersion)).toBe(CONTRACT_PROPOSAL);
});
