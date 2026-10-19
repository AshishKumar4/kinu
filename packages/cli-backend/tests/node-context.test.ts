/**
 * A swarm node on the CLI works over its own `vfs://context`, whichever way it reaches it: its programs' `workspace`
 * reads the same plane its file tool does, never the actor that seated it.
 */
import { expect, test } from 'bun:test';
import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import * as v from 'valibot';
import { codemodeSurface, HeadJournal, narrowToolSurface, toolsInWorkMode, type JsonValue, type WebSearchProvider } from '@kinu.run/core';
import { createRecordingLogger, present, toolExecute, unobservedSpend } from '@kinu.run/test-utils';
import { LocalAgentSession } from '../src/local-session';
import { hostedCodemodeTool } from '../src/head-runtime';
import { fakeModel, toolSequenceModel, workspaceRuntime } from './helpers/local-session';
import { getToolName, isToolUIPart } from 'ai';
import { runNodeAgent } from '../../core/src/strategy/node-agent';

/** The node's program here reads a file; none reaches the web. */
const UNREACHED_WEB: WebSearchProvider = {
  search: async () => { throw new Error('this flow reaches no web'); },
  fetch: async () => { throw new Error('this flow reaches no web'); },
  render: async () => { throw new Error('this flow reaches no web'); },
  screenshot: async () => { throw new Error('this flow reaches no web'); },
};

const WORKING = 'vfs://context/working.jsonl';

/** Whose context a working document is: the actor its header names. */
const ownerOf = (document: JsonValue): string => v.parse(
  v.object({ $context: v.object({ actor: v.string() }) }),
  JSON.parse(v.parse(v.string(), document).split('\n')[0] ?? ''),
).$context.actor;

test("a swarm node's program reads its own context, as its file tool does, not its source's", async () => {
  const { db, rt } = workspaceRuntime();
  const session = new LocalAgentSession({ rt, db, model: fakeModel('answered'), onEvent: () => {} });

  try {
    const seat = await session.hostNode({ nodeId: 'context-node', rootId: 'context-swarm', depth: 1 });
    const node = seat.actor.runtime;

    const nodeEval = present(toolsInWorkMode('build', {
      eval: hostedCodemodeTool(seat.actor, UNREACHED_WEB)(codemodeSurface(node, {}, undefined, { ledgers: seat.actor.session.orchestrator.acc.ledgers }), narrowToolSurface(undefined)),
    }).eval, "the node's eval");

    const program = await toolExecute<{ code: string }, { result: JsonValue }>(nodeEval)({ code: `return await workspace.fs.text(${JSON.stringify(WORKING)});` });

    expect({
      program: ownerOf(program.result),
      fileTool: ownerOf(await readText(node.toolFiles, WORKING)),
      source: ownerOf(await readText(rt.toolFiles, WORKING)),
    }).toEqual({ program: node.actor.actorId, fileTool: node.actor.actorId, source: rt.actor.actorId });
  } finally {
    await session.end();
    db.close();
  }
});

test('a node program keeps its admitted namespaces and kind tool, sharing file reads and edits with native calls', async () => {
  const { db, rt } = workspaceRuntime();
  await writeText(rt.storage.vfs, 'node-from-native.txt', 'first native\n');
  await writeText(rt.storage.vfs, 'node-from-program.txt', 'first program\n');

  const model = toolSequenceModel([
    { name: 'file', input: { op: 'read', path: 'node-from-native.txt' } },
    { name: 'eval', input: { code: [
      'await file.edit("node-from-native.txt", [{ old_text: "first", new_text: "second" }]);',
      'return { memory: typeof memory, tasks: typeof tasks, agents: typeof agents,',
      'file: typeof file.text, web: typeof web.search, workspace: typeof workspace.fs.text, db: typeof db.select };',
    ].join('\n') } },
    { name: 'eval', input: { code: 'return await file.text("node-from-program.txt");' } },
    { name: 'file', input: { op: 'edit', path: 'node-from-program.txt', edits: [{ old_text: 'first', new_text: 'second' }] } },
    { name: 'eval', input: { code: 'return await tools.report({ status: "completed", content: "node-kind-report" });' } },
  ]);

  const session = new LocalAgentSession({ rt, db, model, onEvent: () => {} });
  const journal = new HeadJournal(rt.storage.sql, rt.actor);

  try {
    const run = await runNodeAgent({
      nodeId: 'admitted-node', rootId: 'admitted-swarm', parentId: null, depth: 1,
      task: 'check the program surface', rationale: 'exercise the admitted tools', base: 'Run the fixture steps.',
      messages: [{ role: 'user', content: 'Run the fixture steps.' }], inherited: [], context: 'fresh', mode: 'build', settle: 'best', arbitrate: null,
    }, {
      hostNode: (node) => session.hostNode(node), journal, logger: createRecordingLogger(), reportModelCall: unobservedSpend,
      nodeCodemode: (actor) => hostedCodemodeTool(actor, UNREACHED_WEB), webSearch: UNREACHED_WEB,
    });

    const outputs = journal.readSteps('admitted-node').flatMap((step) => step.parts.filter(isToolUIPart))
      .filter((part) => getToolName(part) === 'eval').map((part) => part.state === 'output-available' ? part.output : null);

    expect(outputs[0]).toMatchObject({ result: {
      memory: 'undefined', tasks: 'undefined', agents: 'undefined',
      file: 'function', web: 'function', workspace: 'function', db: 'function',
    } });
    expect(outputs.at(-1)).toMatchObject({ result: { received: true } });
    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toBe('node-kind-report');
    expect(await readText(rt.storage.vfs, 'node-from-native.txt')).toBe('second native\n');
    expect(await readText(rt.storage.vfs, 'node-from-program.txt')).toBe('second program\n');
  } finally {
    await session.end();
    db.close();
  }
});
