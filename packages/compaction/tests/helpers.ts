/** Shared fixtures: ModelMessage builders and in-memory engine ports. */

import type { AssistantModelMessage, ModelMessage, ToolCallPart, ToolModelMessage, ToolResultPart } from 'ai';
import * as v from 'valibot';
import type { PathPlanes, Storage } from '@kinu.run/core';
import {
  createCompactionExtension,
  type ArchiveIndexStore, type ArchiveRange, type EnginePorts, type Logger, type PlanSnapshot, type PlanStore, type TranscriptStore,
} from '../src/index';

export function user(text: string): ModelMessage {
  return { role: 'user', content: text };
}

export function assistant(content: AssistantModelMessage['content']): ModelMessage {
  return { role: 'assistant', content };
}

export function toolCall(id: string, toolName: string, input: Record<string, string>): ToolCallPart {
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
      toolCall(id, 'shell', { command: `step-${i}.sh` }),
    ]),
    toolMessage([toolResult(id, 'shell', `output-${i} ${'x'.repeat(outputChars)}`)]),
  ];
}

export function history(exchanges: number, outputChars = 3_000): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (let i = 0; i < exchanges; i++) messages.push(...exchange(i, outputChars));

  return messages;
}

/** Properties, not methods: tests read `citablePath` unbound and replace `load`. */
export interface MemoryTranscriptStore extends TranscriptStore {
  writes: Map<string, string>;
  citablePath: (sessionKey: string, rangeHash: string) => string;
}

export interface MemoryPlanStore extends PlanStore {
  snapshots: Map<string, PlanSnapshot>;
  load: (sessionKey: string) => Promise<PlanSnapshot | null> | PlanSnapshot | null;
  save: (sessionKey: string, snapshot: PlanSnapshot | null) => Promise<void> | void;
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
      // No `this`: the engine passes citablePath around unbound.
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

/** A 1280x800 PNG as a screenshot tool returns it: a real header, then 40 KB of its own pixels. */
export function screenshot(n: number): string {
  const bytes = new Uint8Array(40_000).map((_, index) => (index * 31 + n * 7) % 251);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x05, 0x00, 0, 0, 0x03, 0x20];
  bytes.set(header);

  return Buffer.from(bytes).toString('base64');
}

function screenshotResult(n: number): ToolResultPart {
  return {
    type: 'tool-result', toolCallId: `shot_${n}`, toolName: 'browser',
    output: { type: 'content', value: [{ type: 'text', text: `Screen ${n}.` }, { type: 'image-data', data: screenshot(n), mediaType: 'image/png' }] },
  };
}

/** One task whose turn took 20 screenshots, then two short exchanges: the tail the ladder protects. */
export function screenshotRun(): ModelMessage[] {
  return [
    user('Check each of the 20 settings screens and tell me which shows an error.'),
    ...Array.from({ length: 20 }, (_, n) => [
      assistant([toolCall(`shot_${n}`, 'browser', { action: 'screenshot', screen: String(n) })]),
      toolMessage([screenshotResult(n)]),
    ]).flat(),
    assistant([{ type: 'text', text: 'Screen 7 shows the error.' }]),
    user('Thanks.'),
    assistant([{ type: 'text', text: 'Glad to help.' }]),
    user('What did the error say?'),
  ];
}

const ResultSchema = v.object({
  role: v.literal('tool'),
  content: v.tuple([v.object({ output: v.object({ type: v.literal('content'), value: v.array(v.looseObject({ type: v.string() })) }) })]),
});

/** Each screenshot result's entries as sent: `image` where the payload stayed, else the text left in its place. */
export function sentScreens(messages: readonly ModelMessage[]): string[][] {
  return messages.flatMap((message) => {
    const result = v.safeParse(ResultSchema, message);

    if (!result.success) return [];

    return [result.output.content[0].output.value.map((entry) => (entry.type === 'image-data' ? 'image' : v.parse(v.object({ text: v.string() }), entry).text))];
  });
}

/** The links a run of screenshots leaves once compacted over `rt`'s files for `model`, and what else the ladder did. */
export async function compactedScreenshots(rt: { readonly storage: Pick<Storage, 'vfs' | 'home'>; readonly planes: PathPlanes }, model = 'anthropic/claude-sonnet-4-5') {
  const ports = memoryPorts();

  // Kinu's default profile: its recent-tool budget holds the whole run, so only the rung moves anything.
  const extension = createCompactionExtension({
    ports, archive: memoryArchive(), ephemeral: { dropSuperseded: () => 0 },
    summarize: () => { throw new Error('the rung needs no summary'); },
    attachments: { files: () => rt, model: () => model },
  });

  const compacted = await extension.transformContext?.({
    sessionKey: 'screenshots', messages: screenshotRun(), system: 'system prompt', contextWindow: 30_000, trigger: 'auto',
  });

  const screens = sentScreens(compacted ?? []);

  return {
    screens,
    links: screens.flatMap((entries) => entries.flatMap((entry) => /→ (vfs:\/\/\S+)\]$/u.exec(entry)?.[1] ?? [])),
    changed: (ports.plans.snapshots.get('screenshots')?.stages ?? []).filter((stage) => stage.changedParts > 0).map((stage) => stage.name),
  };
}
