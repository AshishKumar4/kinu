import { BoxRenderable, CodeRenderable, type BoxOptions, type MarkdownOptions } from '@opentui/core';
import { useCallback, useRef } from 'react';

import { parseRefusal, TUI_MARKS } from '@kinu.run/core';

import type { AgentClientStatus } from '../agent-client';
import { clipText } from './format';
import { StatusView } from './help-view';
import { useTuiTheme, type TuiThemeColors } from './theme';
import { useSceneWidth } from './tui-shell';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'evolution' | 'system';
  content: string;
  toolName?: string;
  args?: string;
  success?: boolean;
  timestamp?: string;
  attachments?: string[];
  steered?: boolean;
  status?: AgentClientStatus;
  branched?: boolean;
  live?: boolean;
}

/**
 * The user turn as the web draws it (`MessageView.tsx` `USER_BUBBLE_CLASS`):
 * a bubble set to the right at most 80% wide, the user fill under the user
 * edge, ink text, and the steer mark under it rather than a speaker label.
 */
function UserMessage({ content, attachments, steered, branched }: { content: string; attachments?: string[]; steered?: boolean; branched?: boolean }) {
  const { colors } = useTuiTheme();
  return (
    <box flexDirection="column" alignItems="flex-end" style={{ width: '100%', paddingLeft: 2, paddingRight: 2, marginBottom: 1 }}>
      <box
        flexDirection="column"
        style={{
          maxWidth: '80%',
          border: true,
          borderStyle: 'rounded',
          borderColor: colors.border.user,
          backgroundColor: colors.background.user,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text><span fg={colors.text.strong}>{content}</span></text>
        {attachments?.map((label, index) => (
          <text key={label || index}><span fg={colors.text.muted}>+ {label}</span></text>
        ))}
      </box>
      {(steered || branched) && (
        <text><span fg={colors.text.muted}>{steered ? '↪ steered mid-turn' : '⎇ branched'}</span></text>
      )}
    </box>
  );
}

type WellBoxStyle = Pick<BoxOptions, 'border' | 'borderStyle' | 'borderColor' | 'backgroundColor' | 'paddingLeft' | 'paddingRight'>;

/**
 * The dark well: the box a tool card sits on and the box a fenced code block
 * sits in. One definition, so the two surfaces cannot drift apart.
 */
function wellBoxStyle(well: TuiThemeColors['well']): WellBoxStyle {
  return {
    border: true,
    borderStyle: 'rounded',
    borderColor: well.border,
    backgroundColor: well.fill,
    paddingLeft: 1,
    paddingRight: 1,
  };
}

/**
 * A fenced block on the well. opentui gives a fenced block its own
 * `CodeRenderable` built with the markdown renderable's ink and fill
 * (`MarkdownRenderable.createCodeRenderable` passes `fg: this._fg`,
 * `bg: this._bg`), so the `code` syntax style's fill never reaches the block
 * and the code reads in prose ink. `renderNode`
 * (`MarkdownOptions.renderNode`, @opentui/core/renderables/Markdown.d.ts:92)
 * is that renderable's own block hook: it hands the default block back, and
 * the well is the tool card's box around it, in the well's code ink.
 *
 * The hook reads the well from a ref, not from its own closure, because
 * `MarkdownRenderable` takes `renderNode` once at construction and declares no
 * setter for it. A theme change re-creates every block through this same
 * callback (`refreshStyles` → `rerenderBlocks` → `updateBlocks(true)`), which
 * must paint the theme in force at that moment.
 */
function useCodeWellRenderer(): NonNullable<MarkdownOptions['renderNode']> {
  const { colors } = useTuiTheme();
  const well = useRef(colors.well);
  well.current = colors.well;
  return useCallback((token, context) => {
    if (token.type !== 'code') return null;
    const code = context.defaultRender();
    if (!(code instanceof CodeRenderable)) return code;
    code.fg = well.current.code;
    code.marginTop = 0;
    const box = new BoxRenderable(code.ctx, { ...wellBoxStyle(well.current), width: '100%', flexDirection: 'column' });
    box.add(code);
    return box;
  }, []);
}

/** Prose on the canvas, in the ink register: the agent's body must read as
 * neither thinking (muted, italic) nor a system annotation (muted). */
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
  | { readonly kind: 'result'; readonly message: DisplayMessage };

/**
 * A run of tool calls as one card, the web's `ToolCallGroup`: a header that
 * counts the calls and the failures, one row per call with its result under
 * it, dashed rules between calls. The card is the well — dark in every theme
 * — so it carries the well's own inks.
 */
function ToolActivityCard({ rows, callPreviewWidth, resultPreviewWidth, expanded }: {
  readonly rows: readonly ToolActivityRow[];
  readonly callPreviewWidth: number;
  readonly resultPreviewWidth: number;
  readonly expanded: boolean;
}) {
  const { colors } = useTuiTheme();
  const { well } = colors;
  const calls = rows.filter((row) => row.kind === 'call').length;
  const failed = rows.filter((row) => row.kind === 'result' && (row.message.success === false || parseRefusal(row.message.content) !== null)).length;
  const rule = '┄'.repeat(Math.max(1, resultPreviewWidth));
  return (
    <box
      flexDirection="column"
      style={{ marginLeft: 2, marginRight: 2, marginBottom: 1, ...wellBoxStyle(well) }}
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
              : <ToolResultRow content={row.message.content} success={row.message.success} previewWidth={resultPreviewWidth} expanded={expanded} />}
          </box>
        );
      })}
    </box>
  );
}

function ToolCallRow({ toolName, args, previewWidth }: { toolName: string; args?: string; previewWidth: number }) {
  const { well } = useTuiTheme().colors;
  const preview = args ? clipText(args.replace(/\s+/g, ' '), previewWidth) : '';
  return (
    <text>
      <span fg={well.accent}>{TUI_MARKS.toolCall} </span>
      <span fg={well.ink}>{toolName}</span>
      {preview ? <span fg={well.muted}> {preview}</span> : null}
    </text>
  );
}

function ToolResultRow({ content, success, previewWidth, expanded }: { content: string; success?: boolean; previewWidth: number; expanded: boolean }) {
  const { well } = useTuiTheme().colors;
  const refusal = parseRefusal(content);
  if (refusal) {
    const [head, ...rest] = refusal.error.split('\n');
    return (
      <box flexDirection="column" style={{ paddingLeft: 2 }}>
        <text>
          <span fg={well.danger}>{TUI_MARKS.failure} refused</span>
          {head ? <span fg={well.ink}> {clipText(head, previewWidth)}</span> : null}
          <span fg={well.muted}> ({refusal.reason})</span>
        </text>
        {rest.slice(0, expanded ? 12 : 3).map((line, index) => (
          <text key={`${String(index)}-${line}`}><span fg={well.muted}>{expanded ? line : clipText(line, previewWidth)}</span></text>
        ))}
      </box>
    );
  }
  const lines = expanded ? content.split('\n').slice(0, 20) : [clipText(content.replace(/\s+/g, ' '), previewWidth)];
  return (
    <box flexDirection="column" style={{ paddingLeft: 2 }}>
      {lines.map((line, index) => (
        <text key={`${String(index)}-${line}`}>
          <span fg={success === false ? well.danger : well.muted}>
            {index === 0 ? (success === false ? `${TUI_MARKS.failure} ` : `${TUI_MARKS.toolResult} `) : '  '}{line}
          </span>
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

/**
 * A system note is an annotation in the dim register. An error is the web's
 * `p-notice-danger`: a bordered notice in the danger hue.
 */
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

/** Consecutive tool calls and results fold into one activity card. */
function groupTranscript(messages: readonly DisplayMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const message of messages) {
    const row: ToolActivityRow | null = message.status
      ? null
      : message.role === 'tool_call'
        ? { kind: 'call', message }
        : message.role === 'tool_result'
          ? { kind: 'result', message }
          : null;
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
        switch (message.role) {
          case 'user':
            return <UserMessage key={message.id} content={message.content} attachments={message.attachments} steered={message.steered} branched={message.branched} />;
          case 'assistant':
            return <AssistantMessage key={message.id} content={message.content} live={message.live} />;
          case 'evolution':
            return <EvolutionMessage key={message.id} content={message.content} />;
          case 'system':
            return <SystemMessage key={message.id} content={message.content} />;
          case 'tool_call':
          case 'tool_result':
            return null;
        }
      })}
    </>
  );
}
