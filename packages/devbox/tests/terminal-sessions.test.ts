// D90: the computer's terminal sessions. tmux is the box's, so the read's rows are given here as the box's read
// prints them; the product flow `computer-sessions` reads a real computer's.
import { TestDevbox } from './support/test-devbox';
import { describe, expect, test } from 'bun:test';

import { FIRST_SESSION, jobSessionId, jobSessionName, mergeSessions, newSessionId, newSessionName, parseSessionsRead } from '../src/sessions';
import { harness } from './support/devbox-harness';

class SessionBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

const row = (...fields: Array<string | number>) => fields.join('\t');

const READ = [
  row('P', 'shell', '/workspace/storefront', 'bash', 0, 1_791_900_000, 'git status'),
  row('P', 's2', '/workspace/storefront', 'node', '', '', ''),
  row('P', 's3', '/tmp', 'bash', 2, 1_791_900_060, 'npx vitest run'),
  row('L', 's2', 5173),
  row('L', 's2', 5173),
  row('L', 'nobody', 8080),
  row('B', '/workspace/storefront', 'main'),
  '',
].join('\n');

describe('a read of the running sessions', () => {
  const read = parseSessionsRead(READ);

  test('names each session\'s folder, the branch there, and the ports under its shell, each once', () => {
    expect(read.get('s2')).toMatchObject({ cwd: '/workspace/storefront', branch: 'main', ports: [5173] });
    expect(read.get('s3')).toMatchObject({ cwd: '/tmp', branch: null, ports: [] });
  });

  test('a shell at its prompt runs nothing, and its last command is how it ended', () => {
    expect(read.get('shell')).toMatchObject({ running: null, last: { exit: 0, command: 'git status' } });
    expect(read.get('s3')?.last?.exit).toBe(2);
  });

  test('a program in the foreground is what runs, and a session that ran nothing yet has no last command', () => {
    expect(read.get('s2')).toMatchObject({ running: 'node', last: null });
  });

  test('a session whose foreground reads its terminal needs input; one at its own prompt does not', () => {
    const waiting = parseSessionsRead([READ, row('W', 's2')].join('\n'));

    expect(waiting.get('s2')?.needsInput).toBe(true);
    expect(waiting.get('shell')?.needsInput).toBe(false);
  });

  test('a row naming no session the box keeps, or no session at all, is no session', () => {
    expect(parseSessionsRead(row('P', 'Bad.Name', '/', 'bash', '', '', '')).size).toBe(0);
    expect(mergeSessions([FIRST_SESSION], read).map((session) => session.id)).toEqual(['shell']);
  });
});

describe('the recorded sessions', () => {
  test('a session the read does not find is listed as it was left: closed, in its folder', () => {
    const [left] = mergeSessions([{ id: 's4', name: 'deploy', cwd: '/srv' }], parseSessionsRead(READ));

    expect(left).toMatchObject({ id: 's4', name: 'deploy', cwd: '/srv', open: false, running: null, ports: [] });
  });

  test('a new session takes an unused id and the next free name', () => {
    const records = [FIRST_SESSION, { id: 's2', name: 'shell 2', cwd: '/' }];

    expect(newSessionId(records)).toBe('s3');
    expect(newSessionName(records)).toBe('shell 3');
    expect(newSessionName([{ id: 's2', name: 'dev', cwd: '/' }])).toBe('shell');
  });
});

describe("the box's sessions", () => {
  test('a box that is not running is not woken to list them: the first session reads as left', async () => {
    const { box, container } = harness(SessionBox);

    expect(await box.terminalSessions()).toEqual([{ ...FIRST_SESSION, open: false, running: null, last: null, ports: [], branch: null, needsInput: false }]);
    expect(container.sequence.includes('sessions')).toBe(false);
  });

  test('a running box reads them in one exec, and keeps the folder each was found in for its next start', async () => {
    const { box, container } = harness(SessionBox);
    await box.devboxStartup();
    container.sessionsRead = { stdout: READ, stderr: '', exitCode: 0 };

    const [shell] = await box.terminalSessions();

    expect(shell).toMatchObject({ id: 'shell', open: true, cwd: '/workspace/storefront' });
    expect(container.sequence.filter((step) => step === 'sessions')).toHaveLength(1);

    await container.stop();
    expect((await box.terminalSessions())[0]).toMatchObject({ id: 'shell', open: false, cwd: '/workspace/storefront' });
  });

  test('a session opened, renamed and closed stays so; closing the last leaves a first one', async () => {
    const { box, container } = harness(SessionBox);
    await box.devboxStartup();

    const opened = await box.openTerminalSession();

    expect(opened).toMatchObject({ name: 'shell 2', cwd: FIRST_SESSION.cwd });
    await box.renameTerminalSession(opened.id, 'dev server');
    await box.closeTerminalSession(FIRST_SESSION.id);
    expect((await box.terminalSessions()).map((session) => [session.id, session.name])).toEqual([[opened.id, 'dev server']]);
    expect(container.sequence).toContain(`reset:${FIRST_SESSION.id}`);

    await box.closeTerminalSession(opened.id);
    expect((await box.terminalSessions()).map((session) => session.id)).toEqual([FIRST_SESSION.id]);
  });

  test('a name that is empty or past 40 characters, and a session the box does not keep, are refused', async () => {
    const { box } = harness(SessionBox);

    await expect(box.openTerminalSession('   ')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(box.renameTerminalSession(FIRST_SESSION.id, 'x'.repeat(41))).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(box.closeTerminalSession('s9')).rejects.toMatchObject({ code: 'invalid-input' });
  });
});

// D95: an agent's job runs in a session of its own, listed beside the person's and marked as the agent's.
describe("an agent's job", () => {
  test('is listed as a session named by what it runs, marked with its job, and the job names its session', async () => {
    const { box } = harness(SessionBox);
    await box.devboxStartup();

    const { processId } = await box.startSupervised('npm run dev -- --port 5173', '/workspace');
    const sessions = await box.terminalSessions();

    expect(sessions.find((session) => session.job === processId)).toMatchObject({ id: jobSessionId(processId), name: 'npm run dev -- --port 5173' });
    expect((await box.listSupervised()).find((listed) => listed.processId === processId)?.session).toBe(jobSessionId(processId));
  });

  test('its session goes when the job is stopped, and closing its session stops the job', async () => {
    const { box } = harness(SessionBox);
    await box.devboxStartup();

    const first = await box.startSupervised('npm run dev', '/workspace');
    const second = await box.startSupervised('npx vitest --watch', '/workspace');

    await box.stopSupervised(first.processId);
    await box.closeTerminalSession(jobSessionId(second.processId));

    expect((await box.terminalSessions()).map((session) => session.id)).toEqual([FIRST_SESSION.id]);
    expect((await box.listSupervised()).map((listed) => listed.processId)).toEqual([]);
  });

  test("a job's session id is one tmux takes unquoted, and a long command names it in 40 characters", () => {
    expect(jobSessionId('4F0C9A2E-77D1-4F5B-9A63-0B2F6F0E1C55')).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/u);
    expect(jobSessionName(`node ${'a'.repeat(60)}`)).toHaveLength(40);
  });
});
