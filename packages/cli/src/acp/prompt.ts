/** ACP ContentBlock[] -> AgentPrompt. Editor buffers (`resource`) and screenshots (`image`) must survive. */

import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PromptFile } from '@kinu.run/core';
import type { AgentPrompt } from '../agent-client';

function blockText(block: ContentBlock): string | null {
  switch (block.type) {
    case 'text':
      return block.text;
    // A link is context; the agent's own tools read the target if needed.
    case 'resource_link':
      return `@${block.uri}`;
    case 'resource':
      return 'text' in block.resource
        ? `<context uri="${block.resource.uri}">\n${block.resource.text}\n</context>`
        : null;
    // Pictures and sound ride as prompt files, never as text.
    case 'image':
    case 'audio':
      return null;
  }
}

function blockFile(block: ContentBlock): PromptFile | null {
  if (block.type === 'image') {
    return {
      mediaType: block.mimeType,
      filename: block.uri ?? 'image',
      url: `data:${block.mimeType};base64,${block.data}`,
    };
  }

  if (block.type === 'resource' && 'blob' in block.resource) {
    const mediaType = block.resource.mimeType ?? 'application/octet-stream';

    return {
      mediaType,
      filename: block.resource.uri,
      url: `data:${mediaType};base64,${block.resource.blob}`,
    };
  }

  return null;
}

export function toAgentPrompt(blocks: readonly ContentBlock[]): AgentPrompt {
  const text: string[] = [];
  const files: PromptFile[] = [];

  for (const block of blocks) {
    const file = blockFile(block);

    if (file) { files.push(file); continue; }

    const part = blockText(block);

    if (part !== null) text.push(part);
  }

  const joined = text.join('\n\n');

  return files.length > 0 ? { text: joined, files } : joined;
}
