import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TextUIPart, ToolUIPart, UIMessage } from 'ai';
import type { JsonObject, JsonValue } from '@kinu.run/core';
import { callFailed, threadLiveTail, TURN_END_METADATA_KEY } from '@kinu.run/core';
import { ChatLiveTail, MessageView } from '../src/components/MessageView';

type Part = UIMessage['parts'][number];

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

function render(parts: Part[], streaming = false): string {
  const message: UIMessage = { id: 'turn-1', role: 'assistant', parts };
  const liveTail = threadLiveTail({ last: message, liveness: streaming ? { kind: 'live', turnId: null } : { kind: 'idle' } });

  return renderToStaticMarkup(createElement(MessageView, { message, liveTail }));
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

  test('a failed call stays in its position, closed, and reads as failed', async () => {
    const html = render([
      text('Reading the migration.'),
      tool('a', 'file', { action: 'read', path: 'before.sql' }),
      tool('b', 'file', { action: 'read', path: 'missing.sql' }, { state: 'output-error' }),
      tool('c', 'file', { action: 'read', path: 'after.sql' }),
    ]);

    const rows = await buttonAttributes(html, 'failed');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.get('aria-expanded')).toBe('false');
    expect(html.indexOf('before.sql')).toBeLessThan(html.indexOf('missing.sql'));
    expect(html.indexOf('missing.sql')).toBeLessThan(html.indexOf('after.sql'));
    expect(html).toContain('Failed');
    // The error itself waits behind the row until the reader opens it.
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

  test('the streaming reasoning tail shows a bounded viewport of the thought', () => {
    const html = render([{ type: 'reasoning', state: 'streaming', text: thought }], true);

    expect(html).toContain('data-reasoning-viewport');
    expect(html).toContain('max-h-[4lh]');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('Check the final branch.');
    expect(html).not.toContain('>expand<');
  });

  test('an inter-step pause and a live reasoning part carry the SAME Thinking affordance', () => {
    // One vocabulary for one fact: the pause and the reasoning come from the same live tail, so transitions keep one shape.
    const pauseMessage: UIMessage = { id: 'turn-1', role: 'assistant', parts: [tool('a', 'file', { action: 'read', path: 'x' })] };

    const pause = renderToStaticMarkup(createElement(ChatLiveTail, {
      tail: threadLiveTail({ last: pauseMessage, liveness: { kind: 'live', turnId: null } }),
    }));

    const reasoning = render([{ type: 'reasoning', state: 'streaming', text: thought }], true);

    const label = (html: string): string => {
      const end = html.indexOf('Thinking');
      expect(end).toBeGreaterThan(-1);
      const start = html.lastIndexOf('<span class="flex items-center gap-2">', end);
      expect(start).toBeGreaterThan(-1);

      return html.slice(start, end + 'Thinking'.length);
    };

    expect(label(reasoning)).toContain('Thinking');
    expect(label(pause)).toBe(label(reasoning));
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
      expect(html).not.toContain('Check the final branch.');
    }
  });
});

describe('MessageView turn end', () => {
  test('a turn that stopped with work pending says so, from its own durable row', () => {
    // The last part is an ordinary settled call, so only the row's own verdict shows the loop ended mid-tools.
    const stopped: UIMessage = {
      id: 'turn-1', role: 'assistant',
      parts: [tool('a', 'shell', { command: 'node server.js' })],
      metadata: { [TURN_END_METADATA_KEY]: 'incomplete' },
    };

    const html = renderToStaticMarkup(createElement(MessageView, { message: stopped, liveTail: null }));

    expect(html).toContain('Stopped before the work was finished');

    expect(render([tool('a', 'shell', { command: 'node server.js' })])).not.toContain('Stopped before the work was finished');
  });
});

describe('MessageView tool rows', () => {
  /** Every settled or running call row, in document order, by its call's own words. */
  async function toolRows(html: string): Promise<string[]> {
    const rows: string[] = [];
    let open = false;

    await new HTMLRewriter()
      .on('button[data-tool-state]', {
        element(el) {
          open = true;
          rows.push('');
          el.onEndTag(() => { open = false; });
        },
        text(chunk) {
          if (open) rows[rows.length - 1] += chunk.text;
        },
      })
      .transform(new Response(html))
      .text();

    return rows;
  }

  function reads(count: number): ToolUIPart[] {
    return Array.from({ length: count }, (_, index) => tool(`r${String(index)}`, 'file', { action: 'read', path: `f${String(index)}.ts` }));
  }

  test('every call is its own row, whatever it does, in the order it ran', async () => {
    const rows = await toolRows(render([
      tool('w', 'file', { action: 'write', path: 'written.ts' }),
      tool('r', 'file', { action: 'read', path: 'read.ts' }),
      tool('m', 'memory', { action: 'save' }),
      tool('s', 'memory', { action: 'search' }),
      tool('h', 'agents', { action: 'hire', agent: 'reviewer' }),
      tool('l', 'agents', { action: 'list' }),
      tool('x', 'shell', { command: 'touch changed' }),
    ]));

    expect(rows).toHaveLength(7);
    expect(rows[0]).toContain('written.ts');
    expect(rows[1]).toContain('read.ts');
  });

  test('a running call shows running on its own row', async () => {
    const html = render([...reads(2), tool('running', 'file', { action: 'read', path: 'live.ts' }, { state: 'input-available' })], true);
    const rows = await toolRows(html);
    const running = await buttonAttributes(html, 'running');

    expect(rows).toHaveLength(3);
    expect(running).toHaveLength(1);
    expect(rows[2]).toContain('live.ts');
    expect(rows[2]).toContain('Running');
  });

  test('a run of nine read-only calls folds its middle behind "7 more"; a run of eight does not fold', async () => {
    const folded = render(reads(9));
    const foldedRows = await toolRows(folded);

    expect(foldedRows).toHaveLength(2);
    expect(foldedRows[0]).toContain('f0.ts');
    expect(foldedRows[1]).toContain('f8.ts');
    expect(folded).toContain('7 more');

    const standing = render(reads(8));

    expect(await toolRows(standing)).toHaveLength(8);
    expect(standing).not.toContain(' more');
  });

  test('a call that is not a read breaks a run, so neither side folds', async () => {
    const html = render([...reads(5), tool('w', 'file', { action: 'write', path: 'between.ts' }), ...reads(5)]);

    expect(await toolRows(html)).toHaveLength(11);
    expect(html).not.toContain(' more');
  });

  test('a shell program, or a codemode program whose result claims a read, never folds as a read', async () => {
    const shell = render(Array.from({ length: 9 }, (_, index) => tool(`s${String(index)}`, 'shell', { command: `cat f${String(index)}.ts` })));
    const programs = render(Array.from({ length: 9 }, (_, index) => tool(`p${String(index)}`, 'eval', { code: 'return await inspect()' }, { output: { result: { effect: 'read' } } })));

    expect(await toolRows(shell)).toHaveLength(9);
    expect(await toolRows(programs)).toHaveLength(9);
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
