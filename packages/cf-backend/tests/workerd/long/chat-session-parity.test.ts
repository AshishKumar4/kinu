/** Workers measurement, 2026-10-01: a hard DO abort preserves the turn's recorded steps and pending steers. */
import { abortAllDurableObjects, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as v from 'valibot';
import { DYNAMIC_CONTEXT_OPEN_TAG, RunEventSchema, drawnStep } from '@kinu.run/core';
import { ParityCompletedSchema, ParityPreparedSchema } from '../two-turn-shapes';

const MessageSchema = v.object({ parts: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })) });

it('steering and a restarted turn preserve conversation order and each step index once', async () => {
  const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('parity-driver'));
  const prepared = v.parse(ParityPreparedSchema, await root.parityPrepare());
  await abortAllDurableObjects();
  const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('parity-driver'));
  const completed = v.parse(ParityCompletedSchema, await coldRoot.parityComplete(prepared));

  expect(completed.failures).toEqual([]);
  expect(prepared.beforeRestart.pendingSteers.some((steer) => steer.text === 'PARITY-FOUR-STEER')).toBe(true);
  expect(completed.end.pendingSteers).toEqual([]);
  expect(completed.end.pendingSteerFiles).toEqual([]);
  // These native turns must not leave the scaffold's effect journal or mutable instruction log behind.
  expect(prepared.afterTwo.agentLog).toEqual([]);
  expect(prepared.beforeRestart.agentLog).toEqual([]);
  expect(completed.end.agentLog).toEqual([]);
  expect(completed.end.terminalEffects).toEqual([]);

  const users = completed.end.assistantMessages.filter((row) => row.role === 'user').map((row) =>
    v.parse(MessageSchema, JSON.parse(row.content)).parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''));

  expect(users).toEqual(['PARITY-ONE', 'PARITY-TWO', 'PARITY-TWO-STEER', 'PARITY-THREE', 'PARITY-FOUR-TOOL', 'PARITY-FOUR-STEER', 'PARITY-FIVE']);

  const events = completed.end.runEvents.map((row) => ({ runId: row.runId, event: v.parse(RunEventSchema, JSON.parse(row.payload)) }));

  const runs = events.filter(({ event }) => event.type === 'run_start').map(({ runId, event }) => {
    if (event.type !== 'run_start') throw new Error('a run must start with its opening record');
    const own = events.filter((row) => row.runId === runId).map(({ event: record }) => record);
    const steps = own.filter((record) => record.type === 'step_finish');
    const tools = own.filter((record) => record.type === 'tool_call_end');

    for (const step of steps) {
      expect(step.account).toEqual({ provider: 'openai-compat', name: 'main' });
      // The scripted provider does not report these: preserve unknown, never manufacture a free call.
      expect(step.usage).toBeUndefined();
      expect(step.usd).toBeUndefined();
    }

    if (steps.length > 0) {
      const assistant = completed.end.assistantMessages.find((row) => row.id === event.turn?.messageId);

      if (assistant === undefined) throw new Error('a completed answer must be in the conversation');

      const text = v.parse(MessageSchema, JSON.parse(assistant.content)).parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
      const replayed = steps.flatMap((record) => drawnStep(record.messages ?? []).flatMap((part) => part.type === 'text' ? [v.parse(v.string(), part.text)] : [])).join('');

      expect(replayed).toBe(text);
    }

    return {
      text: event.userMessage,
      types: own.map((record) => record.type),
      indices: steps.map((record) => record.stepIndex),
      stepReasons: steps.map((record) => record.reason),
      tools: tools.map((record) => ({ name: record.name, call: record.toolCallId, outcome: record.outcome })),
      ends: own.flatMap((record) => record.type === 'run_end' ? [record.reason] : []),
    };
  });

  const textRun = (text: string) => ({ text, types: ['run_start', 'step_finish', 'run_end'], indices: [1], stepReasons: ['stop'], tools: [], ends: ['completed'] });

  expect(runs).toEqual([
    textRun('PARITY-ONE'), textRun('PARITY-TWO'), textRun('PARITY-TWO-STEER'),
    { text: 'PARITY-THREE', types: ['run_start', 'run_end'], indices: [], stepReasons: [], tools: [], ends: ['aborted'] },
    { text: 'PARITY-FOUR-TOOL', types: ['run_start', 'tool_call_end', 'step_finish', 'step_finish', 'run_end'], indices: [1, 2],
      stepReasons: ['tool-calls', 'stop'],
      tools: [{ name: 'file', call: 'call_parity_1', outcome: { success: false, reason: 'missing' } }], ends: ['completed'] },
    textRun('PARITY-FIVE'),
  ]);

  const resuming = completed.frames.findIndex((frame) => frame.type === 'cf_agent_stream_resuming');
  const resumed = completed.frames[resuming];
  expect(completed.frames.some((frame) => frame.type === 'cf_agent_stream_pending')).toBe(true);
  expect(completed.frames.slice(resuming + 1).filter((frame) => frame.type === 'cf_agent_use_chat_response' && frame.id === resumed?.id && frame.done === true)).toHaveLength(1);
  expect(completed.frames.some((frame) => frame.type === 'steer_status' && frame.steerId === 'input-PARITY-FOUR-STEER' && frame.status === 'landed')).toBe(true);
  expect(completed.frames.filter((frame) => frame.type === 'cf_agent_use_chat_response' && frame.id === 'PARITY-FIVE' && frame.done === true && frame.error !== true)).toHaveLength(1);
  expect(completed.modelCallsAfter[0]?.toolResults).toEqual(prepared.modelCallsBefore.at(-1)?.toolResults);
  expect(completed.modelCallsAfter[0]?.users.some((user) => user.endsWith('helloPARITY-FOUR-STEER'))).toBe(true);
  expect(completed.seed).toContain('PARITY-FIVE');
  expect(completed.seed).not.toContain(DYNAMIC_CONTEXT_OPEN_TAG);
});
