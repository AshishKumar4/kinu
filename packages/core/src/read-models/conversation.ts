/** A conversation read whole from its history pages, and as Markdown: the CLI's and the web's export and fork alike. */

import type { ChatHistoryEntry } from '../types/chat';
import type { Page, PositionCursor, PositionPageRequest } from '../session/page';
import { rowText } from '../utils/ui-message';
import { isSteeredMessage } from './background-event';

/** One row of a conversation, as the CLI's transcript holds it and a chat's messages read. */
export interface ConversationRow {
  readonly role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result';
  readonly content: string;
  readonly toolName?: string;
  readonly args?: string;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));

  return '`'.repeat(longest + 1);
}

function fenced(text: string, lang = ''): string {
  const marker = fence(text);

  return `${marker}${lang}\n${text}\n${marker}`;
}

export function conversationMarkdown(agentName: string, rows: readonly ConversationRow[]): string {
  const sections = rows.map((row) => {
    switch (row.role) {
      case 'user': return `## You\n\n${row.content}`;
      case 'assistant': return `## ${agentName}\n\n${row.content}`;
      case 'system': return `> ${row.content.replaceAll('\n', '\n> ')}`;
      case 'tool_call': return `### ${row.toolName ?? 'tool'}\n\n${fenced(row.args ?? '', 'json')}`;
      case 'tool_result': return fenced(row.content);
    }
  });

  return `# ${agentName}\n\n${sections.join('\n\n')}\n`;
}

export function lastAnswer(rows: readonly ConversationRow[]): string | undefined {
  return [...rows].reverse().find((row) => row.role === 'assistant' && row.content.trim() !== '')?.content;
}

/** A message of a conversation as its history reads: its words, and whether it steered a running turn. */
export interface ConversationMessage extends ConversationRow {
  readonly id: string;
  readonly metadata: ChatHistoryEntry['metadata'];
  readonly steered?: true;
}

/** A durable conversation, oldest first, over a backend's `getChatHistoryPage`. Never capped: a fork pivot past a cap
 *  would read as not found. */
export async function readConversation(
  page: (request: PositionPageRequest) => Promise<Page<ChatHistoryEntry, PositionCursor>>,
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];
  let request: PositionPageRequest = {};

  for (;;) {
    const read = await page(request);
    messages.unshift(...read.items.map(({ id, role, parts, metadata }): ConversationMessage => {
      const content = rowText({ role, parts });

      return isSteeredMessage({ metadata }) ? { id, role, content, metadata, steered: true } : { id, role, content, metadata };
    }));

    if (read.status === 'end') return messages;
    request = { cursor: read.next };
  }
}
