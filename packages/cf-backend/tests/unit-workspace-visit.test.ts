/**
 * Opening a workspace records a visit. The roster refuses the visit with 404 once it no longer holds the workspace,
 * and the page then shows its own missing-workspace state, so that answer is no failed visit to report. A visit that
 * failed any other way still throws, and the page says so.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { asFetchFunction } from '@kinu.run/core';
import { UserApiError, touchWorkspace } from '../src/lib/user-api';

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** The deployment answering every visit with `answer`, recording what was asked of it. */
function deploymentAnswering(answer: () => Response): string[] {
  const asked: string[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    asked.push(`${init?.method ?? 'GET'} ${v.parse(v.string(), input)}`);

    return answer();
  });

  return asked;
}

describe('a visit', () => {
  test('the roster took is recorded', async () => {
    const asked = deploymentAnswering(() => Response.json({ ok: true }));

    expect(await touchWorkspace('kept')).toBe(true);
    expect(asked).toEqual(['POST /api/user/workspaces/kept/touch']);
  });

  test('the roster refused because the workspace is gone is an answer, not a failure', async () => {
    deploymentAnswering(() => Response.json({ error: 'No such workspace.' }, { status: 404 }));

    expect(await touchWorkspace('gone')).toBe(false);
  });

  test('that failed any other way throws, so the page reports it', async () => {
    deploymentAnswering(() => Response.json({ error: 'the roster is unavailable' }, { status: 503 }));

    await expect(touchWorkspace('kept')).rejects.toBeInstanceOf(UserApiError);
    await expect(touchWorkspace('kept')).rejects.toMatchObject({ status: 503 });
  });
});
