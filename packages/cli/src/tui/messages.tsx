/**
 * Message rendering — distinct styles for user, assistant, tool calls,
 * evolution events, and system messages.
 */

import { parseRefusal } from '@kinu.run/core';
import { markdownSyntax, tuiColors } from './theme';
import { clipText } from './format';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'evolution' | 'system';
  content: string;
  toolName?: string;
  args?: string;
  timestamp?: string;
  /** Attachment chip labels (file mentions resolved at submit). */
  attachments?: string[];
  /** User message injected into a running turn (mid-turn steer). */
  steered?: boolean;
  /** User redirect run as a parallel branch (Steer-as-Branch). */
  branched?: boolean;
  /** Assistant text segment still streaming — renders with the live cursor.
   *  Sealed (set false / removed) when a tool call or turn-end follows. */
  live?: boolean;
}

function UserMessage({ content, attachments, steered, branched }: { content: string; attachments?: string[]; steered?: boolean; branched?: boolean }) {
  return (
    <box flexDirection="row" justifyContent="flex-start" style={{ paddingLeft: 2, paddingRight: 2, marginBottom: 1 }}>
      <box
        flexDirection="column"
        style={{
          maxWidth: '82%',
          backgroundColor: tuiColors.bubbleBg,
          border: true,
          borderStyle: 'single',
          borderColor: steered || branched ? tuiColors.amberDeep : tuiColors.bubbleBorder,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 0,
          paddingBottom: 0,
        }}
      >
        <text>
          <strong fg={tuiColors.blue}>You</strong>
          {steered ? <span fg={tuiColors.amber}> ↪ steering</span> : null}
          {branched ? <span fg={tuiColors.amber}> ⎇ branching</span> : null}
        </text>
        <text><span fg={tuiColors.textBright}>{content}</span></text>
        {attachments?.map((label, i) => (
          <text key={i}><span fg={tuiColors.muted}>📎 {label}</span></text>
        ))}
      </box>
    </box>
  );
}

function AssistantMessage({ content, live }: { content: string; live?: boolean }) {
  return (
    <box flexDirection="row" justifyContent="flex-start" style={{ paddingLeft: 2, paddingRight: 2, marginBottom: 1 }}>
      <box
        flexDirection="column"
        style={{
          width: '92%',
          backgroundColor: tuiColors.bg,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text><strong fg={tuiColors.accentStrong}>Agent</strong></text>
        <markdown
          width="100%"
          syntaxStyle={markdownSyntax}
          streaming={live ?? false}
          internalBlockMode="top-level"
          tableOptions={{ style: 'grid', widthMode: 'content' }}
          content={live ? (content || ' ') : content}
          fg={tuiColors.text}
          bg={tuiColors.bg}
        />
        {live ? <text><span fg={tuiColors.borderActive}>▌</span></text> : null}
      </box>
    </box>
  );
}

function ToolCallMessage({ toolName, args }: { toolName: string; args?: string }) {
  return (
    <box style={{ paddingLeft: 4, marginBottom: 0 }}>
      <text>
        <span fg={tuiColors.amberDeep}>⚡ </span>
        <span fg={tuiColors.amber}>{toolName}</span>
        {args ? <span fg={tuiColors.muted}> {clipText(args, 80)}</span> : null}
      </text>
    </box>
  );
}

function ToolResultMessage({ content }: { content: string }) {
  const refusal = parseRefusal(content);
  if (refusal) {
    const [head, ...rest] = refusal.error.split('\n');
    return (
      <box style={{ paddingLeft: 6, marginBottom: 1 }}>
        <text>
          <span fg={tuiColors.red}>✗ refused</span>
          {head ? <span fg={tuiColors.text}> {clipText(head, 160)}</span> : null}
          <span fg={tuiColors.muted}> ({refusal.reason})</span>
        </text>
        {rest.map((line, i) => (
          <text key={i}><span fg={tuiColors.muted}>{clipText(line, 160)}</span></text>
        ))}
      </box>
    );
  }
  return (
    <box style={{ paddingLeft: 6, marginBottom: 1 }}>
      <text>
        <span fg={tuiColors.muted}>↳ {clipText(content, 200)}</span>
      </text>
    </box>
  );
}

function EvolutionMessage({ content }: { content: string }) {
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <span fg={tuiColors.accent}>✦ </span>
        <span fg={tuiColors.accentDeep}>{content}</span>
      </text>
    </box>
  );
}

function SystemMessage({ content }: { content: string }) {
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <span fg={tuiColors.muted}>{content}</span>
      </text>
    </box>
  );
}

interface Props {
  messages: DisplayMessage[];
}

export function MessageList({ messages }: Props) {
  return (
    <>
      {messages.map((msg) => {
        switch (msg.role) {
          case 'user':
            return <UserMessage key={msg.id} content={msg.content} attachments={msg.attachments} steered={msg.steered} branched={msg.branched} />;
          case 'assistant':
            return <AssistantMessage key={msg.id} content={msg.content} live={msg.live} />;
          case 'tool_call':
            return <ToolCallMessage key={msg.id} toolName={msg.toolName ?? ''} args={msg.args} />;
          case 'tool_result':
            return <ToolResultMessage key={msg.id} content={msg.content} />;
          case 'evolution':
            return <EvolutionMessage key={msg.id} content={msg.content} />;
          case 'system':
            return <SystemMessage key={msg.id} content={msg.content} />;
          default:
            return null;
        }
      })}
    </>
  );
}
