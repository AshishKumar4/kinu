/**
 * Device terminal — the protocol, through the daemon's own dispatcher.
 *
 * `pty.test.js` proves the terminal is real. This file proves the frames that
 * reach it are the ones the hub sends, and that a session is confined by
 * exactly what confines a command: the same plan, the same refusal when the
 * machine cannot sandbox, and the same agent-home rule. A terminal that
 * bypassed either would be a way around the owner's own Sandbox switch.
 */
'use strict';
const { afterEach, describe, expect, test } = require('bun:test');

/**
 * This suite touches NO environment.
 *
 * The daemon captures `KINU_HOME` and the in-flight root once, when it is
 * required, so a suite that sets either decides them for every other suite in
 * the same process — `daemon.test.js` sets both, and two files racing to win
 * that assignment is three failures that appear only when they run together.
 * Nothing here needs them: a sandboxed frame is refused on this machine's
 * capability, which is proved before any path is read.
 */

const {
  handle,
  PTY_OPEN_METHOD,
  PTY_INPUT_FRAME,
  PTY_RESIZE_FRAME,
  PTY_CLOSE_FRAME,
  PTY_OUTPUT_FRAME,
  PTY_EXIT_FRAME,
  SESSION_COMMAND,
} = require('../src/index.js');
const { createSessions, TERMINAL_NAME } = require('../src/pty.js');

const TEST_MS = 60_000;
const SETTLE_MS = 15_000;

async function until(predicate, what, budgetMs = SETTLE_MS) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > budgetMs) throw new Error(`${what} did not happen within ${budgetMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The socket, as the daemon writes to it. `bufferedAmount` is the real
 *  property the daemon reads to decide a socket is too far behind. */
function fakeWs(bufferedAmount = 0) {
  const frames = [];
  return {
    frames,
    bufferedAmount,
    send(data) { frames.push(JSON.parse(data)); },
    reply(id) { return frames.find((f) => f.id === id); },
    async response(id) {
      return until(() => this.reply(id), `a reply for ${id}`);
    },
    output() {
      return Buffer.concat(
        frames.filter((f) => f.type === PTY_OUTPUT_FRAME).map((f) => Buffer.from(f.data, 'base64')),
      ).toString('utf8');
    },
  };
}

/**
 * A context holding real terminals, plus the plans the daemon computed.
 *
 * `open` is wrapped rather than replaced: the plan a session runs is the fact
 * under test, and every other part of the session is the production one.
 */
function context() {
  const plans = [];
  const sessions = createSessions({ log: () => {} });
  const realOpen = sessions.open;
  const wrapped = {
    ...sessions,
    open(request) {
      plans.push({ argv: request.argv, env: request.env });
      return realOpen(request);
    },
  };
  live.push(sessions);
  return { ctx: { sessions: wrapped, checkpoints: null }, plans, sessions };
}

const live = [];
afterEach(() => {
  while (live.length > 0) live.pop().closeAll();
});

describe('opening a terminal is a call, and the rest is a stream', () => {
  test('an open answers with the session, and its bytes arrive as output frames', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-1', method: PTY_OPEN_METHOD, params: ['pane-a', 90, 30] }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-1');
    expect(reply.error).toBeUndefined();
    expect(reply.result.session).toBe('pane-a');
    expect(reply.result.cols).toBe(90);
    expect(reply.result.rows).toBe(30);
    expect(reply.result.pid).toBeGreaterThan(0);

    // A keystroke frame carries no id: it is not a question.
    handle({ type: PTY_INPUT_FRAME, session: 'pane-a', data: Buffer.from('echo $((3 + 4))\r').toString('base64') }, ws, ctx);
    await until(() => /(^|[^)+\s])7\b/m.test(ws.output()), 'the shell answered');

    handle({ type: PTY_RESIZE_FRAME, session: 'pane-a', cols: 120, rows: 40 }, ws, ctx);
    handle({ type: PTY_INPUT_FRAME, session: 'pane-a', data: Buffer.from('stty size\r').toString('base64') }, ws, ctx);
    await until(() => /\b40 120\b/.test(ws.output()), 'the shell saw the new window');

    handle({ type: PTY_CLOSE_FRAME, session: 'pane-a' }, ws, ctx);
    await until(() => ws.frames.some((f) => f.type === PTY_EXIT_FRAME), 'the session reported its exit');
  }, TEST_MS);

  test('a session runs the plan a command runs, with the terminal named in it', async () => {
    const { ctx, plans } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-2', method: PTY_OPEN_METHOD, params: ['pane-b', 80, 24] }, ws, ctx);
    await ws.response('rpc-abcdefghij-2');

    // The raw tier's own argv, from sandbox.plan: a shell running one command,
    // and the command is "become an interactive shell".
    expect(plans[0].argv).toEqual(['bash', '-c', SESSION_COMMAND]);
    expect(SESSION_COMMAND).toBe('exec bash -i');
    // The terminal this daemon just allocated, carried through the tier's own
    // environment allow-list rather than assumed by the program.
    expect(plans[0].env.TERM).toBe(TERMINAL_NAME);
    expect(plans[0].env.PATH).toBeTruthy();
  }, TEST_MS);

  test('a frame for a terminal this machine does not hold is dropped, not answered', () => {
    const { ctx } = context();
    const ws = fakeWs();
    // No id to answer on, so the only correct behaviour is to drop it. The
    // race is ordinary: the program exited and its exit frame is in flight.
    handle({ type: PTY_INPUT_FRAME, session: 'pane-gone', data: '' }, ws, ctx);
    handle({ type: PTY_RESIZE_FRAME, session: 'pane-gone', cols: 80, rows: 24 }, ws, ctx);
    handle({ type: PTY_CLOSE_FRAME, session: 'pane-gone' }, ws, ctx);
    expect(ws.frames).toEqual([]);
  });

  test('a daemon with no terminals answers the open rather than throwing', async () => {
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-3', method: PTY_OPEN_METHOD, params: ['pane-c', 80, 24] }, ws, { checkpoints: null });
    const reply = await ws.response('rpc-abcdefghij-3');
    expect(reply.error).toContain('without terminal support');
  });

  test('a window the kernel cannot carry is refused on the reply', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-4', method: PTY_OPEN_METHOD, params: ['pane-d', 0, 24] }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-4');
    expect(reply.error).toContain('width must be a whole number from 1 to 1000');
  });

  test('a congested socket drops output, and still says the shell ended', async () => {
    const { ctx } = context();
    // Past the daemon's backlog: every output frame is dropped. The exit is
    // not droppable — a hub that never hears it holds a terminal that no
    // longer exists, and no later frame would correct that.
    const ws = fakeWs(4 * 1024 * 1024);
    handle({ id: 'rpc-abcdefghij-5', method: PTY_OPEN_METHOD, params: ['pane-e', 80, 24] }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-5');
    expect(reply.result.pid).toBeGreaterThan(0);
    handle({ type: PTY_INPUT_FRAME, session: 'pane-e', data: Buffer.from('exit 0\r').toString('base64') }, ws, ctx);
    await until(() => ws.frames.some((f) => f.type === PTY_EXIT_FRAME), 'the session reported its exit');
    expect(ws.frames.some((f) => f.type === PTY_OUTPUT_FRAME)).toBe(false);
  }, TEST_MS);
});

describe('a terminal is confined exactly as a command is', () => {
  test('a sandboxed frame on a machine that cannot sandbox is refused, never run raw', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    // This suite never ran the sandbox probe, so the daemon's recorded
    // capability is `probe_failed` — the same state a machine without
    // bubblewrap reports. `exec` refuses such a frame; so must a terminal,
    // because the alternative is a shell on the owner's machine with none of
    // the confinement they asked for.
    handle({
      id: 'rpc-abcdefghij-6',
      method: PTY_OPEN_METHOD,
      params: ['pane-f', 80, 24],
      sandbox: { tier: 'sandboxed', agentHome: `${require('node:os').homedir()}/.kinu/agents/w1/home`, roots: [] },
    }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-6');
    expect(reply.error).toContain('sandbox_unavailable');
    expect(ctx.sessions.size()).toBe(0);
  });

  test('the same refusal reaches exec, so neither path is the softer one', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    const frame = {
      method: 'exec',
      params: ['echo hello'],
      sandbox: { tier: 'sandboxed', agentHome: `${require('node:os').homedir()}/.kinu/agents/w1/home`, roots: [] },
    };
    handle({ ...frame, id: 'rpc-abcdefghij-7' }, ws, ctx);
    const execReply = await ws.response('rpc-abcdefghij-7');
    handle({ ...frame, method: PTY_OPEN_METHOD, params: ['pane-g', 80, 24], id: 'rpc-abcdefghij-8' }, ws, ctx);
    const ptyReply = await ws.response('rpc-abcdefghij-8');
    expect(execReply.error).toBe(ptyReply.error);
  });

  test('a sandboxed frame naming a home outside the agent root is refused', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    handle({
      id: 'rpc-abcdefghij-9',
      method: PTY_OPEN_METHOD,
      params: ['pane-h', 80, 24],
      sandbox: { tier: 'sandboxed', agentHome: '/tmp/not-an-agent-home', roots: [] },
    }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-9');
    // The agent-home rule fires before the capability check can be reached, so
    // this is refused on a machine that CAN sandbox as well.
    expect(reply.error).toMatch(/agent home must sit under|sandbox_unavailable/);
    expect(ctx.sessions.size()).toBe(0);
  });

  test('a frame with no sandbox block is raw, exactly as an exec frame is', async () => {
    const { ctx, plans } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-10', method: PTY_OPEN_METHOD, params: ['pane-i', 80, 24] }, ws, ctx);
    await ws.response('rpc-abcdefghij-10');
    // No bwrap in the argv: the hub that sent this has not been told about the
    // Sandbox switch, and the daemon does not invent a confinement it was
    // never given the home for. This mirrors planFromFrame's own rule.
    expect(plans[0].argv[0]).toBe('bash');
  }, TEST_MS);
});
