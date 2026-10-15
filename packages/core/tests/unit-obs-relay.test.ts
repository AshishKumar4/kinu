/**
 * A line another isolate wrote through the diagnostics envelope is read back whole and written again, its fields masked
 * again and the relay's own added; anything else a console carried is no such line.
 */
import { expect, test } from 'bun:test';
import { createLineLogger, relayedLine, toKinuError } from '../src/obs';
import { createRecordingLogger } from '@kinu.run/test-utils';

test("a line another isolate wrote is written again under its own event, with the relay's fields", () => {
  const written: string[] = [];
  const isolate = createLineLogger((line) => { written.push(line); });

  isolate.event('provider.stream_opened', { provider: 'openai-compat:cmp', ms: 71 });
  isolate.failure('provider.request_failed', toKinuError({ doing: 'calling the fast tier', cause: new Error('the provider refused'), otherwise: 'denied' }), { tier: 'fast' });

  const lines = written.map((line) => relayedLine(line));
  const relayed: string[] = [];
  const workspace = createLineLogger((line) => { relayed.push(line); });

  for (const line of lines) {
    if (line !== null) workspace.relay?.({ ...line, fields: { ...line.fields, actor: 'agent-1' } });
  }

  // Read back as any line in the envelope is: the relay wrote nothing a reader of the original could not read.
  expect(relayed.map((line) => relayedLine(line))).toEqual([
    { event: 'provider.stream_opened', fields: { provider: 'openai-compat:cmp', ms: 71, actor: 'agent-1' } },
    { event: 'provider.request_failed', code: 'denied', cause: expect.stringContaining('the provider refused'), fields: { tier: 'fast', actor: 'agent-1' } },
  ]);
});

test('a relayed line reaches a recording sink as the line it was', () => {
  const written: string[] = [];

  createLineLogger((line) => { written.push(line); }).event('turn.settled', { steps: 2 });
  const recording = createRecordingLogger();
  const line = relayedLine(written[0] ?? '');

  if (line !== null) recording.relay?.(line);
  expect(recording.emitted).toEqual([{ event: 'turn.settled', code: null, cause: null, fields: { steps: 2 } }]);
});

test('text in no envelope is no relayed line', () => {
  expect([
    relayedLine('plain words'),
    relayedLine('{"event":"nodot","fields":{}}'),
    relayedLine('{"event":"a.b","fields":{"nested":{"x":1}}}'),
    relayedLine('{"event":"a.b","code":"made_up","fields":{}}'),
    relayedLine('{"event":"a.b"}'),
  ]).toEqual([null, null, null, null, null]);
});
