/**
 * Crafting on the CLI, through real turns over one workspace: tools made in a turn read and write its files and are
 * called at the next step, one that keeps raising is marked broken and says so until the agent retires it, a swarm
 * node's eval sees the same workspace-wide tools and the same retirement, and with learning off a tool still works and
 * nothing is counted.
 */
import { expect, test } from 'bun:test';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { codemodeSurface, initWorkspaceSchema, narrowToolSurface, toolsInWorkMode, type JsonValue, type RunEvent, type WebSearchProvider } from '@kinu.run/core';
import { present, scratchDir, scratchPath, toolExecute, workspaceDatabase, servedStoresOf } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import type { SessionEvent } from '@kinu.run/core';
import { LocalAgentSession } from '../src/local-session';
import { hostedCodemodeTool } from '../src/head-runtime';
import { DUMMY_LLM } from './helpers/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

/** The node's programs here read files and call tools; none reaches the web. */
const UNREACHED_WEB: WebSearchProvider = {
  search: async () => { throw new Error('this flow reaches no web'); },
  fetch: async () => { throw new Error('this flow reaches no web'); },
  render: async () => { throw new Error('this flow reaches no web'); },
  screenshot: async () => { throw new Error('this flow reaches no web'); },
};

const REPORT = JSON.stringify({ testResults: [{ assertionResults: [
  { status: 'passed', duration: 2.5 },
  { status: 'failed', duration: 1.25 },
  { status: 'todo', duration: null },
] }] });

const TOTALS = `async (args) => {
  const rows = JSON.parse(await workspace.fs.text(args.path)).testResults.flatMap((suite) => suite.assertionResults);
  const count = (status) => rows.filter((row) => row.status === status).length;
  return { total: rows.length, passed: count('passed'), failed: count('failed'), skipped: rows.length - count('passed') - count('failed'),
    durationMs: rows.reduce((sum, row) => sum + (row.duration ?? 0), 0) };
}`;

const WRITER = 'async (args) => { await workspace.fs.write(args.path, args.text); return await workspace.fs.text(args.path); }';

const BROKEN = 'async () => { throw new Error("nope"); }';

/** A tool sent as its source text; `doubleIt` is sent as the function itself. */
const create = (name: string, body: string): string => `await workspace.createTool(${JSON.stringify(name)}, ${JSON.stringify(`${name} tool`)}, ${JSON.stringify(body)});`;

/** The eval programs each turn runs, by the words that open it; a turn answers once its programs are spent. */
const TURNS = {
  'Build the report tools.': [
    `await workspace.fs.write('reports/trial.json', ${JSON.stringify(REPORT)}); ${create('report_totals', TOTALS)} ${create('write_result', WRITER)} await workspace.createTool('doubleIt', 'doubleIt tool', async (n) => n * 2); return 'made';`,
    "return { totals: await tools.report_totals({ path: 'reports/trial.json' }), wrote: await tools.write_result({ path: 'reports/output.txt', text: 'saved' }), doubled: await tools.doubleIt(21) };",
    `${create('brokenIt', BROKEN)} return 'made';`,
    'return await tools.brokenIt();',
    'return await tools.brokenIt();',
    'return await tools.brokenIt();',
    'return await tools.brokenIt();',
    // A broken tool stays bound: its declaration says it is broken, and the agent decides.
    'return typeof tools.brokenIt;',
    "return await workspace.retireTool('brokenIt');",
    'return typeof tools.brokenIt;',
  ],
  'Triple it, with learning off.': [`${create('tripleIt', 'async (n) => n * 3')} return 'made';`, 'return await tools.tripleIt(7);'],
} satisfies Record<string, readonly string[]>;

const programsOf = new Map<string, readonly string[]>(Object.entries(TURNS));

function userText(prompt: LanguageModelV2Prompt): string[] {
  return prompt.flatMap((message) => (message.role === 'user' ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])) : []));
}

function crafting(prompts: string[] = []): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      const opened = prompt.map((message) => message.role === 'user' && userText([message]).some((text) => programsOf.has(text))).lastIndexOf(true);
      const key = userText(prompt.slice(opened, opened + 1)).find((text) => programsOf.has(text)) ?? '';
      const code = programsOf.get(key)?.[prompt.slice(opened).filter((message) => message.role === 'tool').length];

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (code === undefined) {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            } else {
              controller.enqueue({ type: 'tool-call', toolCallId: crypto.randomUUID(), toolName: 'eval', input: JSON.stringify({ code }) });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

test('a crafted tool is made, called, marked broken, retired, shared with a node, and still works with learning off', async () => {
  const db = workspaceDatabase(scratchPath('crafting-flow', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('crafting-flow-folder'), llm: DUMMY_LLM });
  const events: SessionEvent[] = [];
  const prompts: string[] = [];
  const session = new LocalAgentSession({ rt, db, model: crafting(prompts), onEvent: (event) => events.push(event) });

  const results = (): string[] => events.flatMap((event) => (event.type === 'tool-result' ? [String(event.result)] : []));
  const counts = (name: string) => db.query<{ offered: number; chosen: number; broken: string | null }, [string]>('SELECT offered, chosen, broken FROM crafted_tools WHERE name = ?').get(name);

  try {
    rt.actor.config.setLearning(true);
    await session.send('Build the report tools.', { id: crypto.randomUUID() });
    const built = results();

    expect(built).toHaveLength(10);
    expect(built[1]).toContain('"total":3');
    expect(built[1]).toContain('"durationMs":3.75');
    expect(built[1]).toContain('"wrote":"saved"');
    expect(built[1]).toContain('"doubled":42');
    expect(await readText(rt.storage.vfs, 'reports/output.txt')).toBe('saved');
    expect(built[3]).toContain('nope');
    expect(built[7]).toContain('function');
    expect(built[8]).toContain('retired');
    expect(built[9]).toContain('undefined');
    // The step after a raise read the tool's declaration with its error.
    expect(prompts.some((prompt) => prompt.includes('brokenIt tool Broken: its last call raised \\"nope\\"'))).toBe(true);

    // Recorded with its turn: offered from the step after it was made, and chosen.
    expect(counts('doubleIt')).toEqual({ offered: 1, chosen: 1, broken: null });
    expect(counts('brokenIt')).toBeNull();

    const cycle = present(session.listRuns().items.flatMap((run) => session.getRunEvents(run.runId))
      .find((event): event is Extract<RunEvent, { type: 'craft_cycle' }> => event.type === 'craft_cycle'), 'the turn\'s craft_cycle row');

    expect([...cycle.crafted].sort()).toEqual(['brokenIt', 'doubleIt', 'report_totals', 'write_result']);
    expect(cycle.returned).toBe(3);
    expect(cycle.raised).toBe(4);
    expect(cycle.broke).toEqual(['brokenIt']);

    // Crafted tools are the workspace's: a swarm node's eval calls main's, and the tool main retired is gone there too.
    const seat = await session.hostNode({ nodeId: 'crafting-node', rootId: 'crafting-swarm', depth: 1 });
    const nodeEval = present(toolsInWorkMode('build', { eval: hostedCodemodeTool(seat.actor, UNREACHED_WEB)(codemodeSurface(seat.actor.runtime, {}, () => ({}), { stores: servedStoresOf(seat.actor.runtime, seat.actor.stores.conversationSearch, seat.actor.session.orchestrator.acc.ledgers) }), narrowToolSurface(undefined)) }).eval, 'the node\'s eval');
    const node = await toolExecute<{ code: string }, { result: JsonValue }>(nodeEval)({ code: 'return [await tools.doubleIt(21), typeof tools.brokenIt];' });

    expect(node.result).toEqual([42, 'undefined']);

    // Crafting is a capability, not evolution: with learning off the tool runs and only its counts stand still.
    rt.actor.config.setLearning(false);
    await session.send('Triple it, with learning off.', { id: crypto.randomUUID() });

    expect(results().at(-1)).toContain('21');
    expect(counts('tripleIt')).toEqual({ offered: 0, chosen: 0, broken: null });
    expect(present(counts('doubleIt'), 'doubleIt').chosen).toBe(1);
  } finally {
    await session.end();
    db.close();
  }
});
