/**
 * Crafting on the CLI, through real turns over one workspace: tools made in a turn read and write its files and are
 * called at the next step, one that keeps raising is scored out before the turn ends, a swarm node's eval sees the
 * same workspace-wide tools and the same retirement, and with learning off a tool still works and nothing is scored.
 */
import { expect, test } from 'bun:test';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import * as v from 'valibot';
import { CRAFT_NEUTRAL_PRIOR, initWorkspaceSchema, narrowToolSurface, toolsInWorkMode, type JsonValue, type RunEvent } from '@kinu.run/core';
import { present, scratchDir, scratchPath, toolExecute, workspaceDatabase } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { hostedCodemodeTool } from '../src/head-runtime';
import { DUMMY_LLM } from './helpers/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

const REPORT = JSON.stringify({ testResults: [{ assertionResults: [
  { status: 'passed', duration: 2.5 },
  { status: 'failed', duration: 1.25 },
  { status: 'todo', duration: null },
] }] });

const TOTALS = `async (args) => {
  const rows = JSON.parse(await workspace.readFile(args.path)).testResults.flatMap((suite) => suite.assertionResults);
  const count = (status) => rows.filter((row) => row.status === status).length;
  return { total: rows.length, passed: count('passed'), failed: count('failed'), skipped: rows.length - count('passed') - count('failed'),
    durationMs: rows.reduce((sum, row) => sum + (row.duration ?? 0), 0) };
}`;

const WRITER = 'async (args) => { await workspace.writeFile(args.path, args.text); return await workspace.readFile(args.path); }';

const BROKEN = 'async () => { throw new Error("nope"); }';

const create = (name: string, body: string): string => `await workspace.createTool(${JSON.stringify(name)}, ${JSON.stringify(`${name} tool`)}, ${JSON.stringify(body)});`;

/** The eval programs each turn runs, by the words that open it; a turn answers once its programs are spent. */
const TURNS = {
  'Build the report tools.': [
    `await workspace.writeFile('reports/trial.json', ${JSON.stringify(REPORT)}); ${create('report_totals', TOTALS)} ${create('write_result', WRITER)} ${create('doubleIt', 'async (n) => n * 2')} return 'made';`,
    "return { totals: await tools.report_totals({ path: 'reports/trial.json' }), wrote: await tools.write_result({ path: 'reports/output.txt', text: 'saved' }), doubled: await tools.doubleIt(21) };",
    `${create('brokenIt', BROKEN)} return 'made';`,
    'return await tools.brokenIt();',
    'return await tools.brokenIt();',
    'return await tools.brokenIt();',
    'return await tools.brokenIt();',
    // Under the injection floor the sandbox no longer binds the tool, a different failure from it throwing.
    'return typeof tools.brokenIt;',
  ],
  'Triple it, with learning off.': [`${create('tripleIt', 'async (n) => n * 3')} return 'made';`, 'return await tools.tripleIt(7);'],
} satisfies Record<string, readonly string[]>;

const programsOf = new Map<string, readonly string[]>(Object.entries(TURNS));

function userText(prompt: LanguageModelV2Prompt): string[] {
  return prompt.flatMap((message) => (message.role === 'user' ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])) : []));
}

function crafting(): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async ({ prompt }) => {
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

test('a crafted tool is made, called, scored out, shared with a node, and still works with learning off', async () => {
  const db = workspaceDatabase(scratchPath('crafting-flow', 'agent.db'));
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('crafting-flow-folder'), llm: DUMMY_LLM });
  const events: SessionEvent[] = [];
  const session = new LocalAgentSession({ rt, db, model: crafting(), onEvent: (event) => events.push(event) });

  const results = (): string[] => events.flatMap((event) => (event.type === 'tool-result' ? [String(event.result)] : []));
  const score = (name: string) => db.query<{ score: number; uses: number }, [string]>('SELECT score, uses FROM crafted_tools WHERE name = ?').get(name);

  try {
    rt.actor.config.setLearning(true);
    await session.send('Build the report tools.', { id: crypto.randomUUID() });
    const built = results();

    expect(built).toHaveLength(8);
    expect(built[1]).toContain('"total":3');
    expect(built[1]).toContain('"durationMs":3.75');
    expect(built[1]).toContain('"wrote":"saved"');
    expect(built[1]).toContain('"doubled":42');
    expect(await readText(rt.storage.vfs, 'reports/output.txt')).toBe('saved');
    expect(built[3]).toContain('[crafted:brokenIt]');
    expect(built[7]).toContain('undefined');

    expect(present(score('doubleIt'), 'doubleIt').uses).toBe(1);
    expect(present(score('doubleIt'), 'doubleIt').score).toBeGreaterThan(CRAFT_NEUTRAL_PRIOR);
    expect(present(score('brokenIt'), 'brokenIt')).toMatchObject({ uses: 4 });
    expect(present(score('brokenIt'), 'brokenIt').score).toBeLessThan(0.2);

    const cycle = present(session.listRuns().items.flatMap((run) => session.getRunEvents(run.runId))
      .find((event): event is Extract<RunEvent, { type: 'craft_cycle' }> => event.type === 'craft_cycle'), 'the turn\'s craft_cycle row');

    expect([...cycle.crafted].sort()).toEqual(['brokenIt', 'doubleIt', 'report_totals', 'write_result']);
    expect(cycle.returned).toBe(3);
    expect(cycle.raised).toBe(4);
    expect(cycle.dropped).toEqual(['brokenIt']);

    // Crafted tools are the workspace's: a swarm node's eval calls main's, and main's scoring retired the same one there.
    const seat = await session.hostNode({ nodeId: 'crafting-node', rootId: 'crafting-swarm', depth: 1 });
    const nodeEval = present(toolsInWorkMode('build', { eval: hostedCodemodeTool(seat.actor, [])({}, narrowToolSurface(undefined)) }).eval, 'the node\'s eval');
    const node = await toolExecute<{ code: string }, { result: JsonValue }>(nodeEval)({ code: 'return [await tools.doubleIt(21), typeof tools.brokenIt];' });

    expect(node.result).toEqual([42, 'undefined']);

    // Crafting is a capability, not evolution: with learning off the tool runs and only its score stands still.
    rt.actor.config.setLearning(false);
    await session.send('Triple it, with learning off.', { id: crypto.randomUUID() });

    expect(results().at(-1)).toContain('21');
    expect(score('tripleIt')).toEqual({ score: CRAFT_NEUTRAL_PRIOR, uses: 0 });
    expect(v.parse(v.number(), present(score('doubleIt'), 'doubleIt').uses)).toBe(1);
  } finally {
    await session.end();
    db.close();
  }
});
