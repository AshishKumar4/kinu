/** The group-reset workload acts as an agent told a call was interrupted: it finishes the step, checking before it appends. */

import { describe, expect, test } from 'bun:test';
import { faultScript } from './fault-script';
import { readScriptedRequest, type ScriptedAnswer } from './scripted-protocol';

const ASK = 'KINU_FAULT agent steps=3 sleep=1 burn=99 slices=1';

/** The helper's conversation: the ask, then each call with its result, as the provider sends them. */
function after(calls: readonly { readonly command: string; readonly result: string }[]) {
  const messages = [
    { role: 'user', content: ASK },
    ...calls.flatMap((call, at) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `c${String(at)}`, function: { name: 'shell', arguments: JSON.stringify({ command: call.command }) } }] },
      { role: 'tool', tool_call_id: `c${String(at)}`, content: call.result },
    ]),
  ];

  const read = readScriptedRequest(JSON.stringify({ messages, tools: [{ function: { name: 'shell' } }] }));

  if (!('request' in read)) throw new Error('the request did not read');

  return faultScript(read.request);
}

const command = (answer: ScriptedAnswer | null) => {
  const args = answer?.toolCall?.arguments;

  return typeof args === 'object' && args !== null && 'command' in args ? String(args.command) : null;
};

describe('the group-reset workload', () => {
  test('an acknowledged step is not made again', () => {
    expect(command(after([{ command: 'echo KINU_FAULT_AGENT_STEP_0', result: 'KINU_FAULT_AGENT_STEP_0' }]))).toContain('echo KINU_FAULT_AGENT_STEP_1 >>');
  });

  test('an interrupted step is made again, its append checked for first', () => {
    const next = command(after([
      { command: 'echo KINU_FAULT_AGENT_STEP_0', result: 'KINU_FAULT_AGENT_STEP_0' },
      { command: 'echo KINU_FAULT_AGENT_STEP_1', result: 'The turn was interrupted before this tool call returned.' },
    ]));

    expect(next).toContain('grep -qx KINU_FAULT_AGENT_STEP_1');
    expect(next).toContain('|| echo KINU_FAULT_AGENT_STEP_1 >>');
  });

  test('every step acknowledged, it is done', () => {
    const steps = [0, 1, 2].map((step) => ({ command: `echo KINU_FAULT_AGENT_STEP_${String(step)}`, result: `KINU_FAULT_AGENT_STEP_${String(step)}` }));

    expect(after(steps)?.text).toBe('KINU_FAULT_AGENT_DONE');
  });
});
