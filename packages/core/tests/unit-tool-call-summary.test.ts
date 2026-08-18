// The chat's tool card summary line. Six `team` chips in a row must read as
// six different calls, and no summary may claim detail the arguments never
// carried.
import { describe, test, expect } from 'bun:test';
import { clip, isToolCallFailed, summarizeToolCall } from '../src/tools/tool-call-summary.ts';

describe('tool call summaries — the unified agents tool', () => {
  test('agents calls are told apart by action and target', () => {
    expect(summarizeToolCall('agents', {
      action: 'fork', task: 'compare X vs Y',
      forks: [{ task: 'a' }, { task: 'b' }, { task: 'c' }, { task: 'd' }],
    })).toBe('4 forks: "compare X vs Y"');
    expect(summarizeToolCall('agents', { action: 'fork', task: 'find the fix', settle: 'mcts' }))
      .toBe('fork settle=mcts: "find the fix"');
    expect(summarizeToolCall('agents', { action: 'hire', agent: 'scout', role: 'researcher — landscape' }))
      .toBe('hire scout — "researcher — landscape"');
    expect(summarizeToolCall('agents', { action: 'hire', role: 'researcher' })).toBe('hire researcher');
    expect(summarizeToolCall('agents', { action: 'hire', scope: 'workspace', mission: 'summarize papers' }))
      .toBe('hire workspace — "summarize papers"');
    expect(summarizeToolCall('agents', { action: 'ask', agent: 'scout', message: 'Audit the CLI surface' }))
      .toBe('ask scout — "Audit the CLI surface"');
    expect(summarizeToolCall('agents', { action: 'send', agent: 'scout', topic: 'fyi' }))
      .toBe('send scout — "fyi"');
    expect(summarizeToolCall('agents', { action: 'reply', message: 'here you go' }))
      .toBe('reply — "here you go"');
    expect(summarizeToolCall('agents', { action: 'dismiss', agent: 'arch-auditor' })).toBe('dismiss arch-auditor');
    expect(summarizeToolCall('agents', { action: 'list' })).toBe('list');
  });
});

// NOTE: the think/team/peers, fact and web_search/web_fetch cases below pin
// HISTORICAL renderers — those tools were unified into `agents`, `memory` and
// `web`, but stored transcripts still carry their names and must keep
// rendering.
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

  test('memory, skills and web name their subject', () => {
    expect(summarizeToolCall('memory', { action: 'search', query: 'deploy' })).toBe('search "deploy"');
    expect(summarizeToolCall('memory', { action: 'save', content: 'the deploy target is staging' }))
      .toBe('save — "the deploy target is staging"');
    expect(summarizeToolCall('memory', { action: 'sessions' })).toBe('sessions');
    // The keyed-fact actions read by their key, not by a query they never carry.
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
    // `fact` and web_search/web_fetch calls live in history for good. Their
    // summarizers stay, exactly as think/team/peers did after `agents`.
    expect(summarizeToolCall('fact', { action: 'remember', key: 'user.tz', value: 'UTC' })).toBe('remember user.tz');
    expect(summarizeToolCall('fact', { action: 'recall', key: 'deploy.target' })).toBe('recall deploy.target');
    expect(summarizeToolCall('web_search', { query: 'workers ai session affinity' }))
      .toBe('"workers ai session affinity"');
    expect(summarizeToolCall('web_fetch', { url: 'https://example.com/docs' })).toBe('https://example.com/docs');
    // `experience` left the tool surface for the owner's RPC; the calls the
    // agent already made stay in history and keep their line.
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

  test('execute_tools shows the first real line of the program, not a comment', () => {
    expect(summarizeToolCall('execute_tools', {
      code: '// fetch the roster\n\nconst r = await team.list();\nreturn r;',
    })).toBe('const r = await team.list();');
    expect(summarizeToolCall('execute_tools', { code: '// only a comment' })).toBe('');
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
    // Every name here was once live. A transcript recorded under the old name
    // must keep summarizing after the rename — the alternative is a wall of
    // `summarizeUnknownTool` in history the owner cannot re-record.
    expect(summarizeToolCall('product_change', { action: 'create', userPrompt: 'dark mode toggle' }))
      .toBe('create — "dark mode toggle"');
    expect(summarizeToolCall('think', { task: 'compare the two designs' })).not.toBe('');
    expect(summarizeToolCall('web_search', { query: 'valibot strict object' })).not.toBe('');
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

describe('isToolCallFailed — reads the result, not just the transport', () => {
  test('a protocol-level error is always a failure, whatever the output says', () => {
    expect(isToolCallFailed('run', { command: 'ls' }, undefined, true)).toBe(true);
  });

  test('a `run` command that exits non-zero is a failure even though the transport says it succeeded', () => {
    // execution/exec-result.ts: formatExecResult's non-zero-exit shape.
    expect(isToolCallFailed('run', { command: 'bun test' }, 'Error (exit 1)\n--- stdout ---\n3 failing', false)).toBe(true);
  });

  test('a built-in that caught its own failure and returned {error} is a failure', () => {
    expect(isToolCallFailed('file', { action: 'edit' }, { error: 'old_text not found or not unique' }, false)).toBe(true);
    expect(isToolCallFailed('file', { action: 'edit' }, '{"error":"old_text not found or not unique"}', false)).toBe(true);
  });

  test('a clean success is never flagged — a quiet call with no output, or ordinary text', () => {
    expect(isToolCallFailed('run', { command: 'ls' }, undefined, false)).toBe(false);
    expect(isToolCallFailed('run', { command: 'echo hi' }, 'hi', false)).toBe(false);
    expect(isToolCallFailed('file', { action: 'read' }, 'file contents', false)).toBe(false);
  });

  test('the word "error" appearing inside a normal output is not itself a failure', () => {
    expect(isToolCallFailed('run', { command: 'grep error app.log' }, 'app.log:12: error handler registered', false)).toBe(false);
  });
});
