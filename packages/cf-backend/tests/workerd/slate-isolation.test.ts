// Each confined run of a slate is an isolate of its own (src/slates/room.ts, `confined`): the model's premise that one
// run's label covers its whole heap. Runs of one function, by one person, holding one grant, in turn and at once: none
// sees another's module state, and each reads through its own sealed stub, which the room refuses for any other run.
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('confined runs with one image, requester and label share no isolate, in turn or at once', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('isolated'));
  const answers = (await subject.isolatedRuns({ workspace: 'isolated-runs', owner: 'isolation-owner' })).map((answer) => JSON.parse(answer));

  expect(answers).toEqual([
    { seen: ['first'], read: 'string' },
    { seen: ['second'], read: 'string' },
    { seen: ['third'], read: 'string' },
    { seen: ['fourth'], read: 'string' },
  ]);
});
