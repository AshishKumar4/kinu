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
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    expect(inj.drain({ stepNumber: 0, messages: [user('q')] }, [])).toBeUndefined();
    expect(inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a')] }, [])).toBeUndefined();
    expect(inj.recorded).toHaveLength(0);
  });

  test('an injection enters at the step tail and re-applies at the same base index on later steps', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    // Step 0: base = [q]; nothing pending yet.
    expect(inj.drain({ stepNumber: 0, messages: [user('q')] }, [])).toBeUndefined();

    // Step 1: SDK rebuilt [q, a1] — the injection lands after the tail.
    const step1 = inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a1')] },
      [{ message: user('steer'), durable: true }]);

    expect(texts(step1!)).toEqual(['q', 'a1', 'steer']);
    // Step 2: SDK rebuilt [q, a1, a2] WITHOUT the injection — it re-applies
    // at its recorded index, keeping the prefix stable for the cache.
    const step2 = inj.drain({ stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')] }, []);
    expect(texts(step2!)).toEqual(['q', 'a1', 'steer', 'a2']);
  });

  test('a re-applied injection never lands between a tool call and its result', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    const call = (id: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'probe', input: {} }] });
    const result = (id: string): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'probe', output: { type: 'text', value: 'ok' } }] });
    const roles = (messages: ReadonlyArray<ModelMessage>) => messages.map((m) => m.role);

    // Step 1 drains an event notice at the tail, index 4: after the call the
    // model just issued, whose result is not in yet.
    const step1 = inj.drain({ stepNumber: 1, messages: [user('q'), call('c1'), result('c1'), call('c2')] }, [{ message: user('notice'), durable: false }]);
    expect(roles(step1!)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);

    // Step 2 rebuilt the array with that result landed at index 4: the notice
    // re-applies after the pair, never between its halves.
    const step2 = inj.drain({ stepNumber: 2, messages: [user('q'), call('c1'), result('c1'), call('c2'), result('c2')] }, []);
    expect(roles(step2!)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
  });

  test('injections at different steps keep their own entry positions', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('first'), durable: true }]);

    const step1 = inj.drain({ stepNumber: 1, messages: [user('q'), assistant('a1')] },
      [{ message: user('second'), durable: true }]);

    expect(texts(step1!)).toEqual(['q', 'first', 'a1', 'second']);
    const step2 = inj.drain({ stepNumber: 2, messages: [user('q'), assistant('a1'), assistant('a2')] }, []);
    expect(texts(step2!)).toEqual(['q', 'first', 'a1', 'second', 'a2']);
  });

  test('replayInto splices the injections at the positions the model saw, in response coordinates', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    // Base = 2 (history + current user message).
    inj.drain({ stepNumber: 0, messages: [user('h'), user('q')] }, []);
    inj.drain({ stepNumber: 1, messages: [user('h'), user('q'), assistant('a1')] },
      [{ message: user('steer'), durable: true }]);
    // Response messages exclude the base — the steer sits after a1.
    const merged = inj.replayInto([assistant('a1'), assistant('a2')]);
    expect(texts(merged)).toEqual(['a1', 'steer', 'a2']);
  });

  test('a non-durable injection splices into the step but never replays into history', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    inj.drain({ stepNumber: 0, messages: [user('h'), user('q')] },
      [{ message: user('durable steer'), durable: true }, { message: user('ephemeral event'), durable: false }]);

    // The step sees both, durable first — entry order is the splice order.
    const step1 = inj.drain({ stepNumber: 1, messages: [user('h'), user('q'), assistant('a1')] }, []);
    expect(texts(step1!)).toEqual(['h', 'q', 'durable steer', 'ephemeral event', 'a1']);

    // Replay is the durable merge: the ephemeral entry is skipped and does not
    // consume a splice position, so the durable one still lands where the model
    // saw it relative to the response tail.
    const merged = inj.replayInto([assistant('a1'), assistant('a2')]);
    expect(texts(merged)).toEqual(['durable steer', 'a1', 'a2']);
  });

  test('replayInto clamps an out-of-range index instead of throwing', () => {
    const inj = new StepInjections<{ message: ModelMessage; readonly durable: boolean }>();
    inj.drain({ stepNumber: 0, messages: [user('q')] }, [{ message: user('steer'), durable: true }]);
    // An errored stream can settle with fewer response messages than steps.
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
