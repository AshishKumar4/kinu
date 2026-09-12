/**
 * A completed turn leads with its result, from the ledger, never from prose.
 *
 * The counts come from the turn's own settled tool parts — the UI half of the
 * `tool_call_end` rows — and nothing else. Prose that claims its own tally is
 * not evidence, and a tool output that reads like a pass is not a check.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TextUIPart, ToolUIPart, UIMessage } from 'ai';
import {
  callFailed, formatTurnResult,
  splitCompletedTurn, turnResultFacts,
} from '../src/components/tool-call-grouping';
import { MessageView } from '../src/components/MessageView';

type Part = UIMessage['parts'][number];

function tool(
  id: string,
  name: string,
  state: 'input-available' | 'output-available' | 'output-error',
  output: string | Record<string, string>,
): ToolUIPart {
  const type: `tool-${string}` = `tool-${name}`;

  if (state === 'output-available') return { type, toolCallId: id, state, input: {}, output };

  if (state === 'output-error') return { type, toolCallId: id, state, input: {}, errorText: 'test failure' };

  return { type, toolCallId: id, state, input: {} };
}

function ok(id: string, name = 'file'): ToolUIPart {
  return tool(id, name, 'output-available', '…');
}

function failed(id: string, name = 'file'): ToolUIPart {
  return tool(id, name, 'output-error', '…');
}

function text(content: string): TextUIPart {
  return { type: 'text', text: content };
}

function craftedCall(id: string, toolName: string): Part {
  return { type: 'dynamic-tool', toolName, toolCallId: id, state: 'output-available', input: {}, output: 'ok' };
}

describe('turnResultFacts', () => {
  test('counts settled calls and failures from parts, never from prose', () => {
    const facts = turnResultFacts([
      text('3 tool calls, 9 failed — the prose lies, the parts do not'),
      ok('a'), failed('b'), ok('c'),
    ]);

    expect(facts.calls).toBe(3);
    expect(facts.failed).toBe(1);
    expect(formatTurnResult(facts)).toBe('3 tool calls, 1 failed');
  });

  test('a clean turn names no failures', () => {
    expect(formatTurnResult(turnResultFacts([ok('a'), ok('b')]))).toBe('2 tool calls');
    expect(formatTurnResult(turnResultFacts([ok('a')]))).toBe('1 tool call');
  });

  test('a turn with no calls has no result line', () => {
    expect(formatTurnResult(turnResultFacts([text('just prose')]))).toBeNull();
  });

  test('a provision refusal counts as failed', () => {
    const part = tool('a', 'run', 'output-available', JSON.stringify({
      error: 'runtime_not_provisioned', runtime: 'sandbox', message: 'nope',
    }));

    expect(callFailed(part)).toBe(true);
    expect(turnResultFacts([part]).failed).toBe(1);
  });

  test('error-shaped data from a completed call is not a failure', () => {
    const part: ToolUIPart = {
      type: 'tool-file', toolCallId: 'a', state: 'output-available', input: {},
      output: { error: 'old_text not found or not unique — the file changed since the last read' },
    };

    expect(callFailed(part)).toBe(false);
    expect(turnResultFacts([part]).failed).toBe(0);
  });
});

describe('turnResultFacts crafted attribution', () => {
  test('names the crafted tool the turn actually called', () => {
    const facts = turnResultFacts([ok('a', 'file'), craftedCall('b', 'bisect_migration')]);

    expect(facts.crafted).toEqual(['bisect_migration']);
  });

  test('builtins and MCP tools never attribute', () => {
    const facts = turnResultFacts([
      ok('a', 'run'), craftedCall('b', 'mcp_gh_search_pull_requests'),
    ]);

    expect(facts.crafted).toEqual([]);
  });
});

describe('splitCompletedTurn', () => {
  test('prose keeps its order ahead of the settled activity', () => {
    const split = splitCompletedTurn([ok('a'), text('found it'), ok('b')]);

    expect(split.content.map((part) => part.type)).toEqual(['text']);
    expect(split.settled.map((part) => part.toolCallId)).toEqual(['a', 'b']);
    expect(split.open).toEqual([]);
  });

  test('a call still open never joins the settled group', () => {
    const split = splitCompletedTurn([ok('a'), tool('b', 'run', 'input-available', '…')]);

    expect(split.settled).toHaveLength(1);
    expect(split.open).toHaveLength(1);
  });
});

function render(parts: Part[]): string {
  const message: UIMessage = { id: 'turn-1', role: 'assistant', parts };

  return renderToStaticMarkup(createElement(MessageView, { message, isLast: false, isStreaming: false }));
}

describe('MessageView completed turn', () => {
  test('the result line leads, and the failed row stays expanded and first', () => {
    const html = render([
      text('Found it. Patching the migration now.'),
      ok('a'), failed('b'), ok('c'),
    ]);

    expect(html).toContain('3 tool calls, 1 failed');
    // The result leads the prose, never the other way round.
    expect(html.indexOf('3 tool calls, 1 failed')).toBeLessThan(html.indexOf('Patching the migration'));
    // The failed call renders before the successful ones, already expanded.
    expect(html.indexOf('data-tool-state="failed"')).toBeLessThan(html.indexOf('data-tool-state="done"'));
    expect(html).toContain('aria-expanded="true"');
  });

  test('a tool output that reads like a pass never becomes a check line', () => {
    const html = render([
      text('Suite is green.'),
      tool('a', 'run', 'output-available', '920 pass, 0 fail'),
    ]);

    expect(html).not.toContain('Check passed');
  });

  test('a plain turn carries no check line', () => {
    const html = render([text('Done.'), ok('a'), ok('b')]);

    expect(html).not.toContain('Check passed');
  });
});
