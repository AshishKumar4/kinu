// Tool card summary lines: repeated calls stay distinguishable, and no summary invents detail.
import { describe, test, expect } from 'bun:test';
import { clip, describeToolCall, summarizeToolCall, toolCallEffect } from '../src/tools/tool-call-summary';

describe('tool call summaries — the unified agents tool', () => {
  test('agents calls are told apart by action and target', () => {
    expect(summarizeToolCall('agents', { action: 'hire', agent: 'scout', role: 'researcher — landscape' }))
      .toBe('hire scout: "researcher — landscape"');
    expect(summarizeToolCall('agents', { action: 'hire', role: 'researcher' })).toBe('hire researcher');
    expect(summarizeToolCall('agents', { action: 'hire', scope: 'workspace', mission: 'summarize papers' }))
      .toBe('hire workspace: "summarize papers"');
    expect(summarizeToolCall('agents', { action: 'hire', agent: 'scout', message: 'Audit the CLI surface' }))
      .toBe('hire scout: "Audit the CLI surface"');
    expect(summarizeToolCall('agents', { action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the CLI surface' }))
      .toBe('hire (task) auditor');
    expect(summarizeToolCall('agents', { action: 'msg', agent: 'scout', topic: 'fyi' }))
      .toBe('msg scout: "fyi"');
    expect(summarizeToolCall('agents', { action: 'msg', event_id: 'ev-1', message: 'here you go' }))
      .toBe('msg: "here you go"');
    expect(summarizeToolCall('agents', { action: 'dismiss', agent: 'arch-auditor' })).toBe('dismiss arch-auditor');
    expect(summarizeToolCall('agents', { action: 'list' })).toBe('list');
  });
});

describe('tool call summaries — builtins', () => {
  test('run shows the command', () => {
    expect(summarizeToolCall('shell', { command: 'git clone https://example.com/repo', runtime: 'sandbox' }))
      .toBe('git clone https://example.com/repo');
  });

  test('memory and web name their subject', () => {
    expect(summarizeToolCall('memory', { action: 'search', query: 'deploy' })).toBe('search "deploy"');
    expect(summarizeToolCall('memory', { action: 'save', content: 'the deploy target is staging' }))
      .toBe('save: "the deploy target is staging"');
    expect(summarizeToolCall('memory', { action: 'conversations' })).toBe('conversations');
    expect(summarizeToolCall('memory', { action: 'remember', key: 'user.tz', value: 'UTC' }))
      .toBe('remember user.tz');
    expect(summarizeToolCall('memory', { action: 'forget', key: 'deploy.target' })).toBe('forget deploy.target');
    expect(summarizeToolCall('web', { action: 'search', query: 'workers ai session affinity' }))
      .toBe('search "workers ai session affinity"');
    expect(summarizeToolCall('web', { action: 'fetch', url: 'https://example.com/docs' }))
      .toBe('fetch https://example.com/docs');
  });

  test('report leads with the status it is reporting', () => {
    expect(summarizeToolCall('report', { status: 'completed', content: 'audit finished' }))
      .toBe('completed: "audit finished"');
  });

  test('eval separates the visible intent from the first executable line', () => {
    const code = '// Fetch the roster to identify idle agents\n\nconst r = await team.list();\nreturn r;';
    expect(describeToolCall('eval', { code })).toBe('Fetch the roster to identify idle agents');
    expect(summarizeToolCall('eval', { code })).toBe('const r = await team.list();');
    expect(describeToolCall('eval', { code: 'const r = await team.list();' })).toBe('Ran a tool program');
  });

  test('native calls name their operation and target in plain language', () => {
    expect(describeToolCall('file', { action: 'read', path: '/workspace/package.json' })).toBe('Read package.json');
    expect(describeToolCall('file', { action: 'edit', path: '/workspace/src/auth.ts' })).toBe('Edited auth.ts');
    expect(describeToolCall('shell', { command: 'bun test packages/core' })).toBe('Ran tests');
    expect(describeToolCall('web', { action: 'fetch', url: 'https://example.com' })).toBe('Fetched a page');
    expect(describeToolCall('memory', { action: 'search', query: 'deployment' })).toBe('Searched memory');
    expect(describeToolCall('agents', { action: 'hire', agent: 'scout' })).toBe('Asked scout');
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

