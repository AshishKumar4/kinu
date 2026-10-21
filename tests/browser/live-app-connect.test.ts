import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-connect', ['connect']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

// Review findings (2026-10-23) on the one finish page: the gallery modelled the provider and the callback itself, and
// disagreed with the Worker on a decline. These run the Worker's callback, storage and MCP SDK; only the provider is
// a stand-in, one that asks the person.
describe('an MCP sign-in through the Worker, against a provider that asks the person', () => {
  test('run in the tab itself from setup, it comes back to the step it left, reached by Next, connected', () => {
    expect(verdictOf(observed.connect, 'connect').sameTab).toEqual({ back: '/welcome?step=tools', status: 'ready' });
  });

  test('a finish page for another run neither closes the waiting sign-in nor speaks to its page', () => {
    expect(verdictOf(observed.connect, 'connect').planted).toEqual({ helperOpen: true, said: null });
  });

  test('declined, its tab closes, its page says it did not connect, and its row offers the sign-in again', () => {
    expect(verdictOf(observed.connect, 'connect').denied).toMatchObject({ helperClosed: true, said: 'failed', signInOffered: true });
  });

  test('signed in again and approved, the server connects', () => {
    expect(verdictOf(observed.connect, 'connect').retried).toEqual({ said: 'connected', status: 'ready' });
  });
});
