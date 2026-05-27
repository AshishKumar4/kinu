import { describe, test, expect } from 'bun:test';
import { createInferenceLoopRegistry, type InferenceLoop, type RunEvent } from '../src/index.ts';

function fakeLoop(id: string): InferenceLoop {
  return {
    id,
    label: id,
    async *run(): AsyncIterable<RunEvent> {
      yield { type: 'run_start', runId: id, eventIndex: 0, timestamp: new Date().toISOString() } as RunEvent;
      yield { type: 'run_end', runId: id, eventIndex: 1, timestamp: new Date().toISOString() } as RunEvent;
    },
  };
}

describe('InferenceLoopRegistry', () => {
  test('register + get + list', () => {
    const r = createInferenceLoopRegistry();
    r.register(fakeLoop('think'));
    r.register(fakeLoop('scaffold'));
    expect(r.list().map(l => l.id)).toEqual(['think', 'scaffold']);
    expect(r.get('think')?.id).toBe('think');
    expect(r.get('missing')).toBeUndefined();
  });

  test('duplicate id rejected', () => {
    const r = createInferenceLoopRegistry();
    r.register(fakeLoop('a'));
    expect(() => r.register(fakeLoop('a'))).toThrow('already registered');
  });

  test('loop yields events as expected', async () => {
    const r = createInferenceLoopRegistry();
    r.register(fakeLoop('test'));
    const loop = r.get('test')!;
    const events: RunEvent[] = [];
    for await (const ev of loop.run({} as never)) events.push(ev);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('run_start');
    expect(events[1].type).toBe('run_end');
  });
});
