// The chat's tool card summary line. Six `team` chips in a row must read as
// six different calls, and no summary may claim detail the arguments never
// carried.
import { describe, test, expect } from 'bun:test';
import { clip, summarizeToolCall } from '../src/components/tool-call-summary.ts';

describe('tool call summaries — builtins', () => {
  test('team calls are told apart by their target, not just their name', () => {
    expect(summarizeToolCall('team', { action: 'dismiss', name: 'arch-auditor' })).toBe('dismiss arch-auditor');
    expect(summarizeToolCall('team', { action: 'dismiss', name: 'surface-auditor' })).toBe('dismiss surface-auditor');
    expect(summarizeToolCall('team', { action: 'status', name: 'arch-auditor' })).toBe('status arch-auditor');
    expect(summarizeToolCall('team', { action: 'list' })).toBe('list');
  });

  test('team spawn names the subordinate, falling back to its role', () => {
    expect(summarizeToolCall('team', { action: 'spawn', name: 'scout', role: 'researcher — landscape' }))
      .toBe('spawn scout — "researcher — landscape"');
    expect(summarizeToolCall('team', { action: 'spawn', role: 'researcher' })).toBe('spawn researcher');
  });

  test('team assign and message carry the body they sent', () => {
    expect(summarizeToolCall('team', { action: 'assign', name: 'scout', task: 'Audit the CLI surface' }))
      .toBe('assign scout — "Audit the CLI surface"');
    expect(summarizeToolCall('team', { action: 'message', name: 'scout', content: 'skip the tests' }))
      .toBe('message scout — "skip the tests"');
  });

  test('run shows the command; think shows the head count and task', () => {
    expect(summarizeToolCall('run', { command: 'git clone https://example.com/repo', runtime: 'sandbox' }))
      .toBe('git clone https://example.com/repo');
    expect(summarizeToolCall('think', {
      strategy: 'heads', task: 'compare X vs Y',
      heads: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }],
    })).toBe('4 heads: "compare X vs Y"');
    expect(summarizeToolCall('think', { strategy: 'mcts', task: 'find the fix' })).toBe('mcts: "find the fix"');
  });

  test('memory, fact, skills and the web tools name their subject', () => {
    expect(summarizeToolCall('memory', { action: 'search', query: 'deploy' })).toBe('search "deploy"');
    expect(summarizeToolCall('memory', { action: 'save', content: 'the deploy target is staging' }))
      .toBe('save — "the deploy target is staging"');
    expect(summarizeToolCall('memory', { action: 'sessions' })).toBe('sessions');
    expect(summarizeToolCall('fact', { action: 'remember', key: 'user.tz', value: 'UTC' })).toBe('remember user.tz');
    expect(summarizeToolCall('skills', { action: 'invoke', name: 'code-review' })).toBe('invoke code-review');
    expect(summarizeToolCall('skills', { action: 'list' })).toBe('list');
    expect(summarizeToolCall('web_search', { query: 'workers ai session affinity' }))
      .toBe('"workers ai session affinity"');
    expect(summarizeToolCall('web_fetch', { url: 'https://example.com/docs' })).toBe('https://example.com/docs');
  });

  test('peers distinguishes the addressee and the reply lane', () => {
    expect(summarizeToolCall('peers', { action: 'ask', agent: 'atlas', topic: 'schema' })).toBe('ask atlas — "schema"');
    expect(summarizeToolCall('peers', { action: 'send', agent: 'atlas', message: 'done' })).toBe('send atlas — "done"');
    expect(summarizeToolCall('peers', { action: 'reply', event_id: 'ev-1', message: 'yes' })).toBe('reply — "yes"');
    expect(summarizeToolCall('peers', { action: 'list' })).toBe('list');
  });

  test('report leads with the status it is reporting', () => {
    expect(summarizeToolCall('report', { status: 'completed', content: 'audit finished' }))
      .toBe('completed — "audit finished"');
  });

  test('execute_tools shows the first real line of the program, not a comment', () => {
    expect(summarizeToolCall('execute_tools', {
      code: '// fetch the roster\n\nconst r = await team.list();\nreturn r;',
    })).toBe('const r = await team.list();');
    expect(summarizeToolCall('execute_tools', { code: '// only a comment' })).toBe('');
  });

  test('product_change distinguishes its thirteen actions', () => {
    expect(summarizeToolCall('product_change', { action: 'create', userPrompt: 'dark mode toggle' }))
      .toBe('create — "dark mode toggle"');
    expect(summarizeToolCall('product_change', { action: 'run_checks', checks: [{ name: 'build' }, { name: 'test' }] }))
      .toBe('run_checks — build, test');
    expect(summarizeToolCall('product_change', { action: 'transition', changeId: 'abcdef1234', status: 'deployed' }))
      .toBe('transition abcdef12 → deployed');
    expect(summarizeToolCall('product_change', { action: 'deploy', changeId: 'abcdef1234', deployment: { environment: 'staging' } }))
      .toBe('deploy abcdef12 staging');
    expect(summarizeToolCall('product_change', { action: 'preview', changeId: 'abcdef1234', port: 3000 }))
      .toBe('preview abcdef12 :3000');
    expect(summarizeToolCall('product_change', { action: 'board' })).toBe('board');
  });
});

describe('tool call summaries — truthfulness', () => {
  test('missing, partial and malformed input never fabricate a summary', () => {
    expect(summarizeToolCall('team', undefined)).toBe('');
    expect(summarizeToolCall('run', {})).toBe('');
    expect(summarizeToolCall('run', 'git status')).toBe('');
    expect(summarizeToolCall('think', { strategy: 'heads' })).toBe('heads');
    // Mid-stream partial args: the action has landed, the body has not.
    expect(summarizeToolCall('team', { action: 'assign', name: 'scout' })).toBe('assign scout');
  });

  test('unknown (MCP / crafted) tools show a lone string argument and nothing else', () => {
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open' })).toBe('is:open');
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open', repo: 'proteus' })).toBe('');
    expect(summarizeToolCall('crafted_thing', { count: 3 })).toBe('');
  });

  test('long values are clipped with a visible marker, never silently cut', () => {
    const long = 'a'.repeat(200);
    const summary = summarizeToolCall('run', { command: long });
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(72);
    expect(clip('short')).toBe('short');
    expect(clip('one    two\n three')).toBe('one two three');
  });
});
