import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Connection } from 'agents';
import { AwaitedList, scriptedTurnModel } from '@kinu.run/test-utils';
import { Nimbus } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import * as v from 'valibot';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';
import { mockAgentsSdk } from './helpers/agents-sdk';

// `agents` reaches `cloudflare:email`: mock first, then the harness.
mockAgentsSdk();

const { orchestratorHarness } = await import('./helpers/actor-harness');

import { socketConnection } from './helpers/bindings';

interface AdmissionSocket {
  readonly wire: Connection;
  readonly sent: string[];
  readonly frame: (holds: (sent: readonly string[]) => boolean) => Promise<void>;
}

function connection(agent: { broadcast: (message: string, exclude?: string[]) => void }): AdmissionSocket {
  const frames = new AwaitedList<string>();
  const sent = frames.items;
  const wire = socketConnection({ id: 'soul-conn', send: (data: string) => { frames.push(data); } });
  const fanout = agent.broadcast.bind(agent);

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (exclude === undefined || !exclude.includes('soul-conn')) frames.push(message);
      fanout(message, exclude);
    },
  });

  return { wire, sent, frame: (holds) => frames.until(holds) };
}

function chatRequest(id: string, text: string): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }] }],
      trigger: 'submit-message',
    }) },
  });
}

function doneFrames(sent: readonly string[]): Array<{ id: string }> {
  // Every frame on this socket is JSON the actor wrote; a non-JSON line is a harness failure, not a done frame.
  return sent.flatMap((raw) => {
    const done = v.safeParse(v.object({ type: v.literal('cf_agent_use_chat_response'), id: v.string(), done: v.optional(v.boolean()) }), JSON.parse(raw));

    return done.success && done.output.done === true ? [{ id: done.output.id }] : [];
  });
}

describe('installed Nimbus dependency integrity', () => {
  test('the SDK preserves runtime policy enforcement', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        _rpcReady: async () => ({ ok: true as const, preinstalled: [] }),
      }),
    };

    const box = Nimbus.fromEnv(
      { NIMBUS_SESSION: namespace },
      { sandboxes: { default: { runtimes: { allow: ['node'], onDemand: true } } } },
    ).sandbox('patched-sdk');

    await expect(box.runtimes.install('python')).rejects.toThrow(
      "Nimbus runtime 'python' is not allowed",
    );
  });

  test('xargs null mode preserves leading whitespace in the first argument', async () => {
    const db = new Database(':memory:');

    const workspace = await NimbusWorkspace.create({
      ...inlineWorkspaceStorage(db),
      generation: 1,
      cwd: '/home/main',
    });

    const result = await workspace.exec('xargs -0 -n 1 echo', { stdin: ' leading\0second\0' });

    expect(result).toMatchObject({ exitCode: 0, stdout: ' leading\nsecond\n' });
    db.close();
  });

  // The installed filesystem keeps the main agent at home: the root is 1000:1000 0755, and SOUL.md is a
  // kernel-owned 444 view of the workspace_soul row, resealed from it at every boot and turn start.
  test('a forged SOUL.md never reaches a prompt: the next turn start reseals it from the row', async () => {
    const { agent } = orchestratorHarness();
    const soul = '# Checkout\n\n## Mission\n\nAudit the checkout flow.';

    await agent.setSoul(soul);

    // The root is the main agent's own directory, so its rm and its rewrite land.
    const removed = await agent.execWorkspaceCommand('rm -f /home/main/SOUL.md; echo "exit=$?"');

    expect(removed.stdout.trim()).toBe('exit=0');

    const rewritten = await agent.execWorkspaceCommand('echo rewritten > /home/main/SOUL.md; echo "exit=$?"');

    expect(rewritten.stdout.trim()).toBe('exit=0');

    // The next turn start reseals the file from the row: kernel 444, the owner's bytes.
    agent.harnessSupplyTurnModel(scriptedTurnModel({ doGenerate: () => ({
      content: [{ type: 'text', text: 'noted' }], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
    }) }));
    const gate = agent.harnessChatGate();
    const { wire, sent, frame } = connection(agent);

    await gate(wire, chatRequest('req-soul', 'hello'));
    await frame((frames) => doneFrames(frames).length > 0);
    expect(doneFrames(sent)).toEqual([{ id: 'req-soul' }]);
    const kept = await agent.execWorkspaceCommand('cat /home/main/SOUL.md; stat -c %a /home/main/SOUL.md');

    expect(kept.stdout).toBe(`${soul}444\n`);

    // Neither the prompt's soul nor the status read ever sees the forged text.
    const status = await agent.getAgentStatus();

    expect(status.soul).toBe(soul);
    expect(status.purpose).toBe('Audit the checkout flow.');
  });

  test("an owner's Drive save of SOUL.md updates the row; a Drive delete is refused", async () => {
    const { agent } = orchestratorHarness();
    const soul = '# Checkout\n\n## Mission\n\nAudit the checkout flow.';

    await agent.setSoul(soul);

    const revised = '# Checkout\n\n## Mission\n\nAudit the refunds flow.';


    const saved = await agent.writeExecutorFileChunk({
      executorId: 'workspace', path: 'SOUL.md', transferId: 'soul-save', offset: 0,
      chunk: new TextEncoder().encode(revised), final: true,
    });

    expect(saved).toEqual({ ok: true });
    expect((await agent.getAgentStatus()).soul).toBe(revised);

    const deleted = await agent.deleteExecutorFile('workspace', 'SOUL.md');

    expect(deleted).toMatchObject({ error: expect.stringContaining('Settings') });
    expect((await agent.getAgentStatus()).soul).toBe(revised);
  });
});
