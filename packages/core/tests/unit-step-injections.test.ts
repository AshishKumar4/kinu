// StepInjections: mid-turn splice math. streamText rebuilds messages every step,
// so injections re-apply at their recorded index and replay into the durable response.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { StepInjections } from '../src/prompting/step-injections';
import { present } from '@kinu.run/test-utils';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });

const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

const texts = (messages: ReadonlyArray<ModelMessage>) => messages.map((m) => m.content);

describe('StepInjections', () => {
  test('no injections → drain returns undefined at every step', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    expect(inj.drain({ stepNumber: 0, messages: [user('q')] }, [])).toBeUndefined();
    expect(inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a')] }, [])).toBeUndefined();
    expect(inj.recorded).toHaveLength(0);
  });

  test('an injection enters at the step tail and re-applies at the same base index on later steps', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    expect(inj.drain({ stepNumber: 0, messages: [user('q')] }, [])).toBeUndefined();

    const step1 = present(inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a1')] },
      [{ message: user('steer'), durable: true }]), 'the prepared step');

    expect(texts(step1)).toEqual(['q', 'a1', 'steer']);
    // Re-applied at its recorded index, keeping the cached prefix stable.
    const step2 = present(inj.drain({ stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')] }, []), 'the prepared step');
    expect(texts(step2)).toEqual(['q', 'a1', 'steer', 'a2']);
  });

  test('a re-applied injection never lands between a tool call and its result', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    const call = (id: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'probe', input: {} }] });
    const result = (id: string): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'probe', output: { type: 'text', value: 'ok' } }] });
    const roles = (messages: ReadonlyArray<ModelMessage>) => messages.map((m) => m.role);

    const step1 = present(inj.drain({ stepNumber: 1, messages: [user('q'), call('c1'), result('c1'), call('c2')] }, [{ message: user('notice'), durable: false }]), 'the prepared step');
    expect(roles(step1)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);

    // Re-applies after the call/result pair, never between its halves.
    const step2 = present(inj.drain({ stepNumber: 2, messages: [user('q'), call('c1'), result('c1'), call('c2'), result('c2')] }, []), 'the prepared step');
    expect(roles(step2)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
  });

  test('injections at different steps keep their own entry positions', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('first'), durable: true }]);

    const step1 = present(inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a1')] },
      [{ message: user('second'), durable: true }]), 'the prepared step');

    expect(texts(step1)).toEqual(['q', 'first', 'a1', 'second']);
    const step2 = present(inj.drain({ stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')] }, []), 'the prepared step');
    expect(texts(step2)).toEqual(['q', 'first', 'a1', 'second', 'a2']);
  });

  test('replayInto splices the injections at the positions the model saw, in response coordinates', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    inj.drain({ stepNumber: 0, messages: [user('h'), user('q')] }, []);
    inj.drain({ stepNumber: 1, messages: [user('h'), user('q'), assistant('a1')] },
      [{ message: user('steer'), durable: true }]);
    const merged = inj.replayInto([assistant('a1'), assistant('a2')]);
    expect(texts(merged)).toEqual(['a1', 'steer', 'a2']);
  });

  test('a non-durable injection splices into the step but never replays into history', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    inj.drain({ stepNumber: 0, messages: [user('h'), user('q')] },
      [{ message: user('durable steer'), durable: true }, { message: user('ephemeral event'), durable: false }]);

    const step1 = present(inj.drain({ stepNumber: 1, messages: [user('h'), user('q'), assistant('a1')] }, []), 'the prepared step');
    expect(texts(step1)).toEqual(['h', 'q', 'durable steer', 'ephemeral event', 'a1']);

    // Ephemeral entries are skipped in replay and consume no splice position.
    const merged = inj.replayInto([assistant('a1'), assistant('a2')]);
    expect(texts(merged)).toEqual(['durable steer', 'a1', 'a2']);
  });

  test('replayInto clamps an out-of-range index instead of throwing', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('steer'), durable: true }]);
    const merged = inj.replayInto([]);
    expect(texts(merged)).toEqual(['steer']);
  });

  test('recorded carries the caller bookkeeping; reset starts the next turn clean', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean; texts: string[] }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('x\n\ny'), texts: ['x', 'y'], durable: true }]);
    expect(inj.recorded.map((e) => e.texts)).toEqual([['x', 'y']]);
    inj.reset();
    expect(inj.recorded).toHaveLength(0);
    expect(inj.drain({ stepNumber: 0, messages: [user('next')] }, [])).toBeUndefined();
  });
});
