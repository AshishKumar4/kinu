/**
 * A tool input its schema refuses is a struggle the turn learns from as it completes (docs/EVOLUTION-REDESIGN.md §2),
 * through the real tool, steering and session path: a turn no reply has rated yet records its struggles and teaches
 * its lesson, and the next turn is shown it and keeps the revision it saw.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { TestLanguageModelV2 } from './test-language-model';
import { fakeModel, setup, swarmsOn, toolSequenceModel, type PromptMessage } from './helpers/local-session';
import { LocalAgentSession } from '../src/local-session';
import { staticModelPlane } from '../src/profile-authority';

const LESSON = 'Name `path` in every file read.';

/** The turns' scripted calls; the fast tier's reflection, asked for a lesson, answers one. */
function struggler(prompts: string[]) {
  const turn = toolSequenceModel([{ name: 'file', input: { action: 'read' } }], (options) => { prompts.push(JSON.stringify(options.prompt)); });
  const lesson = fakeModel(JSON.stringify({ update: null, text: LESSON }));
  const asksForLesson = (prompt: readonly PromptMessage[]) => JSON.stringify(prompt).includes('spared this turn the struggle');

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: (options) => (asksForLesson(options.prompt) ? lesson : turn).doGenerate(options),
    doStream: (options) => (asksForLesson(options.prompt) ? lesson : turn).doStream(options),
  });
}

test('a turn learns from its schema-refused file call before any reply rates it, and the next turn is shown the lesson', async () => {
  const prompts: string[] = [];
  const model = struggler(prompts);
  const { db, rt, session } = setup('unused', model, { noAutoEvolve: false });

  // The session ends on this turn: no reply will ever rate it.
  await session.send('read the README', { id: crypto.randomUUID() });
  await session.end();

  expect(db.query<{ struggles: string }, []>('SELECT struggles FROM turn_struggles').all().map((row) => JSON.parse(row.struggles)))
    .toEqual([[expect.objectContaining({ kind: 'schema_refusal', tool: 'file' })]]);
  expect(db.query<{ tool: string; text: string }, []>('SELECT tool, text FROM tool_lessons').all()).toEqual([{ tool: 'file', text: LESSON }]);

  const next = new LocalAgentSession({ rt, db, model, onEvent: () => {}, profileAuthority: swarmsOn(rt, staticModelPlane()) });
  await next.send('now the CHANGELOG', { id: crypto.randomUUID() });
  await next.end();

  expect(prompts.at(-1)).toContain(LESSON);

  const shown = db.query<{ turn: string }, []>('SELECT turn FROM completed_turns ORDER BY created_at').all()
    .map((row) => v.parse(v.object({ shownLessons: v.optional(v.array(v.object({ id: v.string(), revision: v.number() }))) }), JSON.parse(row.turn)).shownLessons);

  expect(shown.at(-1)).toEqual([{ id: expect.stringMatching(/^tl-/), revision: 1 }]);
});
