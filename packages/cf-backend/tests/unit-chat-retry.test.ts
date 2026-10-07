/**
 * Retry on a failed turn (trigger `regenerate-message`) continues it: completed steps stay and are not run again.
 * Production, 2026-10-05: a Claude turn failed with a 400 and Retry ran nothing.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { AwaitedList } from '@kinu.run/test-utils';
import { actorConnectionTag } from '@kinu.run/core';
import { gatewayWorkspace, storedChat, workspaceFiles, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { socketConnection } from './helpers/bindings';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import type { Connection } from 'agents';

const ASK = 'Note that the deploy ran, then tell me.';

const COUNTER = 'retry-side-effect.txt';

function request(id: string, trigger: 'submit-message' | 'regenerate-message', messages = [{ id: 'ask', text: ASK }]): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: {
      method: 'POST',
      body: JSON.stringify({ messages: messages.map((message) => ({ id: message.id, role: 'user', parts: [{ type: 'text', text: message.text }] })), trigger }),
    },
  });
}

const STEER = 'Send one notification when it is done.';

/** A workspace whose model refuses its first call with a 400, then answers; `calls` counts the calls on the ask. */
function refusedOnce() {
  let calls = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!JSON.stringify(requestOf(run).messages).includes(ASK)) return chatCompletion(run, '{"title":"Deploy notes"}');
    calls += 1;

    return calls === 1 ? Response.json({ error: { message: 'Bad Request' } }, { status: 400 }) : chatCompletion(run, 'Answered once.');
  }));

  return { workspace, calls: () => calls };
}

const times = (prompt: string, text: string) => prompt.split(text).length - 1;

const DoneSchema = v.object({
  type: v.literal('cf_agent_use_chat_response'), id: v.string(), done: v.literal(true), error: v.optional(v.boolean()), body: v.optional(v.string()),
});

function done(frames: readonly string[], id: string) {
  return frames.flatMap((raw) => {
    const parsed = v.safeParse(DoneSchema, JSON.parse(raw));

    return parsed.success && parsed.output.id === id ? [parsed.output] : [];
  });
}

function listen(agent: HarnessOrchestratorAgent, actorId: string | null = null) {
  const frames = new AwaitedList<string>();
  const fanout = agent.broadcast.bind(agent);

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (exclude === undefined || !exclude.includes('retry-conn')) frames.push(message);
      fanout(message, exclude);
    },
  });

  const wire: Connection = socketConnection({
    id: 'retry-conn', tags: actorId === null ? [] : [actorConnectionTag(actorId)], send: (data: string) => { frames.push(data); },
  });

  return { wire, frames };
}

describe('Retry on a failed turn', () => {
  test('keeps the completed step, does its work once, and finishes the answer', async () => {
    const prompts: string[] = [];
    let refused = false;

    // Step 1 calls the shell, which appends a line; the call after it fails once with a 400, then answers.
    const workspace = gatewayWorkspace(stubAiBinding((run) => {
      const sent = requestOf(run).messages;
      prompts.push(JSON.stringify(sent));

      if (!sent.some((message) => message.role === 'tool')) {
        return toolCallCompletion(run, { tool: 'shell', args: { command: `echo ran >> ${COUNTER}` } }, 'call_0');
      }

      if (!refused) {
        refused = true;

        return Response.json({ error: { message: 'Bad Request: a cache_control block is malformed' } }, { status: 400 });
      }

      return chatCompletion(run, 'The deploy ran, noted once.');
    }));

    const { agent } = workspace;
    await workspace.started;
    const { wire, frames } = listen(agent);
    const gate = agent.harnessChatGate();

    await gate(wire, request('first', 'submit-message'));
    await frames.until((sent) => done(sent, 'first').length > 0);
    expect(refused).toBe(true);
    expect(await readText(workspaceFiles(agent), COUNTER)).toBe('ran\n');

    await gate(wire, request('retry', 'regenerate-message'));
    await frames.until((sent) => done(sent, 'retry').length > 0);

    expect(done(frames.items, 'retry')[0]?.error).toBeUndefined();
    // The side effect ran once: the shell step was not re-run.
    expect(await readText(workspaceFiles(agent), COUNTER)).toBe('ran\n');
    // The retried call read the owner's words once, and the completed step's result.
    const last = prompts.at(-1) ?? '';
    expect(last.split(ASK).length).toBe(2);
    expect(last).toContain('"role":"tool"');
    const chat = await storedChat(workspace);
    expect(chat.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(chat)).toContain('The deploy ran, noted once.');
    // The completed step stays in the transcript.
    expect(JSON.stringify(chat)).toContain('call_0');
  });

  test('a turn that failed before any step ran starts over on the same words', async () => {
    let refused = false;

    const workspace = gatewayWorkspace(stubAiBinding((run) => {
      if (!refused) {
        refused = true;

        return Response.json({ error: { message: 'Bad Request' } }, { status: 400 });
      }

      return chatCompletion(run, 'Answered on retry.');
    }));

    const { agent } = workspace;
    await workspace.started;
    const { wire, frames } = listen(agent);
    const gate = agent.harnessChatGate();

    await gate(wire, request('first', 'submit-message'));
    await frames.until((sent) => done(sent, 'first').length > 0);
    await gate(wire, request('retry', 'regenerate-message'));
    await frames.until((sent) => done(sent, 'retry').length > 0);

    expect(done(frames.items, 'retry')[0]?.error).toBeUndefined();
    const chat = await storedChat(workspace);
    expect(chat.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(chat[1])).toContain('Answered on retry.');
  });

  test('on a hosted agent\'s chat, keeps the completed step, does its work once, and finishes the answer', async () => {
    const prompts: string[] = [];
    let refused = false;

    const workspace = gatewayWorkspace(stubAiBinding((run) => {
      const sent = requestOf(run).messages;

      if (!JSON.stringify(sent).includes(ASK)) return chatCompletion(run, '{"title":"Deploy notes"}');
      prompts.push(JSON.stringify(sent));

      if (!sent.some((message) => message.role === 'tool')) {
        return toolCallCompletion(run, { tool: 'shell', args: { command: `echo ran >> ${COUNTER}` } }, 'call_0');
      }

      if (!refused) {
        refused = true;

        return Response.json({ error: { message: 'Bad Request: a cache_control block is malformed' } }, { status: 400 });
      }

      return chatCompletion(run, 'The deploy ran, noted once.');
    }));

    const { agent } = workspace;
    await workspace.started;
    // An added agent inherits SOUL.md's mission, which a workspace holds from its birth.
    await agent.setSoul('# Purpose\n\nDo each task asked.');
    const { subordinate } = await agent.createSubordinateAgent();

    if (subordinate.actorId === null) throw new Error('the added agent has no actor');
    const { wire, frames } = listen(agent, subordinate.actorId);

    const ask = async (id: string, trigger: 'submit-message' | 'regenerate-message') => {
      await agent.onMessage(wire, request(id, trigger));
      await agent.terminalRetryPass();
      await joinHarnessFibers();
      await frames.until((sent) => done(sent, id).length > 0);
    };

    const counted = async () => (await agent.execWorkspaceCommand(`cat /home/sub-*/${COUNTER}`)).stdout;

    await ask('first', 'submit-message');
    expect(refused).toBe(true);
    expect(await counted()).toBe('ran\n');
    const asked = prompts[0]?.split(ASK).length;

    await ask('retry', 'regenerate-message');
    expect(done(frames.items, 'retry')[0]?.error).toBeUndefined();
    expect(await counted()).toBe('ran\n');
    const last = prompts.at(-1) ?? '';
    expect(last.split(ASK).length).toBe(asked);
    expect(last).toContain('"role":"tool"');
    expect(JSON.stringify(frames.items)).toContain('The deploy ran, noted once.');
  });

  test('two tabs retrying one failed turn: one runs it, the other is refused, and the first is answered', async () => {
    const { workspace, calls } = refusedOnce();

    const { agent } = workspace;
    await workspace.started;
    const { wire, frames } = listen(agent);
    const gate = agent.harnessChatGate();

    await gate(wire, request('first', 'submit-message'));
    await frames.until((sent) => done(sent, 'first').length > 0);
    const before = calls();

    await Promise.all([gate(wire, request('tab-a', 'regenerate-message')), gate(wire, request('tab-b', 'regenerate-message'))]);
    await frames.until((sent) => done(sent, 'tab-a').length > 0 && done(sent, 'tab-b').length > 0);

    expect(['tab-a', 'tab-b'].filter((id) => done(frames.items, id)[0]?.error === true)).toHaveLength(1);
    expect(calls() - before).toBe(1);
  });

  test('a turn a steer joined is retried under its opener: each message reaches the model once', async () => {
    const prompts: string[] = [];
    let refused = false;
    const steered = Promise.withResolvers<void>();
    let shellRan: (() => void) | null = null;
    const shellStarted = new Promise<void>((resolve) => { shellRan = resolve; });

    const workspace = gatewayWorkspace(stubAiBinding(async (run) => {
      const sent = requestOf(run).messages;

      if (!JSON.stringify(sent).includes(ASK)) return chatCompletion(run, '{"title":"Deploy notes"}');
      prompts.push(JSON.stringify(sent));

      if (!sent.some((message) => message.role === 'tool')) {
        shellRan?.();
        await steered.promise;

        return toolCallCompletion(run, { tool: 'shell', args: { command: 'echo ran' } }, 'call_0');
      }

      if (!refused) {
        refused = true;

        return Response.json({ error: { message: 'Bad Request' } }, { status: 400 });
      }

      return chatCompletion(run, 'Done, one notification.');
    }));

    const { agent } = workspace;
    await workspace.started;
    const { wire, frames } = listen(agent);
    const gate = agent.harnessChatGate();

    const opening = gate(wire, request('first', 'submit-message'));
    await shellStarted;
    // The steer's request answers once the step it waits behind ends.
    const steering = gate(wire, request('steer', 'submit-message', [{ id: 'ask', text: ASK }, { id: 'steer', text: STEER }]));
    await frames.until(() => true);
    steered.resolve();
    await Promise.all([opening, steering]);
    await frames.until((sent) => done(sent, 'first').length > 0);
    expect(refused).toBe(true);
    expect(prompts.some((prompt) => prompt.includes(STEER))).toBe(true);

    await gate(wire, request('retry', 'regenerate-message', [{ id: 'ask', text: ASK }, { id: 'steer', text: STEER }]));
    await frames.until((sent) => done(sent, 'retry').length > 0);

    expect(done(frames.items, 'retry')[0]?.error).toBeUndefined();
    const last = prompts.at(-1) ?? '';
    expect([times(last, ASK), times(last, STEER)]).toEqual([1, 1]);
    const users = (await storedChat(workspace)).filter((message) => message.role === 'user');
    expect(users).toHaveLength(2);
  });

  test('on a hosted agent\'s chat, two tabs retrying one failed turn: one runs it, the other is refused', async () => {
    const { workspace, calls } = refusedOnce();

    const { agent } = workspace;
    await workspace.started;
    // An added agent inherits SOUL.md's mission, which a workspace holds from its birth.
    await agent.setSoul('# Purpose\n\nDo each task asked.');
    const { subordinate } = await agent.createSubordinateAgent();

    if (subordinate.actorId === null) throw new Error('the added agent has no actor');
    const { wire, frames } = listen(agent, subordinate.actorId);

    await agent.onMessage(wire, request('first', 'submit-message'));
    await agent.terminalRetryPass();
    await joinHarnessFibers();
    await frames.until((sent) => done(sent, 'first').length > 0);
    const before = calls();

    await Promise.all([agent.onMessage(wire, request('tab-a', 'regenerate-message')), agent.onMessage(wire, request('tab-b', 'regenerate-message'))]);
    await agent.terminalRetryPass();
    await joinHarnessFibers();
    await frames.until((sent) => done(sent, 'tab-a').length > 0 && done(sent, 'tab-b').length > 0);

    expect(['tab-a', 'tab-b'].filter((id) => done(frames.items, id)[0]?.error === true)).toHaveLength(1);
    expect(calls() - before).toBe(1);
  });
});
