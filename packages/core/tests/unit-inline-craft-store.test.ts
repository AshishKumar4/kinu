/**
 * Defends: the inline runtime's crafted-tool store answered raw `crafted_tools` rows typed as tools
 * (snake_case timestamps, `params` as JSON text), so a reader of `tool.params` or `tool.createdAt` got a
 * string or nothing. It is now agent-utils' own CraftStore, the one both backends' stores are.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';
import { createInlineCraftStore } from '../src/identity/inline-primitives';
import { makeSql } from './helpers';

const WEATHER = {
  name: 'weather', description: 'look up the forecast for a city', params: { city: 'string' },
  code: 'return 1', scope: 'local',
} as const;

function stored() {
  const db = new Database(':memory:');
  initCraftedToolsTables(makeSql(db));
  const tools = createInlineCraftStore(db);
  tools.create({ ...WEATHER, params: { ...WEATHER.params } });

  return tools;
}

describe('the inline crafted-tool store', () => {
  test('a stored tool reads back as the tool that was written', () => {
    const read = stored().get('weather');

    expect(read).toMatchObject({ ...WEATHER });
    expect(read?.createdAt).toBeNumber();
    expect(read?.updatedAt).toBeNumber();
    expect(read).not.toHaveProperty('created_at');
  });

  test('list and search answer tools, not rows', () => {
    const tools = stored();

    expect(tools.list().map((tool) => tool.params)).toEqual([{ city: 'string' }]);
    expect(tools.search('forecast for a city').map((tool) => [tool.name, tool.params])).toEqual([['weather', { city: 'string' }]]);
  });

  test('a name nobody stored reads as absent', () => {
    expect(stored().get('nothing')).toBeUndefined();
  });
});
