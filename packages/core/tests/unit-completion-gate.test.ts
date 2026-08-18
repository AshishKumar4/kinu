// The mechanical completion gate: a one-shot run does not get to end on the
// model's own say-so. These pin the two properties that make it a mechanism
// rather than a prompt — it triggers on what the turn DID, and the state it
// shows is read by the harness, so no claim can satisfy it.
import { describe, test, expect } from 'bun:test';
import {
  CompletionGate, observeCompletionState, completionGateText,
  COMPLETION_GATE_HEADER, COMPLETION_PROBE_COMMANDS, COMPLETION_TASK_ECHO_MAX_CHARS,
} from '../src/orchestrator/completion-gate';

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

  test('a turn that called no tools left no state to check', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    expect(gate.shouldGate({ completed: true, toolCalls: 0 })).toBe(false);
  });

  test('a turn that failed already reported its failure', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    expect(gate.shouldGate({ completed: false, toolCalls: 9 })).toBe(false);
  });

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
    expect(gate.take()).toEqual({ converted: true });
    expect(gate.take()).toBeNull();
  });

  test('a re-look that only confirmed is recorded as an honest non-conversion', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    gate.fire();
    gate.settle({ toolCalls: 0 });
    expect(gate.take()).toEqual({ converted: false });
  });

  test('a gate that never settled writes no row', () => {
    const gate = new CompletionGate();
    gate.arm('the task');
    gate.fire();
    expect(gate.take()).toBeNull();
  });
});

describe('the state the harness observes', () => {
  test('every probe runs and is labelled with the command that produced it', async () => {
    const seen: string[] = [];
    const observed = await observeCompletionState({
      exec: async (command) => {
        seen.push(command);
        return { stdout: `out:${command}`, stderr: '', exitCode: 0 };
      },
    });
    expect(seen).toEqual([...COMPLETION_PROBE_COMMANDS]);
    for (const command of COMPLETION_PROBE_COMMANDS) {
      expect(observed).toContain(`$ ${command}`);
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
    expect(observed).toContain('Error (exit 2)');
    expect(observed).toContain('cannot open directory');
  });

  test('an unobservable environment reports null, so the caller cannot gate on nothing', async () => {
    const observed = await observeCompletionState({
      exec: () => Promise.reject(new Error('no shell')),
    });
    expect(observed).toBeNull();
  });

  test('an oversize listing is clamped through the ordinary tool-result path', async () => {
    const observed = await observeCompletionState({
      exec: async () => ({ stdout: 'F'.repeat(50_000), stderr: '', exitCode: 0 }),
    });
    expect(observed!.length).toBeLessThan(20_000);
    expect(observed).toContain('chars omitted');
  });
});

describe('what the gate says', () => {
  const text = completionGateText({ task: 'build a widget into out/', observed: '$ pwd\n/work' });

  test('it is marked as harness-authored, never as something the user typed', () => {
    expect(text).toStartWith(COMPLETION_GATE_HEADER);
  });

  test('it carries the task, the observed state, and the stakes', () => {
    expect(text).toContain('build a widget into out/');
    expect(text).toContain('$ pwd\n/work');
    expect(text).toContain('graded');
  });

  test('a huge task is bounded rather than re-sent whole', () => {
    const long = completionGateText({ task: 'x'.repeat(20_000), observed: 'state' });
    expect(long.length).toBeLessThan(COMPLETION_TASK_ECHO_MAX_CHARS + 1_500);
    expect(long).toContain('chars of the task omitted');
  });
});
