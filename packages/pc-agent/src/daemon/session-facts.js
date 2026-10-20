// Kinu PC agent — what a terminal session's row on the strip says (1019-aa).
//
// The computer's rows say a session's folder, the program in its foreground,
// the ports a process under it listens on, its folder's branch, and whether a
// program waits for an answer (packages/devbox/src/sessions.ts, SESSIONS_READ).
// A PC's say the same, read from the system: /proc on Linux, ps and lsof on a
// Mac, which cannot tell a program waiting for input. The last command's exit
// is the one thing they never say: it needs shell integration in the owner's
// own rc files, which Kinu does not edit.
'use strict';

const fs = require('node:fs');

const path = require('node:path');

/** What holds a terminal's foreground while nothing the person started runs: the shell at its prompt, or the
 *  sandbox's launcher before it. */
const IDLE_FOREGROUND = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'bwrap', 'sandbox-exec', '-bash', '-zsh']);

/** A TCP socket's state in /proc/net/tcp, LISTEN. */
const TCP_LISTEN = '0A';

/** read(2)'s number, which /proc/<pid>/syscall begins with while a process waits in it: the architecture's own. */
const READ_SYSCALL = { x64: '0', arm64: '63', ia32: '3', arm: '3' }[process.arch] ?? null;

/** A Mac's ps and lsof answer in well under this; past it a row says nothing more. */
const ASK_MS = 3_000;

const NOTHING = { cwd: null, running: null, ports: [], branch: null, needsInput: false };

/** What a read of another process's /proc, or of a folder the owner may have moved, meets in the ordinary course: it
 *  is gone, it is not ours to read, or it is not what was read for. Anything else is a fault, thrown. */
const ABSENT = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'ENOTDIR', 'EINVAL']);

/** `read()`, or `absent` when what it read is gone or not ours. */
function readOr(read, absent) {
  try {
    return read();
  } catch (err) {
    if (!err || !ABSENT.has(err.code)) throw err;

    return absent;
  }
}

/** The branch checked out in `dir`'s repository, or null: outside one, or on a detached HEAD, as `git symbolic-ref`
 *  says. A worktree's `.git` is a file naming its git directory. */
function branchOf(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    const dotGit = path.join(at, '.git');

    const gitDir = readOr(() => (fs.statSync(dotGit).isDirectory()
      ? dotGit
      : path.resolve(at, fs.readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/u, '').trim())), null);

    if (gitDir !== null) {
      const head = readOr(() => fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(), '');

      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
    }

    if (at === path.dirname(at)) return null;
  }
}

/** `root` and every process under it, by their parents. */
function treeOf(root, parents) {
  const tree = new Set([root]);

  for (let grew = true; grew;) {
    grew = false;

    for (const [pid, ppid] of parents) {
      if (!tree.has(pid) && tree.has(ppid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }

  return tree;
}

/** The LISTEN sockets of this network namespace, port by inode. */
function linuxListeners(read) {
  const ports = new Map();

  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (read(table) ?? '').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/u);

      if (fields[3] === TCP_LISTEN) ports.set(fields[9], Number.parseInt(fields[1].split(':').pop() ?? '0', 16));
    }
  }

  return ports;
}

/** Linux: every row from /proc, read once for all the sessions. */
function linuxFacts(sessions) {
  const read = (file) => readOr(() => fs.readFileSync(file, 'utf8'), undefined);
  const link = (file) => readOr(() => fs.readlinkSync(file), null);

  const processes = new Map();

  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    const text = read(`/proc/${entry}/stat`);

    if (text === undefined) continue;
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');

    processes.set(Number(entry), { comm: text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')), ppid: Number(fields[1]), group: Number(fields[2]), foreground: Number(fields[5]) });
  }

  const parents = new Map([...processes].map(([pid, facts]) => [pid, facts.ppid]));
  const listeners = linuxListeners(read);
  const facts = new Map();

  for (const { id, pid } of sessions) {
    const shell = processes.get(pid);

    if (shell === undefined) {
      facts.set(id, NOTHING);
      continue;
    }

    const tree = treeOf(pid, parents);
    const leader = processes.get(shell.foreground);
    const ports = new Set();

    for (const member of tree) {
      for (const fd of readOr(() => fs.readdirSync(`/proc/${member}/fd`), [])) {
        const inode = /^socket:\[(\d+)\]$/u.exec(link(`/proc/${member}/fd/${fd}`) ?? '')?.[1];

        if (inode !== undefined && listeners.has(inode)) ports.add(listeners.get(inode));
      }
    }

    // A program reading from its terminal: in read(0), with the session's terminal as its stdin (the computer's test).
    const waiting = READ_SYSCALL !== null && [...processes].some(([member, row]) => row.group === shell.foreground && tree.has(member)
      && (read(`/proc/${member}/syscall`) ?? '').startsWith(`${READ_SYSCALL} 0x0 `) && (link(`/proc/${member}/fd/0`) ?? '').startsWith('/dev/pts/'));

    const cwd = link(`/proc/${shell.foreground > 0 && tree.has(shell.foreground) ? shell.foreground : pid}/cwd`);

    facts.set(id, {
      cwd,
      running: leader === undefined || IDLE_FOREGROUND.has(leader.comm) || !tree.has(shell.foreground) ? null : leader.comm,
      ports: [...ports].sort((a, b) => a - b),
      branch: cwd === null ? null : branchOf(cwd),
      needsInput: waiting,
    });
  }

  return facts;
}

/** What `argv` printed: '' when it took too long, or when this Mac lacks the command. */
async function asked(argv, spawn) {
  const child = readOr(() => spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }), null);

  if (child === null) return '';
  const timer = setTimeout(() => child.kill(), ASK_MS);
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);

  clearTimeout(timer);

  return text;
}

/** A Mac: one ps for the processes and one lsof for the listeners, then one lsof per session for its folder. */
async function macFacts(sessions, spawn) {
  const [table, listening] = await Promise.all([
    asked(['ps', '-A', '-o', 'pid=,ppid=,tpgid=,comm='], spawn),
    asked(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], spawn),
  ]);

  const processes = new Map(table.trim().split('\n').map((row) => row.trim().split(/\s+/u)).filter((row) => row.length >= 4)
    .map(([pid, ppid, foreground, ...comm]) => [Number(pid), { ppid: Number(ppid), foreground: Number(foreground), comm: path.basename(comm.join(' ')) }]));

  const portsByPid = new Map();
  let owner = 0;

  for (const line of listening.split('\n')) {
    if (line.startsWith('p')) owner = Number(line.slice(1));

    if (line.startsWith('n')) portsByPid.set(owner, [...portsByPid.get(owner) ?? [], Number(line.split(':').pop())]);
  }

  const parents = new Map([...processes].map(([pid, facts]) => [pid, facts.ppid]));
  const facts = new Map();

  for (const { id, pid } of sessions) {
    const shell = processes.get(pid);

    if (shell === undefined) {
      facts.set(id, NOTHING);
      continue;
    }

    const tree = treeOf(pid, parents);
    const leader = processes.get(shell.foreground);
    const folder = await asked(['lsof', '-a', '-p', String(tree.has(shell.foreground) ? shell.foreground : pid), '-d', 'cwd', '-Fn'], spawn);
    const cwd = folder.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? null;

    facts.set(id, {
      cwd,
      running: leader === undefined || IDLE_FOREGROUND.has(leader.comm) || !tree.has(shell.foreground) ? null : leader.comm,
      ports: [...new Set([...tree].flatMap((member) => portsByPid.get(member) ?? []))].sort((a, b) => a - b),
      branch: cwd === null ? null : branchOf(cwd),
      needsInput: false,
    });
  }

  return facts;
}

/** Each running session's row facts, by its id; `sessions` are its id and its shell's pid. */
async function sessionFacts(sessions, { platform = process.platform, spawn = Bun.spawn } = {}) {
  if (sessions.length === 0) return new Map();

  if (platform === 'linux') return linuxFacts(sessions);

  return platform === 'darwin' ? await macFacts(sessions, spawn) : new Map();
}

module.exports = { sessionFacts, branchOf };
