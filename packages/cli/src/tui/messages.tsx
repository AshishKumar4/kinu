/**
 * Message rendering — distinct styles for user, assistant, tool calls,
 * evolution events, and system messages.
 */

import { markdownSyntax, tuiColors } from './theme.js';

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

function AssistantMessage({ content }: { content: string }) {
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
          streaming={false}
          internalBlockMode="top-level"
          tableOptions={{ style: 'grid', widthMode: 'content' }}
          content={content}
          fg={tuiColors.text}
          bg={tuiColors.bg}
        />
      </box>
    </box>
  );
}

function StreamingMessage({ content }: { content: string }) {
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
          streaming={true}
          internalBlockMode="top-level"
          tableOptions={{ style: 'grid', widthMode: 'content' }}
          content={content || ' '}
          fg={tuiColors.text}
          bg={tuiColors.bg}
        />
        <text><span fg={tuiColors.borderActive}>▌</span></text>
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
        {args ? <span fg={tuiColors.muted}> {args.slice(0, 80)}{args.length > 80 ? '…' : ''}</span> : null}
      </text>
    </box>
  );
}

function ToolResultMessage({ content }: { content: string }) {
  const truncated = content.length > 200 ? content.slice(0, 200) + '…' : content;
  return (
    <box style={{ paddingLeft: 6, marginBottom: 1 }}>
      <text>
        <span fg={tuiColors.muted}>↳ {truncated}</span>
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
  streamingText: string | null;
}

export function MessageList({ messages, streamingText }: Props) {
  return (
    <>
      {messages.map((msg) => {
        switch (msg.role) {
          case 'user':
            return <UserMessage key={msg.id} content={msg.content} attachments={msg.attachments} steered={msg.steered} branched={msg.branched} />;
          case 'assistant':
            return <AssistantMessage key={msg.id} content={msg.content} />;
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
      {streamingText?.trim() ? <StreamingMessage content={streamingText} /> : null}
    </>
  );
}
