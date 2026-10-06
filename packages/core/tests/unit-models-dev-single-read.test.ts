// A model listing asks every provider at once; on a cold cache they share one read of models.dev's catalog
// (about 1.5 MB of JSON, parsed and checked) instead of one each.
import { describe, expect, test } from 'bun:test';
import { asFetchFunction } from '../src/index';
import { listModelsDevProviderModels } from '../src/providers/models-dev';

/** One event-loop turn, with no duration. */
async function oneTurn(): Promise<void> {
  const turn = Promise.withResolvers<void>();
  setImmediate(turn.resolve);
  await turn.promise;
}

const CATALOG = {
  anthropic: { id: 'anthropic', name: 'Anthropic', models: { 'claude-x': { id: 'claude-x', name: 'Claude X', tool_call: true } } },
  openai: { id: 'openai', name: 'OpenAI', api: 'https://api.openai.com/v1', models: { 'gpt-x': { id: 'gpt-x', name: 'GPT X', tool_call: true } } },
};

describe('models.dev on a cold cache', () => {
  test('providers listing together read the catalog once', async () => {
    let reads = 0;

    const fetchFn = asFetchFunction(async () => {
      reads += 1;

      // Long enough for the other listing to reach models.dev if it would.
      for (let turn = 0; turn < 20; turn += 1) await oneTurn();

      return Response.json(CATALOG);
    });

    const [anthropic, openai] = await Promise.all([
      listModelsDevProviderModels('anthropic', { fetch: fetchFn }),
      listModelsDevProviderModels('openai', { fetch: fetchFn }),
    ]);

    expect(anthropic.map((model) => model.id)).toEqual(['claude-x']);
    expect(openai.map((model) => model.id)).toEqual(['gpt-x']);
    expect(reads).toBe(1);
  });

  test('a failed read is not shared with the next listing', async () => {
    let reads = 0;

    const fetchFn = asFetchFunction(async () => {
      reads += 1;

      return reads === 1 ? new Response('busy', { status: 503 }) : Response.json(CATALOG);
    });

    await expect(listModelsDevProviderModels('openai', { fetch: fetchFn })).rejects.toThrow('models.dev');
    expect((await listModelsDevProviderModels('openai', { fetch: fetchFn })).map((model) => model.id)).toEqual(['gpt-x']);
    expect(reads).toBe(2);
  });
});
