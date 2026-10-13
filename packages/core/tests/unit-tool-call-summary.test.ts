// Tool card summary lines: repeated calls stay distinguishable, and no summary invents detail.
import { describe, test, expect } from 'bun:test';
import type { JsonObject } from '@kinu.run/core';
import { describeToolCall, summarizeToolCall } from '../src/tools/tool-call-summary';

describe('tool call summaries — the unified agents tool', () => {
  test('agents calls retain their action and distinguishing input', () => {
    const calls: { input: JsonObject; facts: string[] }[] = [
      { input: { op: 'hire', name: 'scout', role: 'researcher — landscape' }, facts: ['hire', 'scout', 'researcher — landscape'] },
      { input: { op: 'hire', role: 'researcher' }, facts: ['hire', 'researcher'] },
      { input: { op: 'hireWorkspace', mission: 'summarize papers' }, facts: ['hire', 'workspace', 'summarize papers'] },
      { input: { op: 'assign', agent: 'scout', message: 'Audit the CLI surface' }, facts: ['assign', 'scout', 'Audit the CLI surface'] },
      { input: { op: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the CLI surface' }, facts: ['hire', 'task', 'auditor'] },
      { input: { op: 'message', agent: 'scout', topic: 'fyi' }, facts: ['message', 'scout', 'fyi'] },
      { input: { op: 'reply', eventId: 'ev-1', message: 'here you go' }, facts: ['reply', 'here you go'] },
      { input: { op: 'dismiss', agent: 'arch-auditor' }, facts: ['dismiss', 'arch-auditor'] },
      { input: { op: 'list' }, facts: ['list'] },
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
    expect(summarizeToolCall('shell', { command: 'git clone https://example.com/repo', runtime: 'computer' }))
      .toBe('git clone https://example.com/repo');
  });

  test('memory and web name their subject', () => {
    expect(summarizeToolCall('memory', { op: 'search', query: 'deploy' })).toContain('deploy');
    expect(summarizeToolCall('memory', { op: 'note', content: 'the deploy target is staging' }))
      .toContain('the deploy target is staging');
    expect(summarizeToolCall('memory', { op: 'listConversations' })).toBe('listConversations');
    expect(summarizeToolCall('memory', { op: 'remember', key: 'user.tz', value: 'UTC' }))
      .toContain('user.tz');
    expect(summarizeToolCall('memory', { op: 'forget', key: 'deploy.target' })).toContain('deploy.target');
    expect(summarizeToolCall('web', { op: 'search', query: 'workers ai session affinity' }))
      .toContain('workers ai session affinity');
    expect(summarizeToolCall('web', { op: 'fetch', url: 'https://example.com/docs' }))
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
    const read = describeToolCall('file', { op: 'read', path: '/workspace/package.json' });
    const edit = describeToolCall('file', { op: 'edit', path: '/workspace/package.json' });
    expect(read).toContain('package.json');
    expect(edit).toContain('package.json');
    expect(edit).not.toBe(read);
    expect(describeToolCall('agents', { op: 'assign', agent: 'scout' })).toContain('scout');
  });
});

describe('tool call summaries — truthfulness', () => {
  test('missing, partial and malformed input never fabricate a summary', () => {
    expect(summarizeToolCall('file', undefined)).toBe('');
    expect(summarizeToolCall('shell', {})).toBe('');
    expect(summarizeToolCall('shell', 'git status')).toBe('');
    expect(summarizeToolCall('agents', { op: 'assign', agent: 'scout' })).toBe('assign scout');
  });

  test('unknown (MCP / crafted) tools show a lone string argument and nothing else', () => {
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open' })).toBe('is:open');
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open', repo: 'kinu' })).toBe('');
    expect(summarizeToolCall('crafted_thing', { count: 3 })).toBe('');
  });
});

