/**
 * A swarm node on the CLI works over its own `vfs://context`, whichever way it reaches it: its programs' `workspace`
 * reads the same plane its file tool does, never the actor that seated it.
 */
import { expect, test } from 'bun:test';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import * as v from 'valibot';
import { codemodeSurface, narrowToolSurface, toolsInWorkMode, type JsonValue, type WebSearchProvider } from '@kinu.run/core';
import { present, toolExecute } from '@kinu.run/test-utils';
import { LocalAgentSession } from '../src/local-session';
import { hostedCodemodeTool } from '../src/head-runtime';
import { fakeModel, workspaceRuntime } from './helpers/local-session';

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
      eval: hostedCodemodeTool(seat.actor, UNREACHED_WEB, () => seat.actor.session.orchestrator.acc)(codemodeSurface(node, {}), narrowToolSurface(undefined)),
    }).eval, "the node's eval");

    const program = await toolExecute<{ code: string }, { result: JsonValue }>(nodeEval)({ code: `return await workspace.readFile(${JSON.stringify(WORKING)});` });

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
