// StepInjections — the shared mid-turn splice math (Hermes steer-drain shape)
// behind the CLI's user steering and the cf backend's background-event
// injection: record at the entry index, re-apply every step (streamText
// rebuilds messages from scratch), replay into the durable response.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { StepInjections } from '../src/prompting/step-injections';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });
const texts = (messages: ReadonlyArray<ModelMessage>) => messages.map((m) => m.content);

describe('StepInjections', () => {
  test('no injections → drain returns undefined at every step', () => {
    const inj = new StepInjections<{ message: ModelMessage }>();
    expect(inj.drain({ stepNumber: 0, messages: [user('q')] }, [])).toBeUndefined();
    expect(inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a')] }, [])).toBeUndefined();
    expect(inj.recorded).toHaveLength(0);
  });

  test('an injection enters at the step tail and re-applies at the same base index on later steps', () => {
    const inj = new StepInjections<{ message: ModelMessage }>();
    // Step 0: base = [q]; nothing pending yet.
    expect(inj.drain({ stepNumber: 0, messages: [user('q')] }, [])).toBeUndefined();
    // Step 1: SDK rebuilt [q, a1] — the injection lands after the tail.
    const step1 = inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a1')] },
      [{ message: user('steer') }]);
    expect(texts(step1!)).toEqual(['q', 'a1', 'steer']);
    // Step 2: SDK rebuilt [q, a1, a2] WITHOUT the injection — it re-applies
    // at its recorded index, keeping the prefix stable for the cache.
    const step2 = inj.drain({ stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')] }, []);
    expect(texts(step2!)).toEqual(['q', 'a1', 'steer', 'a2']);
  });

  test('injections at different steps keep their own entry positions', () => {
    const inj = new StepInjections<{ message: ModelMessage }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('first') }]);
    const step1 = inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a1')] },
      [{ message: user('second') }]);
    expect(texts(step1!)).toEqual(['q', 'first', 'a1', 'second']);
    const step2 = inj.drain({ stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')] }, []);
    expect(texts(step2!)).toEqual(['q', 'first', 'a1', 'second', 'a2']);
  });

  test('replayInto splices the injections at the positions the model saw, in response coordinates', () => {
    const inj = new StepInjections<{ message: ModelMessage }>();
    // Base = 2 (history + current user message).
    inj.drain({ stepNumber: 0, messages: [user('h'), user('q')] }, []);
    inj.drain({ stepNumber: 1, messages: [user('h'), user('q'), assistant('a1')] },
      [{ message: user('steer') }]);
    // Response messages exclude the base — the steer sits after a1.
    const merged = inj.replayInto([assistant('a1'), assistant('a2')]);
    expect(texts(merged)).toEqual(['a1', 'steer', 'a2']);
  });

  test('replayInto clamps an out-of-range index instead of throwing', () => {
    const inj = new StepInjections<{ message: ModelMessage }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('steer') }]);
    // An errored stream can settle with fewer response messages than steps.
    const merged = inj.replayInto([]);
    expect(texts(merged)).toEqual(['steer']);
  });

  test('recorded carries the caller bookkeeping; reset starts the next turn clean', () => {
    const inj = new StepInjections<{ message: ModelMessage; texts: string[] }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('x\n\ny'), texts: ['x', 'y'] }]);
    expect(inj.recorded.map((e) => e.texts)).toEqual([['x', 'y']]);
    inj.reset();
    expect(inj.recorded).toHaveLength(0);
    expect(inj.drain({ stepNumber: 0, messages: [user('next')] }, [])).toBeUndefined();
  });
});
