import { useTerminalDimensions } from '@opentui/react';
import { parseRefusal, TUI_MARKS } from '@kinu.run/core';

import type { AgentClientStatus } from '../agent-client';
import { clipText } from './format';
import { StatusView } from './help-view';
import { useTuiTheme } from './theme';

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

function UserMessage({ content, attachments, steered, branched }: { content: string; attachments?: string[]; steered?: boolean; branched?: boolean }) {
  const { colors } = useTuiTheme();
  return (
    <box flexDirection="row" style={{ width: '100%', paddingLeft: 2, paddingRight: 2, marginBottom: 1 }}>
      <box style={{ width: 8 }}>
        <text><strong fg={colors.intent.accent}>{TUI_MARKS.userGutter}</strong></text>
      </box>
      <box flexDirection="column" style={{ flexGrow: 1 }}>
        {(steered || branched) && (
          <text><span fg={colors.intent.warning}>{steered ? '↪ steering' : '⎇ branching'}</span></text>
        )}
        <text><span fg={colors.text.primary}>{content}</span></text>
        {attachments?.map((label, index) => (
          <text key={label || index}><span fg={colors.text.muted}>+ {label}</span></text>
        ))}
      </box>
    </box>
  );
}

function AssistantMessage({ content, live }: { content: string; live?: boolean }) {
  const { colors, markdownSyntax } = useTuiTheme();
  return (
    <box flexDirection="column" style={{ width: '100%', paddingLeft: 2, paddingRight: 2, marginBottom: 1, backgroundColor: colors.background.canvas }}>
      <markdown
        width="100%"
        syntaxStyle={markdownSyntax}
        streaming={live ?? false}
        internalBlockMode="top-level"
        tableOptions={{ style: 'grid', widthMode: 'content' }}
        content={live ? (content || ' ') : content}
        fg={colors.text.primary}
        bg={colors.background.canvas}
      />
      {live ? <text><span fg={colors.border.focus}>▌</span></text> : null}
    </box>
  );
}

function ToolCallMessage({ toolName, args, previewWidth }: { toolName: string; args?: string; previewWidth: number }) {
  const { colors } = useTuiTheme();
  const preview = args ? clipText(args.replace(/\s+/g, ' '), previewWidth) : '';
  return (
    <box style={{ paddingLeft: 4 }}>
      <text>
        <span fg={colors.intent.warningMuted}>{TUI_MARKS.toolCall} </span>
        <span fg={colors.intent.warning}>{toolName}</span>
        {preview ? <span fg={colors.text.muted}> {preview}</span> : null}
      </text>
    </box>
  );
}

function ToolResultMessage({ content, success, previewWidth, expanded }: { content: string; success?: boolean; previewWidth: number; expanded: boolean }) {
  const { colors } = useTuiTheme();
  const refusal = parseRefusal(content);
  if (refusal) {
    const [head, ...rest] = refusal.error.split('\n');
    return (
      <box flexDirection="column" style={{ paddingLeft: 6, marginBottom: 1 }}>
        <text>
          <span fg={colors.intent.danger}>{TUI_MARKS.failure} refused</span>
          {head ? <span fg={colors.text.primary}> {clipText(head, previewWidth)}</span> : null}
          <span fg={colors.text.muted}> ({refusal.reason})</span>
        </text>
        {rest.slice(0, expanded ? 12 : 3).map((line, index) => (
          <text key={`${String(index)}-${line}`}><span fg={colors.text.muted}>{expanded ? line : clipText(line, previewWidth)}</span></text>
        ))}
      </box>
    );
  }
  const lines = expanded ? content.split('\n').slice(0, 20) : [clipText(content.replace(/\s+/g, ' '), previewWidth)];
  return (
    <box flexDirection="column" style={{ paddingLeft: 6, marginBottom: 1 }}>
      {lines.map((line, index) => (
        <text key={`${String(index)}-${line}`}>
          <span fg={success === false ? colors.intent.danger : colors.text.muted}>
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

function SystemMessage({ content }: { content: string }) {
  const { colors } = useTuiTheme();
  const failed = content.startsWith('Error:');
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text><span fg={failed ? colors.intent.danger : colors.text.muted}>{failed ? `${TUI_MARKS.failure} ${content}` : content}</span></text>
    </box>
  );
}

export function MessageList({ messages, toolDetailsExpanded = false }: {
  readonly messages: DisplayMessage[];
  readonly toolDetailsExpanded?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const callPreviewWidth = Math.max(8, Math.min(80, width - 28));
  const resultPreviewWidth = Math.max(8, Math.min(120, width - 12));
  return (
    <>
      {messages.map((message) => {
        if (message.status) return <StatusView key={message.id} status={message.status} />;
        switch (message.role) {
          case 'user':
            return <UserMessage key={message.id} content={message.content} attachments={message.attachments} steered={message.steered} branched={message.branched} />;
          case 'assistant':
            return <AssistantMessage key={message.id} content={message.content} live={message.live} />;
          case 'tool_call':
            return <ToolCallMessage key={message.id} toolName={message.toolName ?? ''} args={message.args} previewWidth={callPreviewWidth} />;
          case 'tool_result':
            return <ToolResultMessage key={message.id} content={message.content} success={message.success} previewWidth={resultPreviewWidth} expanded={toolDetailsExpanded} />;
          case 'evolution':
            return <EvolutionMessage key={message.id} content={message.content} />;
          case 'system':
            return <SystemMessage key={message.id} content={message.content} />;
        }
      })}
    </>
  );
}
