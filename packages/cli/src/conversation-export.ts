import type { AgentTranscriptMessage } from './agent-client';

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));

  return '`'.repeat(longest + 1);
}

function fenced(text: string, lang = ''): string {
  const marker = fence(text);

  return `${marker}${lang}\n${text}\n${marker}`;
}

export function conversationMarkdown(agentName: string, rows: readonly AgentTranscriptMessage[]): string {
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

export function lastAnswer(rows: readonly AgentTranscriptMessage[]): string | undefined {
  return [...rows].reverse().find((row) => row.role === 'assistant' && row.content.trim() !== '')?.content;
}
