// Tool card summary lines: repeated calls stay distinguishable, and no summary invents detail.
import { describe, test, expect } from 'bun:test';
import type { JsonObject } from '@kinu.run/core';
import { clip, describeToolCall, summarizeToolCall, toolCallEffect } from '../src/tools/tool-call-summary';

describe('tool call summaries — the unified agents tool', () => {
  test('agents calls retain their action and distinguishing input', () => {
    const calls: { input: JsonObject; facts: string[] }[] = [
      { input: { action: 'hire', agent: 'scout', role: 'researcher — landscape' }, facts: ['hire', 'scout', 'researcher — landscape'] },
      { input: { action: 'hire', role: 'researcher' }, facts: ['hire', 'researcher'] },
      { input: { action: 'hire', scope: 'workspace', mission: 'summarize papers' }, facts: ['hire', 'workspace', 'summarize papers'] },
      { input: { action: 'hire', agent: 'scout', message: 'Audit the CLI surface' }, facts: ['hire', 'scout', 'Audit the CLI surface'] },
      { input: { action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the CLI surface' }, facts: ['hire', 'task', 'auditor'] },
      { input: { action: 'msg', agent: 'scout', topic: 'fyi' }, facts: ['msg', 'scout', 'fyi'] },
      { input: { action: 'msg', event_id: 'ev-1', message: 'here you go' }, facts: ['msg', 'here you go'] },
      { input: { action: 'dismiss', agent: 'arch-auditor' }, facts: ['dismiss', 'arch-auditor'] },
      { input: { action: 'list' }, facts: ['list'] },
    ];

    const summaries = calls.map(({ input, facts }) => {
      const summary = summarizeToolCall('agents', input);

      for (const fact of facts) expect(summary).toContain(fact);

      return summary;
    });

    expect(new Set(summaries).size).toBe(calls.length);
  });
});

describe('tool call summaries — builtins', () => {
  test('run shows the command', () => {
    expect(summarizeToolCall('shell', { command: 'git clone https://example.com/repo', runtime: 'sandbox' }))
      .toBe('git clone https://example.com/repo');
  });

  test('memory and web name their subject', () => {
    expect(summarizeToolCall('memory', { action: 'search', query: 'deploy' })).toContain('deploy');
    expect(summarizeToolCall('memory', { action: 'save', content: 'the deploy target is staging' }))
      .toContain('the deploy target is staging');
    expect(summarizeToolCall('memory', { action: 'conversations' })).toBe('conversations');
    expect(summarizeToolCall('memory', { action: 'remember', key: 'user.tz', value: 'UTC' }))
      .toContain('user.tz');
    expect(summarizeToolCall('memory', { action: 'forget', key: 'deploy.target' })).toContain('deploy.target');
    expect(summarizeToolCall('web', { action: 'search', query: 'workers ai session affinity' }))
      .toContain('workers ai session affinity');
    expect(summarizeToolCall('web', { action: 'fetch', url: 'https://example.com/docs' }))
      .toContain('https://example.com/docs');
  });

  test('report leads with the status it is reporting', () => {
    const summary = summarizeToolCall('report', { status: 'completed', content: 'audit finished' });
    expect(summary).toContain('completed');
    expect(summary).toContain('audit finished');
  });

  test('eval separates the visible intent from the first executable line', () => {
    const code = '// Fetch the roster to identify idle agents\n\nconst r = await team.list();\nreturn r;';
    expect(describeToolCall('eval', { code })).toBe('Fetch the roster to identify idle agents');
    expect(summarizeToolCall('eval', { code })).toBe('const r = await team.list();');
  });

  test('native descriptions retain the target and distinguish reading from editing', () => {
    const read = describeToolCall('file', { action: 'read', path: '/workspace/package.json' });
    const edit = describeToolCall('file', { action: 'edit', path: '/workspace/package.json' });
    expect(read).toContain('package.json');
    expect(edit).toContain('package.json');
    expect(edit).not.toBe(read);
    expect(describeToolCall('agents', { action: 'hire', agent: 'scout' })).toContain('scout');
  });
});

describe('tool call summaries — truthfulness', () => {
  test('missing, partial and malformed input never fabricate a summary', () => {
    expect(summarizeToolCall('file', undefined)).toBe('');
    expect(summarizeToolCall('shell', {})).toBe('');
    expect(summarizeToolCall('shell', 'git status')).toBe('');
    expect(summarizeToolCall('agents', { action: 'hire', agent: 'scout' })).toBe('hire scout');
  });

  test('unknown (MCP / crafted) tools show a lone string argument and nothing else', () => {
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open' })).toBe('is:open');
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open', repo: 'kinu' })).toBe('');
    expect(summarizeToolCall('crafted_thing', { count: 3 })).toBe('');
  });

  test('long values are clipped with a visible marker, never silently cut', () => {
    const long = 'a'.repeat(200);
    const summary = summarizeToolCall('shell', { command: long });
    expect(summary.endsWith('...')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(72);
    expect(clip('short')).toBe('short');
    expect(clip('one    two\n three')).toBe('one two three');
  });
});

describe('toolCallEffect — consequence controls activity density', () => {
  test('known mutations remain prominent', () => {
    expect(toolCallEffect('file', { action: 'write', path: '/workspace/report.md' })).toBe('mutate');
    expect(toolCallEffect('file', { action: 'edit', path: '/workspace/src/auth.ts' })).toBe('mutate');
    expect(toolCallEffect('tasks', { action: 'update', id: 't3', status: 'done' })).toBe('mutate');
    expect(toolCallEffect('memory', { action: 'remember', key: 'deploy.target' })).toBe('mutate');
    expect(toolCallEffect('agents', { action: 'swarm', task: 'audit it' })).toBe('mutate');
    // `mode` with a role mutates actor_config via changeActiveRole.
    expect(toolCallEffect('tasks', { action: 'mode', role: 'researcher' })).toBe('mutate');
    expect(toolCallEffect('tasks', { action: 'mode' })).toBe('read');

  });
  test('known observations collapse into the compact timeline', () => {
    expect(toolCallEffect('file', { action: 'read', path: '/workspace/report.md' })).toBe('read');
    expect(toolCallEffect('web', { action: 'search', query: 'deploy' })).toBe('read');
    expect(toolCallEffect('memory', { action: 'search', query: 'deploy' })).toBe('read');
  });

  test('network fetches and delegation remain consequential', () => {
    expect(toolCallEffect('web', { action: 'fetch', url: 'https://example.com' })).toBe('mutate');
    expect(toolCallEffect('agents', { action: 'hire' })).toBe('mutate');
    expect(toolCallEffect('agents', { action: 'list' })).toBe('read');
  });

  test('programs and unclassified contracts remain explicitly unknown', () => {
    expect(toolCallEffect('shell', { command: 'node inspect.js' })).toBe('unknown');
    expect(toolCallEffect('eval', { code: 'return await workspace.files.read("a")' })).toBe('unknown');
    expect(toolCallEffect('crafted_unknown', { action: 'write' })).toBe('unknown');
    expect(toolCallEffect('file', 'read a')).toBe('unknown');
  });
});

