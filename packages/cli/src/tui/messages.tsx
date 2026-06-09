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
}

function UserMessage({ content }: { content: string }) {
  return (
    <box flexDirection="row" justifyContent="flex-end" style={{ paddingLeft: 2, paddingRight: 2, marginBottom: 1 }}>
      <box
        flexDirection="column"
        style={{
          maxWidth: '82%',
          backgroundColor: '#18213a',
          border: true,
          borderStyle: 'single',
          borderColor: '#273453',
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 0,
          paddingBottom: 0,
        }}
      >
        <text><strong fg="#60a5fa">You</strong></text>
        <text><span fg="#e2e8f0">{content}</span></text>
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
        <text><strong fg="#c4b5fd">Agent</strong></text>
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
        <text><strong fg="#c4b5fd">Agent</strong></text>
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
        <text><span fg="#7c3aed">▌</span></text>
      </box>
    </box>
  );
}

function ToolCallMessage({ toolName, args }: { toolName: string; args?: string }) {
  return (
    <box style={{ paddingLeft: 4, marginBottom: 0 }}>
      <text>
        <span fg="#f59e0b">⚡ </span>
        <span fg="#fbbf24">{toolName}</span>
        {args ? <span fg="#6b7280"> {args.slice(0, 80)}{args.length > 80 ? '…' : ''}</span> : null}
      </text>
    </box>
  );
}

function ToolResultMessage({ content }: { content: string }) {
  const truncated = content.length > 200 ? content.slice(0, 200) + '…' : content;
  return (
    <box style={{ paddingLeft: 6, marginBottom: 1 }}>
      <text>
        <span fg="#6b7280">↳ {truncated}</span>
      </text>
    </box>
  );
}

function EvolutionMessage({ content }: { content: string }) {
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <span fg="#a78bfa">✦ </span>
        <span fg="#8b5cf6">{content}</span>
      </text>
    </box>
  );
}

function SystemMessage({ content }: { content: string }) {
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <span fg="#6b7280">{content}</span>
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
            return <UserMessage key={msg.id} content={msg.content} />;
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
