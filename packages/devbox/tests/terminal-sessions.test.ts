// D90: the computer's terminal sessions. tmux is the box's, so the read's rows are given here as the box's read
// prints them; the product flow `computer-sessions` reads a real computer's.
import { TestDevbox } from './support/test-devbox';
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type { DiskChain, DiskChainPorts } from '../src/disk-chain';
import type { ExecResult } from '../src/contracts';

import { FIRST_SESSION, READS_TERMINAL, jobSessionId, jobSessionName, mergeSessions, newSessionId, newSessionName, parseSessionsRead } from '../src/sessions';
import { runToExit } from '../../test-utils/src/spawn';
import { harness } from './support/devbox-harness';

class SessionBox extends TestDevbox<unknown> {

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

/** A record as tmux's `#{q:…}` writes it: a backslash before each space and backslash in a field, fields space-separated. */
const row = (...fields: Array<string | number>) => fields.map((field) => String(field).replace(/[\\ ]/gu, '\\$&')).join(' ');

/** A line as the session's rc stores it (D97). */
const stored = (line: string) => Buffer.from(line).toString('base64');

const READ = [
  row('P', 'shell', '/workspace/storefront', 'bash', 0, 1_791_900_000, stored('git status')),
  row('P', 's2', '/workspace/storefront', 'node', '', '', ''),
  row('P', 's3', '/tmp', 'bash', 2, 1_791_900_060, stored('npx vitest run')),
  row('L', 's2', 5173),
  row('L', 's2', 5173),
  row('L', 'nobody', 8080),
  row('B', '/workspace/storefront', 'main'),
  '',
].join('\n');

describe("the box's test for a program waiting on its terminal", () => {
  // read(2) has another number on another machine (arm64's is 63): a box on one reads its own, never x86's 0.
  test('finds a program in read(0) on its pts by the read(2) of the machine it runs on, and no other', async () => {
    if (process.platform !== 'linux') return;
    const host = (await runToExit(['uname', '-m'])).stdout.trim();
    const other = host === 'aarch64' ? 'x86_64' : 'aarch64';

    // A cat on a pty of its own, waiting for a line; asked from its ancestor, as the box's read asks a pane's.
    const probe = await runToExit(['bash', '-c', `${READS_TERMINAL}
dir=$(mktemp -d)
sleep 30 | script -qefc "echo \\$\\$ > $dir/pid; exec cat" /dev/null >/dev/null &
until [ -s "$dir/pid" ] && pid=$(cat "$dir/pid") && [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = cat ] \\
  && [ "$(cut -d' ' -f3 "/proc/$pid/stat" 2>/dev/null)" = S ]; do :; done
for machine in ${host} ${other} mips; do
  (uname() { echo "$machine"; }; if reads_terminal "$pid"; then echo "$machine waits"; else echo "$machine runs"; fi)
done
kill $(jobs -p) 2>/dev/null; rm -rf "$dir"`]);

    expect(probe.stdout.trim().split('\n')).toEqual([`${host} waits`, `${other} runs`, 'mips runs']);
  });
});

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

  // tmux writes a field's special characters escaped (measured through real tmux 3.6): any folder or command reads
  // back whole, a marker or a separator in it included.
  test('a folder and a command with spaces, quotes, backslashes, markers and lines in them read back whole', () => {
    const folder = '/workspace/two words/<<kinu>>/a"b\'c $x \\t';
    const command = `printf '%s' '<<kinu>>' | tr x y; echo "a b\n\u00e9" \\ end;`;

    const odd = parseSessionsRead([
      String.raw`P shell /workspace/two\ words/\<\<kinu\>\>/a\"b\'c\ \$x\ \\t bash 1 1700000000 ` + stored(command),
      String.raw`B /workspace/two\ words/<<kinu>>/a"b'c\ $x\ \\t feat/x`,
    ].join('\n'));

    expect(odd.get('shell')).toMatchObject({ cwd: folder, last: { command }, branch: 'feat/x' });
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

  test('a new session takes an id no session had, and the next free name', () => {
    const records = [FIRST_SESSION, { id: 's2', name: 'shell 2', cwd: '/' }];
    const ids = new Set(Array.from({ length: 50 }, () => newSessionId(records)));

    // A closed session's id stays free of its saved screen (D97) only if no later session takes it.
    expect(ids.size).toBe(50);
    expect([...ids].filter((id) => records.some((record) => record.id === id) || !/^[a-z0-9][a-z0-9-]{0,31}$/u.test(id))).toEqual([]);
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

  // Review finding 1: a read wrote back the records it began with, over what changed while its exec ran.
  test('a read keeps every open, rename and close made while its exec ran, and the folder it found', async () => {
    const { box, container } = harness(SessionBox);
    await box.devboxStartup();
    const kept = await box.openTerminalSession();
    const closing = await box.openTerminalSession();
    const answer = Promise.withResolvers<ExecResult>();
    container.sessionsRead = answer.promise;
    const reading = box.terminalSessions();

    await box.renameTerminalSession(kept.id, 'renamed');
    const opened = await box.openTerminalSession('opened');
    await box.closeTerminalSession(closing.id);
    answer.resolve({ stdout: row('P', FIRST_SESSION.id, '/workspace/moved', 'bash', '', '', ''), stderr: '', exitCode: 0 });
    await reading;
    container.sessionsRead = { stdout: '', stderr: '', exitCode: 0 };

    expect((await box.terminalSessions()).map((session) => [session.id, session.name, session.cwd])).toEqual([
      [FIRST_SESSION.id, FIRST_SESSION.name, '/workspace/moved'], [kept.id, 'renamed', FIRST_SESSION.cwd], [opened.id, 'opened', FIRST_SESSION.cwd],
    ]);
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
    // A stopped job keeps its record of how it ended, but no spec brings it back.
    expect((await box.listSupervised()).filter((listed) => listed.restartable)).toEqual([]);
  });

  // devbox-e2e on c55bf8f34: the job's session, open on a real box, read back without its job.
  test('its session stays marked with its job while it is open', () => {
    const record = { id: jobSessionId('JOB-1'), name: 'npm run dev', cwd: '/workspace', job: 'JOB-1' };
    const [open] = mergeSessions([record], parseSessionsRead(row('P', record.id, '/workspace/app', 'node', '', '', '')));

    expect(open).toMatchObject({ id: record.id, name: 'npm run dev', job: 'JOB-1', open: true, cwd: '/workspace/app' });
  });

  // Review finding 9: closing a stopped computer's job tab started the computer and ran the job again.
  test("closing its session on a stopped computer ends it there: nothing starts, and no later start runs it", async () => {
    const { box, container } = harness(SessionBox);
    await box.devboxStartup();
    const { processId } = await box.startSupervised('npm run dev', '/workspace');
    await container.stop();
    const starts = container.startOptions.length;

    await box.closeTerminalSession(jobSessionId(processId));
    expect(container.startOptions.length).toBe(starts);
    expect((await box.terminalSessions()).map((session) => session.id)).toEqual([FIRST_SESSION.id]);

    await box.devboxStartup();
    expect((await box.listSupervised()).filter((listed) => listed.restartable)).toEqual([]);
  });

  // Review of the computer process jobs, 2026-10-21: the job such a close ended was never told, and ran on forever.
  test("closing a job's session on a stopped computer tells its job it ended", async () => {
    const { box, container, rows } = harness(SessionBox);
    await box.devboxStartup();
    const { processId } = await box.startSupervised('npm run dev', '/workspace', {}, { job: 'bgjob-tab' });
    await container.stop();

    await box.closeTerminalSession(jobSessionId(processId));

    expect([...rows].filter(([key]) => key.startsWith('devbox:incident:')).map(([, incident]) => incident)).toEqual([expect.objectContaining({
      stage: 'process-ended', processId, job: 'bgjob-tab', reason: 'its session was closed while the computer was stopped',
    })]);
  });

  test("a job's session id is one tmux takes unquoted, and a long command names it in 40 characters", () => {
    expect(jobSessionId('4F0C9A2E-77D1-4F5B-9A63-0B2F6F0E1C55')).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/u);
    expect(jobSessionName(`node ${'a'.repeat(60)}`)).toHaveLength(40);
  });
});

// D97: a stopping box keeps what each session showed and was running; the next attach shows it, and offers the line.
describe('a stop', () => {
  test("keeps every recorded session's screen and line before its checkpoint commits the disk", async () => {
    let sequence: readonly string[] = [];
    let atCommit: readonly string[] = [];

    class CommittingBox extends SessionBox {
      protected override diskChain(ports: DiskChainPorts): DiskChain {
        const chain = super.diskChain(ports);

        return {
          ...chain,
          commit: (kind) => Effect.suspend(() => {
            atCommit = [...sequence];

            return chain.commit(kind);
          }),
        };
      }
    }

    const { box, container } = harness(CommittingBox);
    sequence = container.sequence;
    await box.devboxStartup();
    const opened = await box.openTerminalSession();

    await box.quiesce();

    expect(atCommit.filter((step) => step.startsWith('save:'))).toEqual([`save:${FIRST_SESSION.id} ${opened.id}`]);
  });

  test('then a session closed before the next start loses what was saved of it, before any attach can show it', async () => {
    const { box, container } = harness(SessionBox);
    await box.devboxStartup();
    await container.stop();

    await box.closeTerminalSession(FIRST_SESSION.id);
    expect(container.sequence.filter((step) => step.startsWith('forget:'))).toEqual([]);
    await box.devboxStartup();

    expect(container.sequence.filter((step) => step.startsWith('forget:'))).toEqual([`forget:${FIRST_SESSION.id}`]);
    await container.stop();
    await box.devboxStartup();
    expect(container.sequence.filter((step) => step.startsWith('forget:'))).toHaveLength(1);
  });

  test('that cannot save the sessions still stops: they open fresh', async () => {
    const saved = harness(SessionBox);
    const unsaved = harness(SessionBox);
    await saved.box.devboxStartup();
    await unsaved.box.devboxStartup();
    unsaved.container.sessionsSave = { stdout: '', stderr: 'tmux: no server', exitCode: 1 };

    expect((await unsaved.box.quiesce()).kind).toBe((await saved.box.quiesce()).kind);

    const gone = harness(SessionBox);
    await gone.box.devboxStartup();
    gone.container.sessionsSave = 'gone';

    expect((await gone.box.quiesce()).kind).toBe((await saved.box.quiesce()).kind);
  });
});
