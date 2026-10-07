/**
 * The actor's seam of the workspace terminal: which sockets reach the shell, and that broadcasts skip them. The workerd
 * tier (slate-durability.test.ts) drives real sockets: a typed line, a reattach's replay, a refused frame.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import type { Connection } from 'agents';
import { orchestratorHarness } from './helpers/actor-harness';
import { WORKSPACE_TERMINAL_TAG } from '@kinu.run/core';
import type { TerminalSocket, WorkspaceTerminal } from '../src/workspace-host';
import { socketConnection } from './helpers/bindings';

// After the harness registers the SDK mock: a static import would bind it to the real `agents` Agent.
const { ActorAgent } = await import('../src/actor-agent');

interface RecordedTerminal {
  readonly terminal: WorkspaceTerminal;
  readonly calls: string[];
}

function recordedTerminal(): RecordedTerminal {
  const calls: string[] = [];

  return {
    calls,
    terminal: {
      attachTerminal: async (ws) => { calls.push(`attach:${socketId(ws)}`); },
      terminalFrame: async (ws, frame) => { calls.push(`frame:${socketId(ws)}:${v.parse(v.string(), frame)}`); },
      terminalClose: (ws) => { calls.push(`close:${socketId(ws)}`); },
    },
  };
}

function socketId(ws: TerminalSocket): string {
  return v.parse(v.object({ id: v.string() }), ws).id;
}

interface FakeConnection {
  readonly wire: Connection;
  readonly sent: string[];
  readonly closed: Array<{ code: number; reason: string }>;
}

function connection(id: string, tags: string[]): FakeConnection {
  const sent: string[] = [];
  const closed: FakeConnection['closed'] = [];

  return {
    wire: socketConnection({
      id, tags,
      send: (data) => { sent.push(v.parse(v.string(), data)); },
      close: (code, reason) => { closed.push({ code: v.parse(v.number(), code), reason: v.parse(v.string(), reason) }); },
    }),
    sent,
    closed,
  };
}

describe('the actor hands a terminal socket to the runtime shell', () => {
  async function activated() {
    const agent = orchestratorHarness().agent;
    const recorded = recordedTerminal();

    // bun cannot host the hosted runtime, so a recording shell answers; `terminalFor` is protected, hence the property write.
    Object.defineProperty(agent, 'terminalFor', {
      configurable: true,
      value: (wire: Connection) => Promise.resolve(wire.tags.includes(WORKSPACE_TERMINAL_TAG) ? recorded.terminal : null),
    });

    return { agent, gate: agent.harnessChatGate(), recorded };
  }

  test('a tagged socket is attached on connect, framed on input, and closed with the socket', async () => {
    const { agent, gate, recorded } = await activated();
    const pane = connection('pane', [WORKSPACE_TERMINAL_TAG]);

    await agent.onConnect(pane.wire, { request: new Request('https://agent/_kinu/workspace-terminal') });
    await gate(pane.wire, JSON.stringify({ type: 'input', data: 'ls\r' }));
    await gate(pane.wire, JSON.stringify({ type: 'resize', cols: 120, rows: 40, extra: 'dropped' }));
    await agent.onClose(pane.wire, 1000, 'tab closed', true);

    expect(recorded.calls).toEqual([
      'attach:pane',
      'frame:pane:{"type":"input","data":"ls\\r"}',
      'frame:pane:{"type":"resize","cols":120,"rows":40}',
      'close:pane',
    ]);
    expect(pane.closed).toEqual([]);
  });

  test('a socket without the tag is a chat socket: the shell is never reached', async () => {
    const { agent, recorded } = await activated();
    const chat = connection('chat', []);

    await agent.onConnect(chat.wire, { request: new Request('https://agent/connect') });
    await agent.onClose(chat.wire, 1000, 'gone', true);

    expect(recorded.calls).toEqual([]);
  });

  test('the object\'s fan-out skips its terminal sockets', async () => {
    const { agent } = await activated();
    const pane = connection('pane', [WORKSPACE_TERMINAL_TAG]);
    const chat = connection('chat', []);
    const base = Object.getPrototypeOf(ActorAgent.prototype);
    const fanout = spyOn(base, 'broadcast');

    try {
      Object.defineProperty(agent, 'getConnections', {
        configurable: true,
        value: function* () { yield pane.wire; yield chat.wire; },
      });

      agent.broadcast(JSON.stringify({ type: 'reads_changed', reads: ['listSubordinates'] }));
      agent.broadcast('again', ['chat']);

      expect(fanout.mock.calls.map(([, without]) => without)).toEqual([['pane'], ['chat', 'pane']]);
    } finally {
      fanout.mockRestore();
    }
  });
});
