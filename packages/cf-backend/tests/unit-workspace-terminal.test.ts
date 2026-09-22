/**
 * The workspace shell, at its two seams.
 *
 * The runtime half is measured over the real hosted runtime: the frames it
 * writes are the ones the pane parses, a typed line runs, and a reattach
 * replays what was painted. The actor half is measured through the production
 * socket handlers: a socket tagged as the terminal reaches the shell and
 * nothing else, a frame of the wrong shape closes it, and the object's fan-out
 * never lands on it. The tag is what ties the two halves together, and the
 * workerd tier (slate-durability.test.ts) drives one real socket through both.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import type { Connection } from 'agents';
import { AwaitedList } from '@kinu.run/test-utils';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { programmaticHostOver } from './helpers/programmatic-host';
import { orchestratorHarness } from './helpers/actor-harness';
import { ActorAgent } from '../src/actor-agent';
import { WORKSPACE_TERMINAL_TAG, WorkspaceTerminalOutputSchema } from '@kinu.run/core';
import type { WorkspaceTerminal } from '../src/workspace-host';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

async function openRuntimeTerminal(): Promise<WorkspaceTerminal> {
  const database = new Database(':memory:');
  databases.push(database);

  const sql: SqlDatabase = {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);

      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);

      return [];
    },
  };

  const workspace = await NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
    generation: 1,
    processes: new SessionProcessSupervisor(),
  });

  return await programmaticHostOver(workspace).runtime();
}

interface PaneSocket {
  readonly ws: WebSocket;
  /** Every frame the runtime wrote, as the pane would parse it. */
  readonly frames: Array<v.InferOutput<typeof WorkspaceTerminalOutputSchema>>;
  /** Resolves once the painted output holds `text`. */
  readonly painted: (text: string) => Promise<void>;
  readonly output: () => string;
}

/** The pane's end of the wire: a socket that keeps what the runtime sent. */
function paneSocket(): PaneSocket {
  const raw = new AwaitedList<string>();
  const frames: PaneSocket['frames'] = [];
  const output = () => frames.flatMap((frame) => frame.type === 'output' ? [frame.data] : []).join('');
  const partial: Partial<WebSocket> = {};
  Object.assign(partial, {
    send: (data: string) => {
      const parsed = v.safeParse(WorkspaceTerminalOutputSchema, JSON.parse(data));

      if (parsed.success) frames.push(parsed.output);
      raw.push(data);
    },
    close: () => {},
  });

  // SAFETY: the runtime's terminal reaches `send` and nothing else of a
  // socket it was attached to — the members constructed above exhaust what
  // the code under test can touch.
  const ws = partial as WebSocket;

  return { ws, frames, output, painted: (text) => raw.until(() => output().includes(text)) };
}

describe('the runtime terminal speaks the frames the pane paints', () => {
  test('attach says ready, a typed line runs, and a reattach replays the screen', async () => {
    const terminal = await openRuntimeTerminal();
    const first = paneSocket();

    await terminal.attachTerminal(first.ws);
    expect(first.frames.map((frame) => frame.type)).toContain('ready');

    await terminal.terminalFrame(first.ws, JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    await terminal.terminalFrame(first.ws, JSON.stringify({ type: 'input', data: 'echo shell-$((20+3))\r' }));
    await first.painted('shell-23');
    terminal.terminalClose(first.ws);

    // The next socket lands on the same screen: the runtime replays what the
    // first one was painted, before it says ready.
    const second = paneSocket();
    await terminal.attachTerminal(second.ws);
    expect(second.output()).toContain('shell-23');
    expect(second.frames.at(-1)?.type).toBe('ready');
  });
});

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

function socketId(ws: WebSocket): string {
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
  const partial: Partial<Connection> = {};
  Object.assign(partial, {
    id, tags,
    send: (data: string) => { sent.push(data); },
    close: (code: number, reason: string) => { closed.push({ code, reason }); },
  });

  // SAFETY: every member the socket handlers read is constructed above (`id`,
  // `tags`, `send`, `close`); the platform contract for a hibernated
  // connection carries its tags and its wire and nothing else.
  return { wire: partial as Connection, sent, closed };
}

describe('the actor hands a terminal socket to the runtime shell', () => {
  async function activated() {
    // Instantiation runs the activation, and with it the socket gate — once.
    const agent = orchestratorHarness().agent;
    const recorded = recordedTerminal();

    // The root's own answer composes the hosted runtime, which bun cannot host;
    // the seam is answered by a recording shell so the dispatch is what is
    // measured. `terminalFor` is a protected member, hence the property write.
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

    // The frame the shell receives is the parsed one: what the schema admits,
    // and nothing a client appended.
    expect(recorded.calls).toEqual([
      'attach:pane',
      'frame:pane:{"type":"input","data":"ls\\r"}',
      'frame:pane:{"type":"resize","cols":120,"rows":40}',
      'close:pane',
    ]);
    expect(pane.closed).toEqual([]);
  });

  test('a frame of the wrong shape closes the socket, and the shell never sees it', async () => {
    const { gate, recorded } = await activated();
    const pane = connection('pane', [WORKSPACE_TERMINAL_TAG]);

    await gate(pane.wire, JSON.stringify({ type: 'rpc', id: '1', method: 'exportWorkspaceArchive' }));
    await gate(pane.wire, 'not json');
    await gate(pane.wire, new ArrayBuffer(4));

    expect(recorded.calls).toEqual([]);
    expect(pane.closed.map((close) => close.code)).toEqual([1008, 1008, 1008]);
    expect(pane.closed[0]?.reason).toContain('terminal frame refused');
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
      // The mocked base holds no sockets; these two are what the object sees.
      Object.defineProperty(agent, 'getConnections', {
        configurable: true,
        value: function* () { yield pane.wire; yield chat.wire; },
      });

      agent.broadcast(JSON.stringify({ type: 'subordinates_changed' }));
      agent.broadcast('again', ['chat']);

      expect(fanout.mock.calls.map(([, without]) => without)).toEqual([['pane'], ['chat', 'pane']]);
    } finally {
      fanout.mockRestore();
    }
  });
});
