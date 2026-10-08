import { readText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Each delegated turn is its own turn to the effect ledger. A provider may number tool calls per response (`call_0`,
 * the positional ids `tool-call-id.ts` exists for), so two turns of one durable hire can make the same call under the
 * same id; keyed by the actor, the second turn read back the first turn's result and its effect never ran
 * (kinu-logs/onstart/DESIGN.md, S2 turn identity).
 */
import { expect, test } from 'bun:test';
import { MEMORY_PATH, parseMemoryNotes, WORKSPACE_ROOT } from '@kinu.run/core';
import { gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const NOTE = 'the release train leaves on thursdays';

test('two turns of one hire making the same call under a reused call id each run it', async () => {
  // Each turn's first response saves the note under `call_0`; the response after a tool result answers.
  const gateway = stubAiBinding((run) => {
    const last = requestOf(run).messages.at(-1);

    return last?.role === 'tool'
      ? chatCompletion(run, 'saved')
      : toolCallCompletion(run, { tool: 'memory', args: { op: 'note', content: NOTE } }, 'call_0');
  });

  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'note-keeper', displayName: 'Note keeper', nameOrigin: 'user', mission: 'keep notes',
  });

  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Save the note.');
  await runDelegatedTask(workspace, child.actor.handle.actorId, 'Save the note again.');

  // Memory is the workspace's, kept in main's home whoever saves it.
  const memory = await readText(child.actor.runtime.storage.vfs, `${WORKSPACE_ROOT}/${MEMORY_PATH}`);
  const notes = parseMemoryNotes(String(memory)).filter((note) => note.content === NOTE);

  expect(notes).toHaveLength(2);
});
