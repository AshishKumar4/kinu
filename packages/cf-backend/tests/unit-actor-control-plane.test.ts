/**
 * The root's four control RPCs are declared once, on the one DO; what is per actor is the durable state they read,
 * so this proves a child's rows are its own. The no-second-copy ratchet lives in unit-rpc-surface.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { UIMessage } from 'ai';
import { actorConnectionTag, CHAT_REWOUND_EVENT, classifyProgrammaticTurn, TURN_AUTHOR_METADATA_KEY } from '@kinu.run/core';
import {
  hostedSubordinateHarness, orchestratorHarness, chatSessionTurns, storedChat, type HarnessOrchestratorAgent,
  type RecordedUserPlaneCalls, workspaceMainActor,
} from './helpers/actor-harness';
import { asPane, joinHarnessFibers } from './helpers/agents-sdk';
import type { Database } from 'bun:sqlite';

/** Scoped by handle: an unscoped read would let a sibling's cancellation satisfy or pollute this assertion. */
function cancelActivity(db: Database, actorId: string): unknown[] {
  return db.prepare("SELECT detail FROM activity_log WHERE event = 'work_cancelled' AND actor_id = ?").all(actorId);
}

describe('the workspace root answers the actor control plane', () => {
  test('a stored model spec round-trips on the workspace root', async () => {
    const { agent } = orchestratorHarness();

    expect(await agent.getStoredModelSpec()).toEqual({ spec: null });
    await agent.setModel('anthropic/claude-sonnet-4-5');

    expect(await agent.getStoredModelSpec()).toEqual({ spec: 'anthropic/claude-sonnet-4-5' });
  });

  test('a hosted child keeps its own model row in the same database', async () => {
    const workspace = orchestratorHarness();

    const child = await hostedSubordinateHarness(workspace, {
      name: 'control-plane-child',
      displayName: 'Control Plane Child',
      nameOrigin: 'user',
      mission: 'hold one model row',
    });

    expect(child.actor.stores.config.getModel()).toBeNull();
    child.actor.stores.config.setModel('anthropic/claude-sonnet-4-5');

    expect(child.actor.stores.config.getModel()).toBe('anthropic/claude-sonnet-4-5');
    expect(await workspace.agent.getStoredModelSpec()).toEqual({ spec: null });
  });

  /**
   * A steer after the turn ended is committed to the actor's own queue in the same slice as the decision and answers
   * 'queued' (KINU-N026: answering 'idle' let another turn file the guidance). Subordinates answer the same way.
   */
  test('steering with no turn running queues the text as the next ordinary turn', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;
    const turns = chatSessionTurns(agent);
    const next = turns.park();

    // The send is admitted as the operator's own next turn, under their stamp and typed mode.
    const landing = agent.send('use the other parser', 'm-parser');
    await next;
    await turns.settle({ messageId: 'a-parser', text: 'ok' });
    await landing;

    const opened = (await storedChat(harness)).find((message) => message.role === 'user');
    expect(opened?.parts).toEqual([{ type: 'text', text: 'use the other parser' }]);
    expect(v.parse(v.looseObject({ metadata: v.optional(v.unknown()) }), opened).metadata)
      .toEqual({ [TURN_AUTHOR_METADATA_KEY]: 'operator', kinuMode: 'build' });
  });

  test('cancelling with nothing running is a settled no-op, not a failure', async () => {
    const outcome = await orchestratorHarness().agent.cancelCurrentWork();

    expect(outcome.ok).toBe(true);
    expect(outcome.abortedTools).toBe(0);
  });

  /**
   * The kept difference: the orchestrator owns the composer's Stop path and files the Activity line under its own id;
   * a hosted child with no live turn has nothing to drop and must file nothing on the root's behalf.
   */
  test('only the workspace root files its own cancellation, under its own actor id', async () => {
    const orchestrator = orchestratorHarness();

    const child = await hostedSubordinateHarness(orchestrator, {
      name: 'cancel-scope-child',
      displayName: 'Cancel Scope Child',
      nameOrigin: 'user',
      mission: 'prove one cancellation row',
    });

    await orchestrator.agent.cancelCurrentWork();

    const rootId = workspaceMainActor(orchestrator.db).actorId;
    expect(cancelActivity(orchestrator.db, rootId)).toEqual([{ detail: '0 foreground aborted' }]);
    expect(cancelActivity(orchestrator.db, child.actor.handle.actorId)).toEqual([]);
  });

  /** Stop is an agent's own (#68): a hire's reaches its commands on the owner's machine, any turn's, and main's runs on. */
  test("a hire's Stop sweeps its own device commands and leaves main's running", async () => {
    const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [], agentCancels: [] };
    const orchestrator = orchestratorHarness(userPlane);

    await orchestrator.agent.setSoul('# Purpose\n\nKeep the coast notes.');
    const { subordinate } = await orchestrator.agent.createSubordinateAgent();
    const hire = v.parse(v.string(), subordinate.actorId);
    const main = workspaceMainActor(orchestrator.db).actorId;

    await asPane([actorConnectionTag(hire)], () => orchestrator.agent.cancelCurrentWork());
    await joinHarnessFibers();
    expect(userPlane.agentCancels).toEqual([hire]);

    await orchestrator.agent.cancelCurrentWork();
    await joinHarnessFibers();
    expect(userPlane.agentCancels).toEqual([hire, main]);
  });
});

/**
 * The walk-back, twin of cli-backend's `LocalAgentSession — the walk-back`: one core method and refusal under both transports.
 */
describe('the workspace root answers the walk-back', () => {
  const lines = (messages: readonly UIMessage[]): string[] => messages.map(
    (message) => message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
  );

  /** A tab open before the revert has no other way to learn of it. */
  const captureTranscriptFrames = (agent: HarnessOrchestratorAgent): string[][] => {
    const sent: string[][] = [];

    Object.defineProperty(agent, 'broadcast', {
      configurable: true,
      value: (payload: string) => {
        const frame = v.safeParse(
          v.object({ type: v.literal('cf_agent_chat_messages'), messages: v.array(v.looseObject({ id: v.string() })) }),
          JSON.parse(payload),
        );

        if (frame.success) sent.push(frame.output.messages.map((message) => message.id));
      },
    });

    return sent;
  };

  test('the transcript ends before the message the revert names, and every tab is told', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;
    const turns = chatSessionTurns(agent);
    await turns.run('first ask');
    await turns.run('second ask');
    const before = await storedChat(harness);
    const second = before.filter((message) => message.role === 'user').at(-1);

    if (second === undefined) throw new Error('the harness recorded no user message');
    const frames = captureTranscriptFrames(agent);
    await agent.revertConversation(second.id);

    const kept = await storedChat(harness);
    expect(lines(kept)).toEqual(['first ask', 'ok']);
    expect(frames).toEqual([kept.map((message) => message.id)]);
  });

  test('a turn in flight refuses the walk-back and keeps the conversation', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;
    const turns = chatSessionTurns(agent);
    await turns.run('first ask');
    const first = (await storedChat(harness)).filter((message) => message.role === 'user').at(-1);

    if (first === undefined) throw new Error('the harness recorded no user message');
    const parked = turns.park();
    const landing = agent.send('second ask', 'm-second');
    await parked;

    await expect(agent.revertConversation(first.id)).rejects.toThrow(/Stop the turn that is running/);

    await turns.settle({ messageId: 'second-answer', text: 'ok' });
    await landing;
    expect(lines(await storedChat(harness))).toEqual(['first ask', 'ok', 'second ask', 'ok']);
  });

  // REWIND-0924: a chat-only rewind takes the chat back, but the computer keeps what the rewound turns did; the agent
  // is told, at its next turn, and no turn starts for it.
  describe('a chat-only rewind tells the agent what its rewound turns left', () => {
    /** A conversation whose second turn wrote a file, failed an edit, and ran a command; its second ask's id. */
    const rewound = async () => {
      const harness = orchestratorHarness();
      const { agent } = harness;
      const turns = chatSessionTurns(agent);

      await turns.run('first ask');
      await turns.prepare({ messages: [{ role: 'user', content: 'write the plan' }] });
      await turns.settle({
        messageId: 'second-answer', text: 'Wrote it.',
        calls: [
          { name: 'file', input: { op: 'write', path: 'notes/plan.md', content: 'step one\nstep two' } },
          { name: 'file', input: { op: 'edit', path: 'notes/absent.md', edits: [{ old_text: 'never', new_text: 'there' }] } },
          { name: 'shell', input: { runtime: 'workspace', command: 'echo started > notes/log.txt' } },
        ],
      });

      return { harness, agent, turns };
    };

    test('its next turn reads what the rewound turns changed, and the rewind starts none', async () => {
      const { harness, agent, turns } = await rewound();
      const before = (await storedChat(harness)).filter((message) => message.role === 'user').at(-1);

      if (before === undefined) throw new Error('the harness recorded no user message');
      await agent.revertConversation(before.id, { chatOnly: true });
      const kept = await storedChat(harness);
      const notice = kept.at(-1);

      expect(lines(kept).slice(0, 2)).toEqual(['first ask', 'ok']);
      expect(kept).toHaveLength(3);
      expect(notice?.role).toBe('user');

      const card = classifyProgrammaticTurn({ metadata: notice?.metadata });

      // A card of its own, from the notice's fields: the file written, and the command that ran.
      expect(card?.kind === 'system_event' ? card.event : card?.kind).toBe(CHAT_REWOUND_EVENT);
      expect(v.parse(v.looseObject({ rewoundPaths: v.array(v.string()), rewoundCommands: v.number() }), notice?.metadata))
        .toMatchObject({ rewoundPaths: ['notes/plan.md'], rewoundCommands: 1 });

      const next = await turns.prepare({ messages: [{ role: 'user', content: 'what changed?' }] });
      const read = JSON.stringify(next.prompt);

      expect(read).toContain('notes/plan.md');
      // A command that ran is told though it failed: whatever it did stands.
      expect(read).toContain('echo started > notes/log.txt');
      // A refused edit changed nothing, so the agent is not told of it.
      expect(read).not.toContain('notes/absent.md');
      await turns.settle({ messageId: 'third-answer', text: 'ok' });
    });

    test('a rewind with the files told of nothing: the chat ends at the cut', async () => {
      const { harness, agent } = await rewound();
      const before = (await storedChat(harness)).filter((message) => message.role === 'user').at(-1);

      if (before === undefined) throw new Error('the harness recorded no user message');
      await agent.revertConversation(before.id, { chatOnly: false });

      expect(lines(await storedChat(harness))).toEqual(['first ask', 'ok']);
    });
  });
});
