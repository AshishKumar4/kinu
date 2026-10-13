// The mechanical completion gate triggers on what the turn did and shows harness-read state, so no claim satisfies it.
import { describe, test, expect } from 'bun:test';
import {
  CompletionGate, observeCompletionState, completionGateText,
  COMPLETION_PROBE_COMMANDS,
} from '../src/orchestrator/completion-gate';
import { present } from '@kinu.run/test-utils';

const DID_WORK = { completed: true, toolCalls: 4 };

describe('when the gate fires', () => {
  test('a one-shot turn that did work is not allowed to be the last word', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    expect(gate.shouldGate(DID_WORK)).toBe(true);
  });

  test('an unarmed session never gates — the interactive surface has a human as its check', () => {
    expect(new CompletionGate().shouldGate(DID_WORK)).toBe(false);
  });

  const ungated = [
    { name: 'a turn that called no tools left no state to check', completed: true, toolCalls: 0 },
    { name: 'a turn that failed already reported its failure', completed: false, toolCalls: 9 },
  ] as const;

  for (const turn of ungated) {
    test(turn.name, () => {
      const gate = new CompletionGate();

      gate.arm('the task');
      expect(gate.shouldGate({ completed: turn.completed, toolCalls: turn.toolCalls })).toBe(false);
    });
  }

  test('once per task: the confirming turn cannot itself be gated', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    gate.fire();
    expect(gate.shouldGate(DID_WORK)).toBe(false);
  });

  test('the next task re-arms — the gate is per task, not per session', () => {
    const gate = new CompletionGate();
    gate.arm('first task');
    gate.fire();
    gate.arm('second task');
    expect(gate.shouldGate(DID_WORK)).toBe(true);
    // …and the gate is graded against the CURRENT task, not the previous one.
    expect(gate.task).toBe('second task');
  });
});

describe('what the gate reports', () => {
  test('a re-look that went back to work is a conversion; the row is written once', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    gate.fire();
    gate.settle({ toolCalls: 2 });
    expect(gate.pending).toEqual({ converted: true });
    gate.taken();
    expect(gate.pending).toBeNull();
  });

  test('a re-look that only confirmed is recorded as an honest non-conversion', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    gate.fire();
    gate.settle({ toolCalls: 0 });
    expect(gate.pending).toEqual({ converted: false });
  });

  test('a gate that never settled writes no row', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    gate.fire();
    expect(gate.pending).toBeNull();
  });
});

describe('the state the harness observes', () => {
  test('every probe runs and is labelled with the command that produced it', async () => {
    const observed = await observeCompletionState({
      exec: async (command) => ({ stdout: `out:${command}`, stderr: '', exitCode: 0 }),
    });


    for (const command of COMPLETION_PROBE_COMMANDS) {
      expect(observed).toContain(`out:${command}`);
    }
  });

  test('a failing git probe is dropped — "not a repository" is not state', async () => {
    const observed = await observeCompletionState({
      exec: async (command) => command.startsWith('git ')
        ? { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
        : { stdout: 'ok', stderr: '', exitCode: 0 },
    });

    expect(observed).not.toContain('not a git repository');
    expect(observed).toContain('$ ls -la');
  });

  test('a working directory that cannot be listed IS state, and is shown', async () => {
    const observed = await observeCompletionState({
      exec: async () => ({ stdout: '', stderr: 'ls: cannot open directory', exitCode: 2 }),
    });

    expect(observed).toContain('cannot open directory');
  });

  test('an unobservable environment reports null, so the caller cannot gate on nothing', async () => {
    const observed = await observeCompletionState({
      exec: () => Promise.reject(new Error('no shell')),
    });

    expect(observed).toBeNull();
  });

  test('an oversize listing keeps supplied ends without a full echo', async () => {
    const stdout = 'LISTING-START' + 'F'.repeat(50_000) + 'LISTING-END';

    const observed = await observeCompletionState({
      exec: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });

    const clamped = present(observed, 'the observed completion state');

    expect(clamped).toContain('LISTING-START');
    expect(clamped).toContain('LISTING-END');
    expect(clamped).not.toContain(stdout);
  });
});

describe('what the gate says', () => {
  const text = completionGateText({ task: 'build a widget into out/', observed: '$ pwd\n/work' });

  test('it carries the task, the observed state, and the stakes', () => {
    expect(text).toContain('build a widget into out/');
    expect(text).toContain('$ pwd\n/work');
  });
});
