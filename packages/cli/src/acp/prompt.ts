/**
 * ACP ContentBlock[] <-> the AgentPrompt the chat surfaces already build.
 *
 * ACP clients send a prompt as typed blocks; Kinu turns take text plus
 * data-URL PromptFiles (what @path mentions produce). Editors put the open
 * buffer in `resource` blocks and pasted screenshots in `image` blocks, so
 * both have to survive the crossing.
 */

import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PromptFile } from '@kinu.run/core';
import type { AgentPrompt } from '../agent-client';

/** Text of a single block, or null when it carries no readable text. */
function blockText(block: ContentBlock): string | null {
  switch (block.type) {
    case 'text':
      return block.text;
    // A link is context the model should see; the agent's own tools read the
    // target if it needs the contents.
    case 'resource_link':
      return `@${block.uri}`;
    case 'resource':
      return 'text' in block.resource
        ? `<context uri="${block.resource.uri}">\n${block.resource.text}\n</context>`
        : null;
    default:
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
  // A blob resource is binary the editor already read for us.
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

/** Fold an ACP prompt into the one shape AgentClient.send() accepts. */
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
