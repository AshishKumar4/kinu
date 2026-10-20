/**
 * What a PC's session row says (1019-aa), where /proc cannot be the witness: a Mac's rows from ps and lsof as they
 * print, and a folder's branch read from its repository the way `git symbolic-ref` answers, a worktree's and a detached
 * HEAD's included. Linux's rows are read from /proc through the daemon's dispatcher (pty-protocol.test.js).
 */
'use strict';

const fs = require('node:fs');

const path = require('node:path');

const { describe, expect, test } = require('bun:test');

const { scratchDir } = require('@kinu.run/test-utils');

const { branchOf, sessionFacts } = require('../src/daemon/session-facts.js');

/** ps and lsof as a Mac prints them, `answers` by the command's first two words. */
function macSpawn(answers) {
  return (argv) => {
    const said = answers[argv.slice(0, 2).join(' ')] ?? answers[argv[0]] ?? '';

    return { stdout: new Response(said).body, exited: Promise.resolve(0), kill: () => {} };
  };
}

describe("a PC's session row", () => {
  test("a Mac's row: the foreground program, its folder and branch, and the ports under the shell, none of another's", async () => {
    const repo = scratchDir('session-facts-repo');

    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const facts = await sessionFacts([{ id: 'pty-shell', pid: 500 }, { id: 'pty-gone', pid: 999 }], {
      platform: 'darwin',
      spawn: macSpawn({
        ps: ['  500     1   510 -zsh', '  510   500   510 /opt/homebrew/bin/node', '  520   510   510 esbuild', '  600     1   600 /usr/sbin/sshd'].join('\n'),
        'lsof -nP': ['p520', 'n*:5173', 'p600', 'n*:22'].join('\n'),
        'lsof -a': ['p510', 'fcwd', `n${repo}`].join('\n'),
      }),
    });

    expect(Object.fromEntries(facts)).toEqual({
      'pty-shell': { cwd: repo, running: 'node', ports: [5173], branch: 'main', needsInput: false },
      'pty-gone': { cwd: null, running: null, ports: [], branch: null, needsInput: false },
    });
  });

  test("a folder's branch, as git symbolic-ref says it: from a parent's repository, a worktree's, and none when detached", () => {
    const repo = scratchDir('session-facts-branch');
    const worktree = scratchDir('session-facts-worktree');

    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'side'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/next-rc\n');
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'side', 'HEAD'), 'ref: refs/heads/feat/rows\n');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'side')}\n`);
    const detached = scratchDir('session-facts-detached');

    fs.mkdirSync(path.join(detached, '.git'));
    fs.writeFileSync(path.join(detached, '.git', 'HEAD'), '5107e3ecd0000000000000000000000000000000\n');

    expect([path.join(repo, 'packages', 'core'), worktree, detached, scratchDir('session-facts-none')].map(branchOf))
      .toEqual(['next-rc', 'feat/rows', null, null]);
  });
});
