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

function request(id: string, trigger: 'submit-message' | 'regenerate-message'): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id: 'ask', role: 'user', parts: [{ type: 'text', text: ASK }] }], trigger }) },
  });
}

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
});
