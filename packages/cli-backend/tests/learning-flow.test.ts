/**
 * Learning on the CLI across a restart: a tool input its schema refuses is a struggle the turn learns from as it
 * completes (docs/EVOLUTION-REDESIGN.md §2), before any reply rates it; the process ends, a new one opens the same
 * workspace from disk, and its next turn is shown the lesson and keeps the revision it saw.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { initWorkspaceSchema } from '@kinu.run/core';
import { present, scratchDir, scratchPath, workspaceDatabase } from '@kinu.run/test-utils';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession } from '../src/local-session';
import { staticModelPlane } from '../src/profile-authority';
import { DUMMY_LLM, fakeModel, swarmsOn, toolSequenceModel, type PromptMessage } from './helpers/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const LESSON = 'Name `path` in every file read.';

/** The turns' scripted calls; the fast tier's reflection, asked for a lesson, answers one. */
function struggler(prompts: string[]) {
  const turn = toolSequenceModel([{ name: 'file', input: { op: 'read' } }], (options) => { prompts.push(JSON.stringify(options.prompt)); });
  const lesson = fakeModel(JSON.stringify({ update: null, text: LESSON }));
  const asksForLesson = (prompt: readonly PromptMessage[]) => JSON.stringify(prompt).includes('spared this turn the struggle');

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: (options) => (asksForLesson(options.prompt) ? lesson : turn).doGenerate(options),
    doStream: (options) => (asksForLesson(options.prompt) ? lesson : turn).doStream(options),
  });
}

/** The workspace at `path` as a process opens it. */
function opened(path: string, cwd: string) {
  const db = workspaceDatabase(path);
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));

  return { db, rt: createCLIRuntime(db, { cwd, llm: DUMMY_LLM }) };
}

test('a schema-refused call is learned before any reply rates it, and the next process\'s turn is shown the lesson', async () => {
  const path = scratchPath('learning-flow', 'agent.db');
  const cwd = scratchDir('learning-flow-folder');
  const prompts: string[] = [];
  const model = struggler(prompts);

  const first = opened(path, cwd);
  first.rt.actor.config.setLearning(true);
  const session = new LocalAgentSession({ ...first, model, onEvent: () => {} });

  // The process ends on this turn: no reply will ever rate it.
  await session.send('read the README', { id: crypto.randomUUID() });
  await session.end();
  first.db.close();

  const next = opened(path, cwd);

  expect(next.db.query<{ struggles: string }, []>('SELECT struggles FROM turn_struggles').all().map((row) => JSON.parse(row.struggles)))
    .toEqual([[expect.objectContaining({ kind: 'schema_refusal', tool: 'file' })]]);
  expect(next.db.query<{ tool: string; text: string }, []>('SELECT tool, text FROM tool_lessons').all()).toEqual([{ tool: 'file', text: LESSON }]);

  const restarted = new LocalAgentSession({ ...next, model, onEvent: () => {}, profileAuthority: swarmsOn(next.rt, staticModelPlane()) });
  await restarted.send('now the CHANGELOG', { id: crypto.randomUUID() });
  await restarted.end();

  expect(prompts.at(-1)).toContain(LESSON);

  const shown = next.db.query<{ turn: string }, []>('SELECT turn FROM completed_turns ORDER BY created_at').all()
    .map((row) => v.parse(v.object({ shownLessons: v.optional(v.array(v.object({ id: v.string(), revision: v.number() }))) }), JSON.parse(row.turn)).shownLessons);

  const lesson = present(next.db.query<{ id: string }, []>('SELECT id FROM tool_lessons').get(), 'the persisted lesson');

  expect(shown.at(-1)).toEqual([{ id: lesson.id, revision: 1 }]);
  next.db.close();
});
