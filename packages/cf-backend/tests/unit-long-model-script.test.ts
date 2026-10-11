import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { suggestWorkspaceTitle, workspaceTitlePrompt } from '../../core/src/identity/naming';
import { drawWorkspaceLogo } from '../../core/src/identity/logo';
import { SLEEP_TIME_PROMPT_OPENING } from '../../core/src/utils/prompt-sections';
import { scriptedProbeAnswer } from './workerd/probe-model-script';
import { probeOutbound } from './workerd/http-model-fake';

const CompletionSchema = v.object({ choices: v.tuple([v.object({ message: v.object({ content: v.string() }) })]) });

const askFor = (messages: readonly { role: string; content: string }[], stream: boolean): string => JSON.stringify({ model: 'probe-long', messages, stream });

describe('probe-long answers the lanes around its streamed turns in the shape each asked for', () => {
  test.each(['probe-queue', 'probe-long'])('%s answers the actual nonstream logo request as a completion the product can draw', async (model) => {
    const logo = await drawWorkspaceLogo(async (system, prompt) => {
      const answer = await probeOutbound(new Request('http://fake-models.invalid/v1/chat/completions', {
        method: 'POST', body: JSON.stringify({ model, stream: false, messages: [
          { role: 'system', content: system }, { role: 'user', content: prompt },
        ] }),
      }));

      expect(answer.headers.get('content-type')).toBe('application/json');

      return v.parse(CompletionSchema, await answer.json()).choices[0].message.content;
    }, 'A checkout maintenance workspace');

    expect(logo).not.toBeNull();
  });

  test('probe-queue honours a nonstream request even when it is not a named auxiliary lane', async () => {
    const content = 'a unique request to answer in one completion';

    const answer = await probeOutbound(new Request('http://fake-models.invalid/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: 'probe-queue', stream: false, messages: [{ role: 'user', content }] }),
    }));

    expect(answer.headers.get('content-type')).toBe('application/json');
    expect(v.parse(CompletionSchema, await answer.json()).choices[0].message.content).toContain(content);
  });

  test('the workspace title the product asks for as one completion is parsed by the product, not left to a stream', async () => {
    let contentType = '';

    const title = await suggestWorkspaceTitle(async (system, prompt) => {
      const answer = scriptedProbeAnswer(askFor([{ role: 'system', content: system }, { role: 'user', content: prompt }], false));

      if (answer === null) throw new Error('probe-long left the title request to its streamed turn');
      contentType = answer.contentType;

      return v.parse(CompletionSchema, JSON.parse(answer.body)).choices[0].message.content;
    }, 'Keep the checkout service honest');

    expect(contentType).toBe('application/json');
    expect(title).not.toBeNull();
    expect(workspaceTitlePrompt('Keep the checkout service honest')).toContain('Keep the checkout service honest');
  });

  test('the background memory pass gets a no-change update as one completion', () => {
    const answer = scriptedProbeAnswer(askFor([{ role: 'user', content: `${SLEEP_TIME_PROMPT_OPENING} Between user turns, review the transcript.` }], false));

    if (answer === null) throw new Error('probe-long left the memory pass to its streamed turn');
    const update = v.parse(v.object({ upserts: v.array(v.unknown()), decay: v.array(v.unknown()) }), JSON.parse(v.parse(CompletionSchema, JSON.parse(answer.body)).choices[0].message.content));

    expect(answer.contentType).toBe('application/json');
    expect([update.upserts, update.decay]).toEqual([[], []]);
  });

  test('a streamed turn is the probe\'s own, and a body the protocol cannot read is refused as a request error', () => {
    expect(scriptedProbeAnswer(askFor([{ role: 'user', content: 'long:500' }], true))).toBeNull();
    expect(scriptedProbeAnswer('not json')?.status).toBe(400);
  });
});
