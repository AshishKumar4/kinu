'use strict';

const { test, expect } = require('bun:test');

const fs = require('node:fs');

const { createProcReader, parseProcStat, procStat } = require('../src/pty.js');

// Linux's comm is parenthesized but may itself hold parentheses, spaces and newlines.
test('process identity and ownership fields are read after the full command name', () => {
  const fields = ['R', '12', '34', '56', ...Array(7).fill('0'), '2', '3', '5', '7', '0', '0', '4', '0', '987'];
  const stat = parseProcStat(`99 (command ) (\n name) ${fields.join(' ')}`);

  expect(stat).toEqual({ comm: 'command ) (\n name', state: 'R', ppid: 12, group: 34, session: 56, cpuTicks: 17, tasks: 4, startTicks: '987' });
  expect(procStat(process.pid, 'stat', true).ppid).toBe(process.ppid);
});

test.each(['ENOENT', 'ESRCH'])('a proc read racing exit is absence, while required identity reads keep %s', (code) => {
  const gone = Object.assign(new Error('process exited while being read'), { code });
  const reader = createProcReader({ ...fs, readFileSync: () => { throw gone; } });

  expect(reader.procStat(1)).toBeUndefined();
  expect(() => reader.procStat(1, 'stat', true)).toThrow(gone);
});

test('a refused proc read is never guessed to be an exited process', () => {
  const denied = Object.assign(new Error('process is not readable'), { code: 'EACCES' });
  const reader = createProcReader({ ...fs, readFileSync: () => { throw denied; } });

  expect(() => reader.procStat(1)).toThrow(denied);
});
