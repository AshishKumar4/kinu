import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { suggestWorkspaceTitle, workspaceTitlePrompt } from '../../core/src/identity/naming';
import { SLEEP_TIME_PROMPT_OPENING } from '../../core/src/utils/prompt-sections';
import { scriptedLongAnswer } from './workerd/long-model-script';

const CompletionSchema = v.object({ choices: v.tuple([v.object({ message: v.object({ content: v.string() }) })]) });

const askFor = (messages: readonly { role: string; content: string }[], stream: boolean): string => JSON.stringify({ model: 'probe-long', messages, stream });

describe('probe-long answers the lanes around its streamed turns in the shape each asked for', () => {
  test('the workspace title the product asks for as one completion is parsed by the product, not left to a stream', async () => {
    let contentType = '';

    const title = await suggestWorkspaceTitle(async (system, prompt) => {
      const answer = scriptedLongAnswer(askFor([{ role: 'system', content: system }, { role: 'user', content: prompt }], false));

      if (answer === null) throw new Error('probe-long left the title request to its streamed turn');
      contentType = answer.contentType;

      return v.parse(CompletionSchema, JSON.parse(answer.body)).choices[0].message.content;
    }, 'Keep the checkout service honest');

    expect(contentType).toBe('application/json');
    expect(title).not.toBeNull();
    expect(workspaceTitlePrompt('Keep the checkout service honest')).toContain('Keep the checkout service honest');
  });

  test('the background memory pass gets a no-change update as one completion', () => {
    const answer = scriptedLongAnswer(askFor([{ role: 'user', content: `${SLEEP_TIME_PROMPT_OPENING} Between user turns, review the transcript.` }], false));

    if (answer === null) throw new Error('probe-long left the memory pass to its streamed turn');
    const update = v.parse(v.object({ upserts: v.array(v.unknown()), decay: v.array(v.unknown()) }), JSON.parse(v.parse(CompletionSchema, JSON.parse(answer.body)).choices[0].message.content));

    expect(answer.contentType).toBe('application/json');
    expect([update.upserts, update.decay]).toEqual([[], []]);
  });

  test('a streamed turn is the probe\'s own, and a body the protocol cannot read is refused as a request error', () => {
    expect(scriptedLongAnswer(askFor([{ role: 'user', content: 'long:500' }], true))).toBeNull();
    expect(scriptedLongAnswer('not json')?.status).toBe(400);
  });
});
