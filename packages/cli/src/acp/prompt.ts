/** ACP ContentBlock[] -> AgentPrompt. Editor buffers (`resource`) and screenshots (`image`) must survive. */

import type { ContentBlock } from '@agentclientprotocol/sdk';
import { base64ToBytes, type KeptUpload, type PromptFile } from '@kinu.run/core';
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

/** A file an ACP client sends inline: its bytes, kept as a chat attachment is before the prompt names it. */
interface BlockFile {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

function blockFile(block: ContentBlock): BlockFile | null {
  if (block.type === 'image') return { mediaType: block.mimeType, filename: block.uri ?? 'image', bytes: base64ToBytes(block.data) };

  if (block.type === 'resource' && 'blob' in block.resource) {
    return { mediaType: block.resource.mimeType ?? 'application/octet-stream', filename: block.resource.uri, bytes: base64ToBytes(block.resource.blob) };
  }

  return null;
}

/** An ACP prompt as the agent's: each inline file uploaded first (`upload`, the client's), and named by its path. */
export async function toAgentPrompt(blocks: readonly ContentBlock[], upload: (file: BlockFile) => Promise<KeptUpload>): Promise<AgentPrompt> {
  const text: string[] = [];
  const files: PromptFile[] = [];

  for (const block of blocks) {
    const file = blockFile(block);

    if (file) {
      files.push({ filename: file.filename, mediaType: file.mediaType, ...await upload(file) });
      continue;
    }

    const part = blockText(block);

    if (part !== null) text.push(part);
  }

  const joined = text.join('\n\n');

  return files.length > 0 ? { text: joined, files } : joined;
}
