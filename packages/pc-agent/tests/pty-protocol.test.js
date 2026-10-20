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

const fs = require('node:fs');

const path = require('node:path');

const { AwaitedList, scratchDir } = require('@kinu.run/test-utils');

/** This suite changes no environment. The daemon fixture reloads its own module after declaring its home;
 * these terminal cases need only this machine's capability, which is proved before any path is read. */

const {
  handle,
  PTY_OPEN_METHOD,
  PTY_INPUT_FRAME,
  PTY_RESIZE_FRAME,
  CANCEL_METHOD,
  PTY_OUTPUT_FRAME,
  PTY_EXIT_FRAME,
  SESSION_COMMAND,
} = require('../src/index.js');

const { createSessions, TERMINAL_NAME } = require('../src/pty.js');

const { createTerminalRecords } = require('../src/daemon/terminals.js');

/** The workspace every frame here is from, as the hub names the proven one. */
const WORKSPACE = 'workspace-a';

/** The block a hub with the owner's Sandbox switch OFF sends. */
const RAW = { tier: 'raw', agentHome: '', roots: [] };


/** The socket, as the daemon writes to it. `bufferedAmount` is the real
 *  property the daemon reads to decide a socket is too far behind. */
function fakeWs(bufferedAmount = 0) {
  const recorded = new AwaitedList();
  const frames = recorded.items;

  return {
    frames,
    bufferedAmount,
    send(data) { recorded.push(JSON.parse(data)); },
    reply(id) { return frames.find((f) => f.id === id); },
    async response(id) {
      await recorded.until((items) => items.some((frame) => frame.id === id));

      return frames.find((frame) => frame.id === id);
    },
    until: (holds) => recorded.until(holds),
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
  const terminals = createTerminalRecords({ file: path.join(scratchDir('pty-protocol'), 'terminals.json') });

  return { ctx: { sessions: wrapped, terminals, checkpoints: null }, plans, sessions, terminals };
}

const live = [];

/**
 * Ends every shell `sessions` holds and awaits each one's exit. A kill alone is not an exit: the shell stays this
 * process's child until it is reaped, and the preload's check at the file's end found one still there on 2 of 7
 * tiers (`left 1 process(es) ... bash -i`, kinu-20261020035607-956688e7).
 */
async function endAll(sessions) {
  await Promise.all(sessions.detachAll().map((name) => sessions.close(name).ended));
}

afterEach(async () => {
  while (live.length > 0) await endAll(live.pop());
});

describe('opening a terminal is a call, and the rest is a stream', () => {
  test('cancel acknowledges a terminal only after it stops, even when its program ignores hangup', async () => {
    const { ctx, sessions } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-ptyforce00-1', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24] }, ws, ctx);
    const opened = await ws.response('rpc-ptyforce00-1');
    const { pid, session } = opened.result;

    try {
      handle({ type: PTY_INPUT_FRAME, session, data: Buffer.from("trap '' HUP; echo $((11 + 12)); exec sleep 600\r").toString('base64') }, ws, ctx);
      await ws.until(() => /(^|[^)+\s])23\b/m.test(ws.output()));
      handle({ id: 'cancel-force-pty', method: CANCEL_METHOD, params: [session] }, ws, ctx);
      expect((await ws.response('cancel-force-pty')).result).toEqual({ requestId: session, cancelled: 'terminated' });
      expect(sessions.has(session)).toBe(false);
    } finally {
      if (sessions.has(session)) process.kill(pid, 'SIGKILL');
    }
  });

  test('an open answers with the session, and its bytes arrive as output frames', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-1', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [90, 30] }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-1');
    const session = reply.result.session;

    expect(reply.error).toBeUndefined();
    // The workspace's first session, named by the daemon, not by the call that opened it.
    expect(session).toBe(ctx.terminals.list(WORKSPACE)[0].id);
    expect(reply.result.cols).toBe(90);
    expect(reply.result.rows).toBe(30);
    expect(reply.result.pid).toBeGreaterThan(0);

    // A keystroke frame carries no id: it is not a question.
    handle({ type: PTY_INPUT_FRAME, session, data: Buffer.from('echo $((3 + 4))\r').toString('base64') }, ws, ctx);
    await ws.until(() => /(^|[^)+\s])7\b/m.test(ws.output()));

    handle({ type: PTY_RESIZE_FRAME, session, cols: 120, rows: 40 }, ws, ctx);
    handle({ type: PTY_INPUT_FRAME, session, data: Buffer.from('stty size\r').toString('base64') }, ws, ctx);
    await ws.until(() => /\b40 120\b/.test(ws.output()));

    handle({ id: 'cancel-pane-a', method: CANCEL_METHOD, params: [session] }, ws, ctx);
    await ws.until(() => ws.frames.some((f) => f.type === PTY_EXIT_FRAME));
  });

  test('a session runs the plan a command runs, with the terminal named in it', async () => {
    const { ctx, plans } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-2', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24] }, ws, ctx);
    await ws.response('rpc-abcdefghij-2');

    // The raw tier's own argv, from sandbox.plan: a shell running one command,
    // and the command is "become an interactive shell".
    expect(plans[0].argv).toEqual(['bash', '-c', SESSION_COMMAND]);
    // The terminal this daemon just allocated, carried through the tier's own
    // environment allow-list rather than assumed by the program.
    expect(plans[0].env.TERM).toBe(TERMINAL_NAME);
    expect(plans[0].env.PATH).toBeTruthy();
  });

  test('a frame for a terminal this machine does not hold is dropped, not answered', () => {
    const { ctx } = context();
    const ws = fakeWs();
    // No id to answer on, so the only correct behaviour is to drop it. The
    // race is ordinary: the program exited and its exit frame is in flight.
    handle({ type: PTY_INPUT_FRAME, session: 'pane-gone', data: '' }, ws, ctx);
    handle({ type: PTY_RESIZE_FRAME, session: 'pane-gone', cols: 80, rows: 24 }, ws, ctx);
    expect(ws.frames).toEqual([]);
  });

  test('a daemon with no terminals answers the open rather than throwing', async () => {
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-3', method: PTY_OPEN_METHOD, params: [80, 24] }, ws, { checkpoints: null });
    const reply = await ws.response('rpc-abcdefghij-3');
    expect(reply.error).toMatchObject({ code: 'io' });
  });

  test('a window the kernel cannot carry is refused on the reply', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-4', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [0, 24] }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-4');
    expect(reply.error).toMatchObject({ code: 'io' });
  });

  test('a congested socket drops output, and still says the shell ended', async () => {
    const { ctx } = context();
    // Past the daemon's backlog: every output frame is dropped. The exit is
    // not droppable — a hub that never hears it holds a terminal that no
    // longer exists, and no later frame would correct that.
    const ws = fakeWs(4 * 1024 * 1024);
    handle({ id: 'rpc-abcdefghij-5', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24] }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-5');
    expect(reply.result.pid).toBeGreaterThan(0);
    handle({ type: PTY_INPUT_FRAME, session: reply.result.session, data: Buffer.from('exit 0\r').toString('base64') }, ws, ctx);
    await ws.until(() => ws.frames.some((f) => f.type === PTY_EXIT_FRAME));
    expect(ws.frames.some((f) => f.type === PTY_OUTPUT_FRAME)).toBe(false);
  });
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
      workspace: WORKSPACE,
      params: [80, 24],
      sandbox: { tier: 'sandboxed', agentHome: `${require('node:os').homedir()}/.kinu/agents/w1/home`, roots: [] },
    }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-6');
    expect(reply.error?.message).toContain('sandbox_unavailable');
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
    handle({ ...frame, method: PTY_OPEN_METHOD, workspace: WORKSPACE, params: [80, 24], id: 'rpc-abcdefghij-8' }, ws, ctx);
    const ptyReply = await ws.response('rpc-abcdefghij-8');
    expect(execReply.error).toEqual(ptyReply.error);
  });

  test('a sandboxed frame naming a home outside the agent root is refused', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    handle({
      id: 'rpc-abcdefghij-9',
      method: PTY_OPEN_METHOD,
      workspace: WORKSPACE,
      params: [80, 24],
      sandbox: { tier: 'sandboxed', agentHome: '/tmp/not-an-agent-home', roots: [] },
    }, ws, ctx);
    const reply = await ws.response('rpc-abcdefghij-9');
    // Refused either way: by the capability on a machine that cannot sandbox,
    // and by the agent-home rule on one that can.
    expect(reply.error).toMatchObject({ code: expect.any(String) });
    expect(ctx.sessions.size()).toBe(0);
  });

  test('a frame with no sandbox block is refused, exactly as an exec frame is', async () => {
    const { ctx } = context();
    const ws = fakeWs();
    handle({ id: 'rpc-abcdefghij-10', method: PTY_OPEN_METHOD, workspace: WORKSPACE, params: [80, 24] }, ws, ctx);
    handle({ id: 'rpc-abcdefghij-11', method: 'exec', params: ['echo hello'] }, ws, ctx);
    const ptyReply = await ws.response('rpc-abcdefghij-10');
    // A shell on the owner's machine with no tier is a shell with none of the
    // confinement they chose, so the absence is a refusal on both paths.
    expect(ptyReply.error).toMatchObject({ code: 'io' });
    expect((await ws.response('rpc-abcdefghij-11')).error).toEqual(ptyReply.error);
    expect(ctx.sessions.size()).toBe(0);
  });
});

// 1014-t: a PC's terminal is a workspace's named session. It outlives its pane and the socket that carried it, a daemon
// restart brings it back fresh under its name and in its folder, and a workspace sees only its own.
describe("a workspace's named sessions", () => {
  const protocol = require('../src/device-protocol.json');

  const call = async (ws, ctx, frame) => {
    handle(frame, ws, ctx);

    return (await ws.response(frame.id)).result;
  };

  // 1019-aa: a PC's row says what the computer's does, read from /proc: the folder its shell is in now (kept for a
  // restart), that folder's branch, the ports a process under it listens on, and a program waiting for an answer.
  test('a session lists the folder it is in, its branch, the ports under it, and a program waiting for input', async () => {
    if (process.platform !== 'linux') return;
    const { ctx } = context();
    const ws = fakeWs();
    const repo = scratchDir('pty-named-repo');
    const say = (line) => handle({ type: PTY_INPUT_FRAME, session: opened.session, data: Buffer.from(line).toString('base64') }, ws, ctx);

    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/rows\n');
    const opened = await call(ws, ctx, { id: 'rpc-named-facts', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24] });

    say(`python3 -c 'import socket, time; s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(); print("port", s.getsockname()[1], flush=True); time.sleep(60)' &\r`);
    await ws.until(() => /port (\d+)/.test(ws.output()));
    const port = Number(/port (\d+)/.exec(ws.output())[1]);

    say(`cd ${repo} && read answer\r`);
    await ws.until(() => ws.output().includes('read answer'));

    // The list asked until the shell has done what it was told: each answer is a read of the system as it is then.
    let asked = 0;

    const listedWhen = async (holds) => {
      for (;;) {
        asked += 1;
        const [row] = await call(ws, ctx, { id: `rpc-named-facts-${asked}`, method: 'ptyList', workspace: WORKSPACE, params: [] });

        if (holds(row) || asked > 5000) return row;
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    };

    const waiting = await listedWhen((row) => row.needsInput);

    say('yes\rsleep 30\r');
    const sleeping = await listedWhen((row) => row.running === 'sleep');

    expect({
      waiting: { cwd: waiting.cwd, branch: waiting.branch, ports: waiting.ports, needsInput: waiting.needsInput, running: waiting.running },
      sleeping: { running: sleeping.running, needsInput: sleeping.needsInput },
      kept: ctx.terminals.find(WORKSPACE, opened.session).cwd,
    }).toEqual({
      waiting: { cwd: repo, branch: 'feature/rows', ports: [port], needsInput: true, running: null },
      sleeping: { running: 'sleep', needsInput: false },
      kept: repo,
    });
  });

  test("a pane's detach keeps the shell and its newest output; the next open resumes that shell and shows it first", async () => {
    const { ctx } = context();
    const ws = fakeWs();
    const opened = await call(ws, ctx, { id: 'rpc-named-open1', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24] });

    handle({ type: PTY_INPUT_FRAME, session: opened.session, data: Buffer.from('echo first-$((1 + 1))\r').toString('base64') }, ws, ctx);
    await ws.until(() => /first-2/.test(ws.output()));
    handle({ type: protocol.frames.ptyDetach, session: opened.session }, ws, ctx);
    handle({ type: PTY_INPUT_FRAME, session: opened.session, data: Buffer.from('echo second-$((2 + 2))\r').toString('base64') }, ws, ctx);

    const later = fakeWs();
    const resumed = await call(later, ctx, { id: 'rpc-named-open2', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [100, 30, opened.session] });

    await later.until(() => /second-4/.test(later.output()));
    expect({ resumed: resumed.resumed, pid: resumed.pid === opened.pid, first: later.output().includes('first-2'), detachedSent: /second-4/.test(ws.output()) })
      .toEqual({ resumed: true, pid: true, first: true, detachedSent: false });
  });

  test('a socket gone detaches every session, and a workspace lists, names and closes only its own', async () => {
    const { ctx, sessions } = context();
    const ws = fakeWs();
    const [first] = await call(ws, ctx, { id: 'rpc-named-list1', method: 'ptyList', workspace: WORKSPACE, params: [] });
    const opened = await call(ws, ctx, { id: 'rpc-named-open3', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24, first.id] });
    const second = await call(ws, ctx, { id: 'rpc-named-create', method: 'ptyCreate', workspace: WORKSPACE, params: [] });
    const renamed = await call(ws, ctx, { id: 'rpc-named-rename', method: 'ptyRename', workspace: WORKSPACE, params: [second.id, 'dev server'] });
    const elsewhere = await call(ws, ctx, { id: 'rpc-named-list2', method: 'ptyList', workspace: 'workspace-b', params: [] });

    expect({ first: { name: first.name, open: first.open }, second: second.name, renamed: renamed.name, elsewhere: elsewhere.map((session) => session.name), mine: elsewhere.some((session) => session.id === first.id) })
      .toEqual({ first: { name: 'shell', open: false }, second: 'shell 2', renamed: 'dev server', elsewhere: ['shell'], mine: false });

    expect(sessions.detachAll()).toEqual([opened.session]);
    await call(ws, ctx, { id: 'rpc-named-close', method: 'ptyClose', workspace: WORKSPACE, params: [first.id] });
    const left = await call(ws, ctx, { id: 'rpc-named-list3', method: 'ptyList', workspace: WORKSPACE, params: [] });

    expect({ shellEnded: sessions.has(first.id), left: left.map((session) => session.name) }).toEqual({ shellEnded: false, left: ['dev server'] });
  });

  test('a daemon restart brings a session back under its name, in its folder, with a fresh shell', async () => {
    const folder = scratchDir('pty-named-folder');
    const records = path.join(scratchDir('pty-named-restart'), 'terminals.json');
    const before = createTerminalRecords({ file: records });
    const [shell] = before.list(WORKSPACE);
    const firstLife = createSessions({ log: () => {} });

    live.push(firstLife);
    const ws = fakeWs();
    const opened = await call(ws, { sessions: firstLife, terminals: before, checkpoints: null }, { id: 'rpc-named-life1', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, cwd: folder, params: [80, 24, shell.id] });

    // The daemon ends, and its shells with it.
    await endAll(firstLife);
    // The next daemon reads the same file and holds no shell.
    const after = createTerminalRecords({ file: records });
    const secondLife = createSessions({ log: () => {} });

    live.push(secondLife);
    const again = fakeWs();
    const reopened = await call(again, { sessions: secondLife, terminals: after, checkpoints: null }, { id: 'rpc-named-life2', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24, shell.id] });

    handle({ type: PTY_INPUT_FRAME, session: shell.id, data: Buffer.from('pwd\r').toString('base64') }, again, { sessions: secondLife, terminals: after, checkpoints: null });
    await again.until(() => again.output().includes(folder));
    expect({ name: after.find(WORKSPACE, shell.id)?.name, resumed: reopened.resumed, fresh: reopened.pid !== opened.pid }).toEqual({ name: 'shell', resumed: false, fresh: true });
  });

  test('a close that lands while an open plans leaves no shell behind it', async () => {
    const { ctx, sessions } = context();
    const ws = fakeWs();
    const [first] = ctx.terminals.list(WORKSPACE);

    handle({ id: 'rpc-named-race-open', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24, first.id] }, ws, ctx);
    handle({ id: 'rpc-named-race-close', method: 'ptyClose', workspace: WORKSPACE, params: [first.id] }, ws, ctx);
    const opened = await ws.response('rpc-named-race-open');

    expect({ error: opened.error?.message, shells: sessions.size(), listed: ctx.terminals.find(WORKSPACE, first.id) })
      .toEqual({ error: 'that terminal session was closed while it opened', shells: 0, listed: null });
  });

  test("two daemons on one file, as an update's successor beside its predecessor, each read the other's changes", () => {
    const file = path.join(scratchDir('pty-named-shared'), 'terminals.json');
    const predecessor = createTerminalRecords({ file });
    const successor = createTerminalRecords({ file });
    const made = predecessor.create(WORKSPACE);

    successor.rename(WORKSPACE, made.id, 'dev server');
    expect(predecessor.list(WORKSPACE).map((record) => record.name)).toEqual(['shell', 'dev server']);
    // A workspace's name is a key, never a property of the map that holds them.
    expect(successor.list('constructor').map((record) => record.name)).toEqual(['shell']);
  });

  test('a shell opened under another confinement is ended and opened again, never handed back', async () => {
    const { ctx, sessions } = context();
    const ws = fakeWs();
    const opened = await call(ws, ctx, { id: 'rpc-named-raw1', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: RAW, params: [80, 24] });
    const narrower = { ...RAW, roots: [scratchDir('pty-named-root')] };
    const reopened = await call(ws, ctx, { id: 'rpc-named-raw2', method: PTY_OPEN_METHOD, workspace: WORKSPACE, sandbox: narrower, params: [80, 24, opened.session] });

    expect({ resumed: reopened.resumed, fresh: reopened.pid !== opened.pid, held: sessions.size() }).toEqual({ resumed: false, fresh: true, held: 1 });
  });
});
