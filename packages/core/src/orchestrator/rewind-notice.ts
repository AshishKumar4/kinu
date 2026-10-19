/**
 * What a chat-only rewind tells its agent (REWIND-0924): the person took the conversation back to before a message,
 * so the agent no longer remembers its turns after it, but the computer still holds what they did. It is told the
 * files those turns changed and how, the commands they ran, and what runs and listens on the computer now.
 */
import * as v from 'valibot';
import { JsonValueSchema, safeJsonParse, type JsonObject, type JsonValue } from '../utils/json';
import { authoredTurnMetadata } from '../types/turn-metadata';

/** The `kinuEvent` of a rewind's notice row. */
export const CHAT_REWOUND_EVENT = 'chat_rewound';

/** The computer as a chat-only rewind finds it: read, never woken. `processes` is null when it could not be read
 *  without waking it, with `unread` saying why. */
export interface RewindComputer {
  readonly processes: readonly { readonly command: string; readonly status: string }[] | null;
  readonly unread?: string | undefined;
  readonly ports: readonly { readonly port: number; readonly url: string; readonly name?: string | undefined }[];
}

/** What the rewound turns did, as their calls record it. */
export interface RewoundWork {
  /** Each file the `file` tool changed, in the order first changed, with the changes in the order made. */
  readonly files: ReadonlyMap<string, readonly FileChange[]>;
  /** Each shell command run, in order, with its exit code when it was not zero. */
  readonly commands: readonly { readonly command: string; readonly exitCode: number | null }[];
}

type FileChange = { readonly op: 'edit'; readonly from: string; readonly to: string } | { readonly op: 'write'; readonly lines: number };

const FileCallSchema = v.looseObject({
  type: v.literal('tool-call'), toolCallId: v.string(), toolName: v.literal('file'),
  input: v.variant('op', [
    v.looseObject({ op: v.literal('edit'), path: v.string(), edits: v.array(v.looseObject({ old_text: v.string(), new_text: v.string() })) }),
    v.looseObject({ op: v.literal('write'), path: v.string(), content: v.string() }),
  ]),
});

const ShellCallSchema = v.looseObject({ type: v.literal('tool-call'), toolCallId: v.string(), toolName: v.literal('shell'), input: v.looseObject({ command: v.string() }) });

const FailedResultSchema = v.looseObject({
  type: v.literal('tool-result'), toolCallId: v.string(), output: v.looseObject({ type: v.picklist(['error-text', 'error-json']), value: JsonValueSchema }),
});

/** A command that ran and exited non-zero, as the shell tool fails it: its execution says it ran. */
const RanSchema = v.looseObject({ execution: v.looseObject({ exitCode: v.number() }) });

/** How a failed call ended: refused, so nothing it named changed, or a command that ran and exited `exitCode`. */
function failedAs(value: JsonValue): { readonly exitCode: number } | 'refused' {
  const said = typeof value === 'string' ? safeJsonParse(value) : value;
  const ran = v.safeParse(RanSchema, said);

  return ran.success ? { exitCode: ran.output.execution.exitCode } : 'refused';
}

/** The rewound turns' work, from their stored parts: a call refused before it ran changed nothing, and is left out. */
export function rewoundWork(parts: readonly JsonObject[]): RewoundWork {
  const failed = new Map(parts.flatMap((part) => {
    const result = v.safeParse(FailedResultSchema, part);

    return result.success ? [[result.output.toolCallId, failedAs(result.output.output.value)] as const] : [];
  }));

  const files = new Map<string, FileChange[]>();
  const commands: { command: string; exitCode: number | null }[] = [];

  for (const part of parts) {
    const file = v.safeParse(FileCallSchema, part);
    const shell = v.safeParse(ShellCallSchema, part);

    if (file.success && !failed.has(file.output.toolCallId)) {
      const { input } = file.output;
      const changes = files.get(input.path) ?? [];

      if (input.op === 'edit') changes.push(...input.edits.map((edit) => ({ op: 'edit' as const, from: edit.old_text, to: edit.new_text })));
      else changes.push({ op: 'write', lines: input.content.split('\n').length });
      files.set(input.path, changes);
    } else if (shell.success) {
      const ended = failed.get(shell.output.toolCallId);

      if (ended !== 'refused') commands.push({ command: shell.output.input.command, exitCode: ended?.exitCode ?? null });
    }
  }

  return { files, commands };
}

/** The most paths the card names; it counts the rest. */
const CARD_PATHS = 12;

/** The most of the changes' text the notice carries; past it, each file is named and its changes are left to read. */
const CHANGES_MAX_CHARS = 6000;

const quoted = (text: string, mark: '-' | '+'): string => text.split('\n').map((line) => `${mark} ${line}`).join('\n');

function changesText(work: RewoundWork): string {
  let budget = CHANGES_MAX_CHARS;
  const blocks: string[] = [];

  for (const [path, changes] of work.files) {
    const body = changes.map((change) => (change.op === 'write' ? `(wrote the whole file, ${String(change.lines)} lines)` : `${quoted(change.from, '-')}\n${quoted(change.to, '+')}`)).join('\n');
    const block = body.length <= budget ? `${path}\n${body}` : `${path} (changes not shown: read it)`;

    budget = Math.max(0, budget - body.length);
    blocks.push(block);
  }

  return blocks.join('\n\n');
}

function computerText(computer: RewindComputer): string[] {
  const processes = computer.processes === null
    ? [`Processes running now: not read (${computer.unread ?? 'the computer could not be read without waking it'}).`]
    : [computer.processes.length === 0 ? 'Processes running now: none.' : 'Processes running now:', ...computer.processes.map((row) => `- ${row.command} (${row.status})`)];

  const ports = computer.ports.length === 0
    ? ['Ports exposed now: none.']
    : ['Ports exposed now:', ...computer.ports.map((row) => `- ${String(row.port)}${row.name === undefined ? '' : ` ${row.name}`}: ${row.url}`)];

  return [...processes, ...ports];
}

/** A rewind's notice: its words for the agent, and the fields its card says it by. */
export interface RewindNotice {
  readonly text: string;
  readonly metadata: JsonObject;
}

export function rewindNotice(work: RewoundWork, computer: RewindComputer): RewindNotice {
  const files = [...work.files.keys()];

  const text = [
    'The person rewound this conversation to before one of its messages. Your turns after it are gone from the chat, '
      + 'but what they did on the computer stands. Read a file again before you rely on what you remember of it.',
    files.length === 0 ? 'Files your rewound turns changed with the file tool: none.' : `Files your rewound turns changed with the file tool:\n\n${changesText(work)}`,
    work.commands.length === 0
      ? 'Commands your rewound turns ran: none.'
      : ['Commands your rewound turns ran (their effects, files included, stand):',
        ...work.commands.map((run) => `- ${run.command}${run.exitCode === null ? '' : ` (exit ${String(run.exitCode)})`}`)].join('\n'),
    computerText(computer).join('\n'),
  ].join('\n\n');

  return {
    text,
    metadata: authoredTurnMetadata({ kind: 'programmatic', metadata: {
      kinuEvent: CHAT_REWOUND_EVENT,
      rewoundFiles: files.length,
      rewoundPaths: files.slice(0, CARD_PATHS),
      rewoundCommands: work.commands.length,
      ...(computer.processes !== null && { runningProcesses: computer.processes.length }),
      exposedPorts: computer.ports.map((row) => row.port),
    } }),
  };
}
