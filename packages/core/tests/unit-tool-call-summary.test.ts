// Tool card summary lines: repeated calls stay distinguishable, and no summary invents detail.
import { describe, test, expect } from 'bun:test';
import { clip, describeToolCall, summarizeToolCall, toolCallEffect } from '../src/tools/tool-call-summary';

describe('tool call summaries — the unified agents tool', () => {
  test('agents calls are told apart by action and target', () => {
    expect(summarizeToolCall('agents', {
      action: 'fork', task: 'compare X vs Y',
      forks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }],
    })).toBe('4 forks: "compare X vs Y"');
    expect(summarizeToolCall('agents', { action: 'fork', task: 'find the fix' }))
      .toBe('fork: "find the fix"');
    expect(summarizeToolCall('agents', { action: 'hire', agent: 'scout', role: 'researcher — landscape' }))
      .toBe('hire scout — "researcher — landscape"');
    expect(summarizeToolCall('agents', { action: 'hire', role: 'researcher' })).toBe('hire researcher');
    expect(summarizeToolCall('agents', { action: 'hire', scope: 'workspace', mission: 'summarize papers' }))
      .toBe('hire workspace — "summarize papers"');
    expect(summarizeToolCall('agents', { action: 'hire', agent: 'scout', message: 'Audit the CLI surface' }))
      .toBe('hire scout — "Audit the CLI surface"');
    expect(summarizeToolCall('agents', { action: 'hire', lifetime: 'task', role: 'auditor', mission: 'Audit the CLI surface' }))
      .toBe('hire (task) auditor');
    expect(summarizeToolCall('agents', { action: 'msg', agent: 'scout', topic: 'fyi' }))
      .toBe('msg scout — "fyi"');
    expect(summarizeToolCall('agents', { action: 'msg', event_id: 'ev-1', message: 'here you go' }))
      .toBe('msg — "here you go"');
    expect(summarizeToolCall('agents', { action: 'dismiss', agent: 'arch-auditor' })).toBe('dismiss arch-auditor');
    expect(summarizeToolCall('agents', { action: 'list' })).toBe('list');
  });
});

// think/team/peers, fact and web_search/web_fetch are retired tools still in stored transcripts.
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
    expect(summarizeToolCall('shell', { command: 'git clone https://example.com/repo', runtime: 'sandbox' }))
      .toBe('git clone https://example.com/repo');
    expect(summarizeToolCall('think', {
      strategy: 'heads', task: 'compare X vs Y',
      heads: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }],
    })).toBe('4 heads: "compare X vs Y"');
    expect(summarizeToolCall('think', { strategy: 'mcts', task: 'find the fix' })).toBe('mcts: "find the fix"');
  });

  test('memory, skills and web name their subject', () => {
    expect(summarizeToolCall('memory', { action: 'search', query: 'deploy' })).toBe('search "deploy"');
    expect(summarizeToolCall('memory', { action: 'save', content: 'the deploy target is staging' }))
      .toBe('save — "the deploy target is staging"');
    expect(summarizeToolCall('memory', { action: 'conversations' })).toBe('conversations');
    expect(summarizeToolCall('memory', { action: 'remember', key: 'user.tz', value: 'UTC' }))
      .toBe('remember user.tz');
    expect(summarizeToolCall('memory', { action: 'forget', key: 'deploy.target' })).toBe('forget deploy.target');
    expect(summarizeToolCall('skills', { action: 'invoke', name: 'code-review' })).toBe('invoke code-review');
    expect(summarizeToolCall('skills', { action: 'list' })).toBe('list');
    expect(summarizeToolCall('web', { action: 'search', query: 'workers ai session affinity' }))
      .toBe('search "workers ai session affinity"');
    expect(summarizeToolCall('web', { action: 'fetch', url: 'https://example.com/docs' }))
      .toBe('fetch https://example.com/docs');
  });

  test('a stored transcript from before the merges still renders', () => {
    expect(summarizeToolCall('fact', { action: 'remember', key: 'user.tz', value: 'UTC' })).toBe('remember user.tz');
    expect(summarizeToolCall('fact', { action: 'recall', key: 'deploy.target' })).toBe('recall deploy.target');
    expect(summarizeToolCall('web_search', { query: 'workers ai session affinity' }))
      .toBe('"workers ai session affinity"');
    expect(summarizeToolCall('web_fetch', { url: 'https://example.com/docs' })).toBe('https://example.com/docs');
    expect(summarizeToolCall('experience', { action: 'search', query: 'auth retry backoff' }))
      .toBe('search — "auth retry backoff"');
    expect(summarizeToolCall('experience', { action: 'publish', kind: 'craft', key: 'slugify' }))
      .toBe('publish craft — "slugify"');
    expect(summarizeToolCall('experience', { action: 'import', id: 'exp-71' })).toBe('import — "exp-71"');
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

  test('release distinguishes its thirteen actions', () => {
    expect(summarizeToolCall('release', { action: 'create', userPrompt: 'dark mode toggle' }))
      .toBe('create — "dark mode toggle"');
    expect(summarizeToolCall('release', { action: 'run_checks', checks: [{ name: 'build' }, { name: 'test' }] }))
      .toBe('run_checks — build, test');
    expect(summarizeToolCall('release', { action: 'transition', changeId: 'abcdef1234', status: 'deployed' }))
      .toBe('transition abcdef12 → deployed');
    expect(summarizeToolCall('release', { action: 'deploy', changeId: 'abcdef1234', deployment: { environment: 'staging' } }))
      .toBe('deploy abcdef12 staging');
    expect(summarizeToolCall('release', { action: 'preview', changeId: 'abcdef1234', port: 3000 }))
      .toBe('preview abcdef12 :3000');
    expect(summarizeToolCall('release', { action: 'board' })).toBe('board');
  });

  test('retired tool names still render, so stored transcripts do not degrade', () => {
    // Persisted transcripts carry these names; each must keep summarizing.
    expect(summarizeToolCall('product_change', { action: 'create', userPrompt: 'dark mode toggle' }))
      .toBe('create — "dark mode toggle"');
    expect(summarizeToolCall('think', { task: 'compare the two designs' })).not.toBe('');
    expect(summarizeToolCall('web_search', { query: 'valibot strict object' })).not.toBe('');
  });
});

describe('tool call summaries — truthfulness', () => {
  test('missing, partial and malformed input never fabricate a summary', () => {
    expect(summarizeToolCall('team', undefined)).toBe('');
    expect(summarizeToolCall('shell', {})).toBe('');
    expect(summarizeToolCall('shell', 'git status')).toBe('');
    expect(summarizeToolCall('think', { strategy: 'heads' })).toBe('heads');
    expect(summarizeToolCall('team', { action: 'assign', name: 'scout' })).toBe('assign scout');
  });

  test('unknown (MCP / crafted) tools show a lone string argument and nothing else', () => {
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open' })).toBe('is:open');
    expect(summarizeToolCall('gh__search_issues', { query: 'is:open', repo: 'kinu' })).toBe('');
    expect(summarizeToolCall('crafted_thing', { count: 3 })).toBe('');
  });

  test('long values are clipped with a visible marker, never silently cut', () => {
    const long = 'a'.repeat(200);
    const summary = summarizeToolCall('shell', { command: long });
    expect(summary.endsWith('…')).toBe(true);
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
    expect(toolCallEffect('web_fetch', { url: 'https://example.com' })).toBe('mutate');
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

