/** Shared fixtures: ModelMessage builders and in-memory engine ports. */

import type { AssistantModelMessage, ModelMessage, ToolCallPart, ToolModelMessage, ToolResultPart } from 'ai';
import type {
  ArchiveIndexStore, ArchiveRange, EnginePorts, Logger, PlanSnapshot, PlanStore, TranscriptStore,
} from '../src/index';

export function user(text: string): ModelMessage {
  return { role: 'user', content: text };
}

export function assistant(content: AssistantModelMessage['content']): ModelMessage {
  return { role: 'assistant', content };
}

export function toolCall<Input>(id: string, toolName: string, input: Input): ToolCallPart {
  return { type: 'tool-call', toolCallId: id, toolName, input };
}

export function toolResult(id: string, toolName: string, value: string): ToolResultPart {
  return { type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } };
}

export function toolMessage(results: ToolResultPart[]): ToolModelMessage {
  return { role: 'tool', content: results };
}

/** One user→assistant→tool exchange with a fat tool output. */
export function exchange(i: number, outputChars: number): ModelMessage[] {
  const id = `call_${i}`;
  return [
    user(`Task ${i}: please run step ${i} of the plan.`),
    assistant([
      { type: 'text', text: `Running step ${i} now.` },
      toolCall(id, 'run', { command: `step-${i}.sh` }),
    ]),
    toolMessage([toolResult(id, 'run', `output-${i} ${'x'.repeat(outputChars)}`)]),
  ];
}

export function history(exchanges: number, outputChars = 3_000): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < exchanges; i++) messages.push(...exchange(i, outputChars));
  return messages;
}

export interface MemoryTranscriptStore extends TranscriptStore {
  writes: Map<string, string>;
}

export interface MemoryPlanStore extends PlanStore {
  snapshots: Map<string, PlanSnapshot>;
}

export interface MemoryPorts extends EnginePorts {
  transcripts: MemoryTranscriptStore;
  plans: MemoryPlanStore;
}

const silentLogger: Logger = { info() {}, debug() {}, warn() {}, error() {} };

export function memoryPorts(): MemoryPorts {
  const writes = new Map<string, string>();
  const snapshots = new Map<string, PlanSnapshot>();
  return {
    transcripts: {
      writes,
      // Closure-based (no `this`): the engine passes citablePath around unbound.
      citablePath: (sessionKey, rangeHash) => `.kinu/compaction/${sessionKey}/${rangeHash}.md`,
      write: async (relativePath, content) => {
        writes.set(relativePath, content);
        return { absolutePath: relativePath };
      },
    },
    plans: {
      snapshots,
      load: (sessionKey) => snapshots.get(sessionKey) ?? null,
      save: (sessionKey, snapshot) => {
        if (snapshot === null) snapshots.delete(sessionKey);
        else snapshots.set(sessionKey, snapshot);
      },
    },
    logger: silentLogger,
  };
}

export interface MemoryArchiveStore extends ArchiveIndexStore {
  ranges: Map<string, ArchiveRange[]>;
}

export function memoryArchive(): MemoryArchiveStore {
  const ranges = new Map<string, ArchiveRange[]>();
  return {
    ranges,
    list: (sessionKey) => [...(ranges.get(sessionKey) ?? [])],
    append: (sessionKey, range) => {
      const existing = ranges.get(sessionKey) ?? [];
      if (existing.some((entry) => entry.rangeHash === range.rangeHash)) return;
      ranges.set(sessionKey, [...existing, range]);
    },
    clear: (sessionKey) => {
      ranges.delete(sessionKey);
    },
  };
}

/** A summary comfortably above the engine's 80-char validity floor. */
export function validSummary(tag: string): string {
  return [
    '## Decisions',
    `- Summary(${tag}): keep the verified implementation decisions.`,
    '## Files & Symbols',
    '- packages/compaction/src/extension.ts',
    '## Errors (verbatim)',
    '- (none)',
    '## What failed and why',
    '- (none)',
    '## Constraints',
    '- Preserve exact IDs and paths.',
    '## Next step',
    '- Continue from the compacted checkpoint.',
  ].join('\n');
}
