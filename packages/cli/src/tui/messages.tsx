import { BoxRenderable, CodeRenderable, MarkdownRenderable, TextRenderable, type BoxOptions, type MarkdownOptions } from '@opentui/core';
import * as v from 'valibot';
import { useCallback, useRef } from 'react';

import { TUI_MARKS } from '@kinu.run/core';

import type { AgentClientStatus } from '../agent-client';
import { clipText, terminalText } from '@kinu.run/core';
import { EXPANDED_RESULT_LINES, FileDiffCard, fileEditDiffView } from './diff-card';
import { StatusView } from './help-view';
import { useTuiTheme, type TuiThemeColors } from './theme';
import { useSceneWidth } from './tui-shell';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'evolution' | 'system';
  content: string;
  toolName?: string;
  /** Pairs a result with its call however they interleave. */
  toolCallId?: string;
  args?: string;
  success?: boolean;
  timestamp?: string;
  attachments?: string[];
  steered?: boolean;
  status?: AgentClientStatus;
  branched?: boolean;
  live?: boolean;
}

function UserMessage({ content, attachments, steered, branched }: { content: string; attachments?: string[]; steered?: boolean; branched?: boolean }) {
  const { colors } = useTuiTheme();

  return (
    <box flexDirection="row" style={{ width: '100%', paddingLeft: 2, paddingRight: 2, marginBottom: 1 }}>
      <box style={{ width: 5, flexShrink: 0 }}>
        <text><span fg={colors.intent.accent}>{TUI_MARKS.userGutter}</span></text>
      </box>
      <box flexDirection="column" style={{ flexGrow: 1 }}>
        <text><span fg={colors.text.strong}>{content}</span></text>
        {attachments?.map((label, index) => (
          <text key={label || index}><span fg={colors.text.muted}>+ {label}</span></text>
        ))}
        {(steered === true || branched === true) && (
          <text><span fg={colors.text.muted}>{steered ? '↪ steered mid-turn' : '⎇ branched'}</span></text>
        )}
      </box>
    </box>
  );
}

type WellBoxStyle = Pick<BoxOptions, 'border' | 'borderStyle' | 'borderColor' | 'backgroundColor' | 'paddingLeft' | 'paddingRight'>;

/** Shared by tool cards and fenced code blocks. */
function wellBoxStyle(well: TuiThemeColors['well']): WellBoxStyle {
  return {
    border: ['left'],
    borderStyle: 'single',
    borderColor: well.border,
    backgroundColor: well.fill,
    paddingLeft: 1,
    paddingRight: 1,
  };
}

/**
 * A fenced block on the well; opentui paints fences in markdown ink, so `renderNode` wraps them. The well is read
 * from a ref: `renderNode` is taken once at construction, yet theme changes rerender blocks through it.
 */
function useCodeWellRenderer(): NonNullable<MarkdownOptions['renderNode']> {
  const { colors } = useTuiTheme();
  const palette = useRef(colors);
  palette.current = colors;

  const render: NonNullable<MarkdownOptions['renderNode']> = useCallback((token, context) => {
    if (token.type === 'list') {
      const list = v.safeParse(ListTokenSchema, token);

      return list.success ? renderList(list.output, context, palette.current, render) : null;
    }


    if (token.type !== 'code') return null;
    const code = context.defaultRender();

    if (!(code instanceof CodeRenderable)) return code;
    code.fg = palette.current.well.code;
    code.marginTop = 0;
    const box = new BoxRenderable(code.ctx, { ...wellBoxStyle(palette.current.well), width: '100%', flexDirection: 'column' });
    box.add(code);

    return box;
  }, []);

  return render;
}

/** opentui leaves list markers as literal `-`, so lists are drawn here. */
type RenderNode = NonNullable<MarkdownOptions['renderNode']>;

/** Parsed: marked's `Generic` member types every field `any`. */
const ListTokenSchema = v.object({
  ordered: v.boolean(),
  start: v.union([v.number(), v.literal('')]),
  items: v.array(v.object({ text: v.string(), task: v.boolean(), checked: v.optional(v.boolean()) })),
});

type ListToken = v.InferOutput<typeof ListTokenSchema>;

function listMarker(ordered: boolean, position: number, item: ListToken['items'][number]): string {
  if (ordered) return `${String(position)}. `;

  if (!item.task) return '• ';

  return item.checked ? '☑ ' : '☐ ';
}

function renderList(
  token: ListToken,
  context: Parameters<RenderNode>[1],
  colors: ReturnType<typeof useTuiTheme>['colors'],
  renderNode: RenderNode,
) {
  const probe = context.defaultRender();

  if (probe === null) return null;
  const ctx = probe.ctx;
  probe.destroyRecursively();

  const list = new BoxRenderable(ctx, { width: '100%', flexDirection: 'column' });
  const first = token.start === '' ? 1 : token.start;

  for (const [index, item] of token.items.entries()) {
    const row = new BoxRenderable(ctx, { width: '100%', flexDirection: 'row' });
    const marker = listMarker(token.ordered, first + index, item);
    row.add(new TextRenderable(ctx, { content: marker, fg: colors.intent.accent }));
    row.add(new MarkdownRenderable(ctx, {
      content: item.text,
      syntaxStyle: context.syntaxStyle,
      conceal: context.conceal,
      concealCode: context.concealCode,
      treeSitterClient: context.treeSitterClient,
      fg: colors.text.strong,
      renderNode,
      flexGrow: 1,
      flexShrink: 1,
    }));
    list.add(row);
  }

  return list;
}

function resultMark(success: boolean | undefined): string {
  return success === false ? `${TUI_MARKS.failure} ` : `${TUI_MARKS.toolResult} `;
}

/** Full ink, distinct from thinking and system notes. */
function AssistantMessage({ content, live }: { content: string; live?: boolean }) {
  const { colors, markdownSyntax } = useTuiTheme();
  const renderCodeWell = useCodeWellRenderer();

  return (
    <box flexDirection="column" style={{ width: '100%', paddingLeft: 2, paddingRight: 2, marginBottom: 1 }}>
      <markdown
        width="100%"
        syntaxStyle={markdownSyntax}
        streaming={live ?? false}
        internalBlockMode="top-level"
        tableOptions={{ style: 'grid', widthMode: 'content' }}
        content={live ? (content || ' ') : content}
        fg={colors.text.strong}
        renderNode={renderCodeWell}
      />
      {live ? <text><span fg={colors.intent.accent}>▌</span></text> : null}
    </box>
  );
}

type ToolActivityRow =
  | { readonly kind: 'call'; readonly message: DisplayMessage }
  | { readonly kind: 'result'; readonly message: DisplayMessage; readonly call?: DisplayMessage };

function ToolActivityCard({ rows, callPreviewWidth, resultPreviewWidth, expanded }: {
  readonly rows: readonly ToolActivityRow[];
  readonly callPreviewWidth: number;
  readonly resultPreviewWidth: number;
  readonly expanded: boolean;
}) {
  const { colors } = useTuiTheme();
  const { well } = colors;
  const calls = rows.filter((row) => row.kind === 'call').length;
  const failed = rows.filter((row) => row.kind === 'result' && row.message.success === false).length;
  const rule = '┄'.repeat(Math.max(1, resultPreviewWidth));

  return (
    <box
      flexDirection="column"
      style={{ marginLeft: 2, marginRight: 1, marginBottom: 1, ...wellBoxStyle(well) }}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <span fg={well.ink}>Agent activity</span>
          <span fg={well.muted}> · {calls} call{calls === 1 ? '' : 's'}</span>
        </text>
        {failed > 0 && <text><span fg={well.danger}>{failed} failed</span></text>}
      </box>
      {rows.map((row, index) => {
        const separator = row.kind === 'call' && index > 0
          ? <text><span fg={well.border}>{rule}</span></text>
          : null;

        return (
          <box key={row.message.id} flexDirection="column">
            {separator}
            {row.kind === 'call'
              ? <ToolCallRow toolName={row.message.toolName ?? ''} args={row.message.args} previewWidth={callPreviewWidth} />
              : <ToolResultRow message={row.message} call={row.call} previewWidth={resultPreviewWidth} expanded={expanded} />}
          </box>
        );
      })}
    </box>
  );
}

/** Kept until the content changes: 10 MB of bare ESC took 1 s to sanitize per render (2026-09-25). */
const drawn = new WeakMap<DisplayMessage, { readonly source: string; readonly text: string }>();

/** Text a model or a tool wrote reaches the terminal as text, never as its commands. */
function terminalContent(message: DisplayMessage): string {
  const held = drawn.get(message);

  if (held?.source === message.content) return held.text;
  const text = terminalText(message.content);
  drawn.set(message, { source: message.content, text });

  return text;
}

function ToolCallRow({ toolName, args, previewWidth }: { toolName: string; args?: string; previewWidth: number }) {
  const { well } = useTuiTheme().colors;
  const preview = args ? clipText(terminalText(args).replace(/\s+/g, ' '), previewWidth) : '';

  return (
    <text>
      <span fg={well.accent}>{TUI_MARKS.toolCall} </span>
      <span fg={well.ink}>{toolName}</span>
      {preview ? <span fg={well.muted}> {preview}</span> : null}
    </text>
  );
}

function ToolResultRow({ message, call, previewWidth, expanded }: {
  readonly message: DisplayMessage;
  readonly call: DisplayMessage | undefined;
  readonly previewWidth: number;
  readonly expanded: boolean;
}) {
  const { well } = useTuiTheme().colors;
  const diff = fileEditDiffView(call, message);

  // A file edit or write draws its change-set, not the result's JSON line.
  if (diff !== null) {
    return <FileDiffCard view={diff} expanded={expanded} previewWidth={previewWidth} lineCap={EXPANDED_RESULT_LINES} />;
  }

  const { success } = message;
  const content = terminalContent(message);
  const lines = expanded ? content.split('\n').slice(0, EXPANDED_RESULT_LINES) : [clipText(content.replace(/\s+/g, ' '), previewWidth)];

  return (
    <box flexDirection="column" style={{ paddingLeft: 2 }}>
      {lines.map((line, index) => (
        <text key={`${String(index)}-${line}`}>
          <span fg={well.muted}>{index === 0 ? resultMark(success) : '  '}</span>
          <span fg={success === false ? well.danger : well.success}>{line}</span>
        </text>
      ))}
    </box>
  );
}

function EvolutionMessage({ content }: { content: string }) {
  const { colors } = useTuiTheme();

  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text><span fg={colors.intent.accent}>{TUI_MARKS.evolution} </span><span fg={colors.intent.accentStrong}>{content}</span></text>
    </box>
  );
}

function SystemMessage({ content }: { content: string }) {
  const { colors } = useTuiTheme();

  if (content.startsWith('Error:')) {
    return (
      <box style={{ marginLeft: 2, marginRight: 2, marginBottom: 1, border: true, borderStyle: 'rounded', borderColor: colors.intent.danger, paddingLeft: 1, paddingRight: 1 }}>
        <text><span fg={colors.intent.danger}>{TUI_MARKS.failure} {content}</span></text>
      </box>
    );
  }

  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text><span fg={colors.text.muted}>{content}</span></text>
    </box>
  );
}

type TranscriptBlock =
  | { readonly kind: 'message'; readonly message: DisplayMessage }
  | { readonly kind: 'tools'; readonly key: string; readonly rows: readonly ToolActivityRow[] };

/** Results pair by toolCallId, else nearest unmatched call of the same tool, else nearest. */
function groupTranscript(messages: readonly DisplayMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const pending: DisplayMessage[] = [];
  const pendingById = new Map<string, DisplayMessage>();

  const pair = (message: DisplayMessage): DisplayMessage | undefined => {
    if (message.toolCallId !== undefined) {
      const call = pendingById.get(message.toolCallId);

      if (call !== undefined) {
        pendingById.delete(message.toolCallId);

        const at = pending.indexOf(call);

        if (at >= 0) pending.splice(at, 1);

        return call;
      }
    }

    let index = pending.length - 1;

    if (message.toolName !== undefined) {
      index = -1;

      for (let cursor = pending.length - 1; cursor >= 0; cursor -= 1) {
        if (pending[cursor]?.toolName === message.toolName) {
          index = cursor;
          break;
        }
      }
    }

    if (index < 0) return undefined;
    const [call] = pending.splice(index, 1);

    if (call?.toolCallId !== undefined) pendingById.delete(call.toolCallId);

    return call;
  };

  for (const message of messages) {
    let row: ToolActivityRow | null = null;

    if (!message.status) {
      if (message.role === 'tool_call') {
        row = { kind: 'call', message };
        pending.push(message);

        if (message.toolCallId !== undefined) pendingById.set(message.toolCallId, message);
      } else if (message.role === 'tool_result') {
        const call = pair(message);

        row = call === undefined ? { kind: 'result', message } : { kind: 'result', message, call };
      }
    }

    const last = blocks.at(-1);

    if (row === null) {
      blocks.push({ kind: 'message', message });
    } else if (last?.kind === 'tools') {
      blocks[blocks.length - 1] = { kind: 'tools', key: last.key, rows: [...last.rows, row] };
    } else {
      blocks.push({ kind: 'tools', key: message.id, rows: [row] });
    }
  }

  return blocks;
}

export function MessageList({ messages, toolDetailsExpanded = false }: {
  readonly messages: DisplayMessage[];
  readonly toolDetailsExpanded?: boolean;
}) {
  const width = useSceneWidth();
  const callPreviewWidth = Math.max(8, Math.min(80, width - 24));
  const resultPreviewWidth = Math.max(8, Math.min(120, width - 12));

  return (
    <>
      {groupTranscript(messages).map((block) => {
        if (block.kind === 'tools') {
          return (
            <ToolActivityCard
              key={block.key}
              rows={block.rows}
              callPreviewWidth={callPreviewWidth}
              resultPreviewWidth={resultPreviewWidth}
              expanded={toolDetailsExpanded}
            />
          );
        }

        const { message } = block;

        if (message.status) return <StatusView key={message.id} status={message.status} />;

        const content = terminalContent(message);

        switch (message.role) {
          case 'user':
            return <UserMessage key={message.id} content={content} attachments={message.attachments} steered={message.steered} branched={message.branched} />;
          case 'assistant':
            return <AssistantMessage key={message.id} content={content} live={message.live} />;
          case 'evolution':
            return <EvolutionMessage key={message.id} content={content} />;
          case 'system':
            return <SystemMessage key={message.id} content={content} />;
          case 'tool_call':
          case 'tool_result':
            return null;
        }
      })}
    </>
  );
}
