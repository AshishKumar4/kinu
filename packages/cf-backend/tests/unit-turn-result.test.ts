import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TextUIPart, ToolUIPart, UIMessage } from 'ai';
import type { JsonObject, JsonValue } from '@kinu.run/core';
import { callFailed } from '@kinu.run/core';
import { MessageView } from '../src/components/MessageView';

type Part = UIMessage['parts'][number];

/** How a part settled: the default is a call that answered `'ok'`. */
interface ToolPartResult {
  readonly state?: 'input-available' | 'output-available' | 'output-error';
  readonly output?: JsonValue;
}

function tool(id: string, name: string, input: JsonObject, result: ToolPartResult = {}): ToolUIPart {
  const { state = 'output-available', output = 'ok' } = result;
  const type: `tool-${string}` = `tool-${name}`;

  if (state === 'output-available') return { type, toolCallId: id, state, input, output };

  if (state === 'output-error') return { type, toolCallId: id, state, input, errorText: 'test failure' };

  return { type, toolCallId: id, state, input };
}

function text(content: string): TextUIPart {
  return { type: 'text', text: content };
}

function render(parts: Part[], isStreaming = false): string {
  const message: UIMessage = { id: 'turn-1', role: 'assistant', parts };

  return renderToStaticMarkup(createElement(MessageView, { message, isLast: true, isStreaming }));
}

/** Parse buttons so commented-out markup cannot satisfy the assertions. */
async function buttonAttributes(html: string, state: 'failed' | 'running'): Promise<ReadonlyMap<string, string>[]> {
  const rows: Map<string, string>[] = [];

  await new HTMLRewriter()
    .on(`button[data-tool-state="${state}"]`, { element(el) { rows.push(new Map(el.attributes)); } })
    .transform(new Response(html))
    .text();

  return rows;
}

describe('MessageView transcript order', () => {
  test.each([false, true])('reasoning, tool, reasoning, text stay in part order (streaming=%s)', (streaming) => {
    const html = render([
      { type: 'reasoning', text: 'Before the read' },
      tool('read', 'file', { action: 'read', path: 'migration.sql' }),
      { type: 'reasoning', text: 'After the read' },
      text('The migration explains the failure.'),
    ], streaming);

    const positions = ['Before the read', 'data-tool-state=', 'After the read', 'The migration explains']
      .map((content) => html.indexOf(content));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).not.toContain('data-turn-result');
  });

  test('a failed read stays collapsed, muted and in its original position', async () => {
    const html = render([
      text('Reading the migration.'),
      tool('a', 'file', { action: 'read', path: 'before.sql' }),
      tool('b', 'file', { action: 'read', path: 'missing.sql' }, { state: 'output-error' }),
      tool('c', 'file', { action: 'read', path: 'after.sql' }),
    ]);

    const rows = await buttonAttributes(html, 'failed');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.get('aria-expanded')).toBe('false');
    expect(rows[0]?.get('class')).toContain('grid-cols-[20px_minmax(0,1fr)_auto_auto]');
    expect(html.indexOf('before.sql')).toBeLessThan(html.indexOf('missing.sql'));
    expect(html.indexOf('missing.sql')).toBeLessThan(html.indexOf('after.sql'));
    expect(html).toContain('Failed');
    expect(html).toContain('1 failed');
    expect(html).not.toContain('p-badge-danger');
    expect(html).not.toContain('test failure');
  });

  test('a provision refusal does not expand its explanatory panel by default', () => {
    const html = render([
      tool('a', 'shell', { command: 'cat missing.sql' }, { output: JSON.stringify({
        error: 'runtime_not_provisioned', runtime: 'sandbox', message: 'nope',
      }) }),
    ]);

    expect(html).toContain('Failed');
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain('Environment</span> tab to provision');
  });

  test('a failed agent call stays in place and closed without an error highlight', () => {
    const html = render([
      text('The first read completed.'),
      tool('a', 'file', { action: 'read', path: 'before.sql' }),
      tool('b', 'agents', { action: 'hire', agent: 'reviewer' }, { state: 'output-error' }),
      text('Continuing with the next step.'),
    ]);

    expect(html.indexOf('before.sql')).toBeLessThan(html.indexOf('data-tool-state="failed"'));
    expect(html.indexOf('data-tool-state="failed"')).toBeLessThan(html.indexOf('Continuing with the next step'));
    expect(html).toContain('Failed');
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toContain('p-danger');
    expect(html).not.toContain('p-badge-danger');
    expect(html).not.toContain('test failure');
  });
});

describe('MessageView reasoning', () => {
  const thought = 'The migration needs a closer look.\n'.repeat(8) + 'Check the final branch.';

  test('the streaming reasoning tail shows a bounded viewport and pulsing label', () => {
    const html = render([{ type: 'reasoning', state: 'streaming', text: thought }], true);

    expect(html).toContain('data-reasoning-viewport');
    expect(html).toContain('max-h-[4lh]');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('motion-safe:animate-[pulse_1.6s_ease-in-out_infinite]');
    expect(html).toContain('motion-reduce:animate-none');
    expect(html).toContain('Check the final branch.');
    expect(html).not.toContain('p-shimmer-text');
    expect(html).not.toContain('>expand<');
  });

  test('reasoning collapses when settled, when followed by a call, and in history', () => {
    const states: Array<{ parts: Part[]; streaming: boolean }> = [
      { parts: [{ type: 'reasoning', state: 'done', text: thought }], streaming: true },
      {
        parts: [
          { type: 'reasoning', state: 'done', text: thought },
          tool('a', 'file', { action: 'read', path: 'migration.sql' }, { state: 'input-available' }),
        ],
        streaming: true,
      },
      { parts: [{ type: 'reasoning', state: 'streaming', text: thought }], streaming: false },
    ];

    for (const { parts, streaming } of states) {
      const html = render(parts, streaming);

      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain('>expand<');
      expect(html).not.toContain('data-reasoning-viewport');
      expect(html).not.toContain('animate-[pulse_1.6s');
      expect(html).not.toContain('Check the final branch.');
    }
  });
});

describe('MessageView tool prominence', () => {
  const operations: Array<{ name: string; mutation: JsonObject; read: JsonObject }> = [
    { name: 'file', mutation: { action: 'write' }, read: { action: 'read' } },
    { name: 'memory', mutation: { action: 'save' }, read: { action: 'search' } },
    { name: 'agents', mutation: { action: 'hire' }, read: { action: 'list' } },
  ];

  test.each(operations)('$name mutations are cards and reads are compact', ({ name, mutation, read }) => {
    const mutated = render([tool('change', name, mutation)]);
    const inspected = render([tool('read', name, read)]);

    expect(mutated).toContain('data-tool-effect="mutate"');
    expect(mutated).toContain('grid-cols-[34px_minmax(0,1fr)_auto_auto]');
    expect(inspected).toContain('data-tool-effect="read"');
    expect(inspected).toContain('grid-cols-[20px_minmax(0,1fr)_auto_auto]');
  });

  test('arbitrary codemode result fields remain unknown, rendered quietly', () => {
    for (const effect of ['read', 'mutate']) {
      const html = render([
        tool('program', 'eval', { code: 'return await inspect()' }, { output: { result: { effect } } }),
      ]);

      expect(html).toContain('data-tool-effect="unknown"');
      expect(html).toContain('grid-cols-[20px_minmax(0,1fr)_auto_auto]');
    }
  });

  test('a shell program is not labelled as a measured read or mutation', () => {
    const html = render([
      tool('read', 'shell', { command: 'cat notes.txt' }),
      tool('write', 'shell', { command: 'touch changed' }),
    ]);

    expect(html).toContain('data-tool-count="2"');
    expect(html).toContain('data-tool-effect="unknown"');
    expect(html).not.toContain('data-tool-effect="read"');
    expect(html).not.toContain('data-tool-effect="mutate"');
    expect(html).not.toContain('grid-cols-[34px_minmax(0,1fr)_auto_auto]');
  });

  test('an in-flight read keeps its own prominent running row', async () => {
    const html = render([
      tool('a', 'file', { action: 'read' }),
      tool('b', 'file', { action: 'read' }),
      tool('running', 'file', { action: 'read' }, { state: 'input-available' }),
    ], true);

    const rows = await buttonAttributes(html, 'running');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.get('data-tool-effect')).toBe('read');
    expect(rows[0]?.get('class')).toContain('grid-cols-[34px_minmax(0,1fr)_auto_auto]');
    expect(html).toContain('data-tool-count="2"');
  });
});

describe('buttonAttributes', () => {
  test('a commented-out button is not selected, whatever the quote style or attribute order', async () => {
    const html = '<!-- <button data-tool-state="failed" aria-expanded="true" class="decoy"> -->'
      + '<button class=\'live\' data-tool-effect=\'read\' data-tool-state=\'failed\' aria-expanded=\'false\'>x</button>';

    const rows = await buttonAttributes(html, 'failed');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.get('aria-expanded')).toBe('false');
    expect(rows[0]?.get('class')).toBe('live');
    expect(rows[0]?.get('data-tool-effect')).toBe('read');
    await expect(buttonAttributes(html, 'running')).resolves.toHaveLength(0);
  });
});

describe('tool failure protocol', () => {
  test('a provision refusal counts as failed', () => {
    const part = tool('a', 'shell', {}, { output: JSON.stringify({
      error: 'runtime_not_provisioned', runtime: 'sandbox', message: 'nope',
    }) });

    expect(callFailed(part)).toBe(true);
  });

  test('error-shaped data from a completed call is not a failure', () => {
    const part = tool('a', 'file', {}, { output: {
      error: 'old_text not found or not unique — the file changed since the last read',
    } });

    expect(callFailed(part)).toBe(false);
  });

  test('tool output that reads like a pass never becomes a check line', () => {
    const html = render([
      text('Suite is green.'),
      tool('a', 'shell', { command: 'bun test' }, { output: '920 pass, 0 fail' }),
    ]);

    expect(html).not.toContain('Check passed');
  });

  test('a plain turn carries no check line', () => {
    expect(render([text('Done.')])).not.toContain('Check passed');
  });
});
