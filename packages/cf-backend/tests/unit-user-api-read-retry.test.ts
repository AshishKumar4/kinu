/**
 * A read whose connection dropped is asked once more; a write is not. Production, 2026-10-05 17:27Z: onboarding
 * showed "Could not load your connected models: Failed to fetch"; the Worker saw that GET cancelled by the client.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { asFetchFunction } from '@kinu.run/core';
import { listAvailableModels, touchWorkspace } from '../src/lib/user-api';

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** The connection drops under the first `drops` requests; later ones answer `answer`. */
function droppingConnection(drops: number, answer: () => Response): string[] {
  const asked: string[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    asked.push(`${init?.method ?? 'GET'} ${v.parse(v.string(), input)}`);

    if (asked.length <= drops) throw new TypeError('Failed to fetch');

    return answer();
  });

  return asked;
}

describe('a dropped connection', () => {
  test('a read is asked once more and answers', async () => {
    const asked = droppingConnection(1, () => Response.json({ models: [], failures: [] }));

    expect(await listAvailableModels()).toEqual({ models: [], failures: [] });
    expect(asked).toEqual(['GET /api/user/models', 'GET /api/user/models']);
  });

  test('a read that drops twice reports the drop', async () => {
    const asked = droppingConnection(2, () => Response.json({ models: [], failures: [] }));

    await expect(listAvailableModels()).rejects.toThrow('Failed to fetch');
    expect(asked).toHaveLength(2);
  });

  test('a write is not asked again', async () => {
    const asked = droppingConnection(1, () => Response.json({ ok: true }));

    await expect(touchWorkspace('kept')).rejects.toThrow('Failed to fetch');
    expect(asked).toEqual(['POST /api/user/workspaces/kept/touch']);
  });
});
