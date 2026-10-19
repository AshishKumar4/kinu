/**
 * What a chat-only rewind tells its agent (REWIND-0924): the person took the conversation back to before a message,
 * so the agent no longer remembers its turns after it, but the computer still holds what they did. It is told the
 * files those turns changed with the file tool and how, the commands and programs they ran, and, where its host can
 * read the computer, what runs and listens on it now.
 */
import * as v from 'valibot';
import { JsonValueSchema, safeJsonParse, type JsonObject, type JsonValue } from '../utils/json';
import { authoredTurnMetadata } from '../types/turn-metadata';
import { FILE } from '../operations/file';
import { SHELL } from '../operations/shell';
import { BUILTIN_TOOL_SPECS } from '../tools/registry';
import { EVAL_PROGRAM } from '../tools/sandbox-contract';

/** The `kinuEvent` of a rewind's notice row. */
export const CHAT_REWOUND_EVENT = 'chat_rewound';

/** The computer as a chat-only rewind finds it: read, never woken. `processes` is null when it could not be read
 *  without waking it, with `unread` saying why. */
export interface RewindComputer {
  readonly processes: readonly { readonly command: string; readonly status: string }[] | null;
  readonly unread?: string | undefined;
  readonly ports: readonly { readonly port: number; readonly url: string; readonly name?: string | undefined }[];
}

/** A chat-only rewind's notice is owed: `computer` where its host reads one (a workspace's), absent where it does not
 *  (the CLI's machine, whose processes and ports no reader lists). */
export interface RewindTold {
  readonly computer?: RewindComputer | undefined;
}

/** What the rewound turns did, as their calls record it. */
export interface RewoundWork {
  /** Each file the `file` tool changed, in the order first changed, with the changes in the order made. */
  readonly files: ReadonlyMap<string, readonly FileChange[]>;
  /** Each shell command run, in order, with its exit code when it was not zero. */
  readonly commands: readonly { readonly command: string; readonly exitCode: number | null }[];
  /** The `eval` programs that ran, and how many of them failed: what they did is theirs, and stands. */
  readonly programs: { readonly ran: number; readonly failed: number };
}

type FileChange = { readonly op: 'edit'; readonly from: string; readonly to: string } | { readonly op: 'write'; readonly lines: number };

/** A tool call as its part keeps it; its input is read with the tool's own schema. */
const CallSchema = v.looseObject({ type: v.literal('tool-call'), toolCallId: v.string(), toolName: v.string(), input: JsonValueSchema });

/** The `file` tool's input: `op` names the operation, and the rest is that operation's own input. */
const FileOpSchema = v.looseObject({ op: v.string() });

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

/** The changes a `file` call made, read with its operation's own input schema; none for a read or a refused call. */
function fileChanges(input: JsonValue): { readonly path: string; readonly changes: readonly FileChange[] } | null {
  const named = v.safeParse(FileOpSchema, input);

  if (!named.success) return null;
  const { op, ...fields } = named.output;
  const edit = v.safeParse(FILE.edit.input, fields);
  const write = v.safeParse(FILE.write.input, fields);

  if (op === FILE.edit.name && edit.success) {
    return { path: edit.output.path, changes: edit.output.edits.map((change) => ({ op: 'edit', from: change.old_text, to: change.new_text })) };
  }

  return op === FILE.write.name && write.success ? { path: write.output.path, changes: [{ op: 'write', lines: write.output.content.split('\n').length }] } : null;
}

/** The rewound turns' work, from their stored parts: a call refused before it ran changed nothing, and is left out. */
export function rewoundWork(parts: readonly JsonObject[]): RewoundWork {
  const failed = new Map(parts.flatMap((part) => {
    const result = v.safeParse(FailedResultSchema, part);

    return result.success ? [[result.output.toolCallId, failedAs(result.output.output.value)] as const] : [];
  }));

  const files = new Map<string, FileChange[]>();
  const commands: { command: string; exitCode: number | null }[] = [];
  const programs = { ran: 0, failed: 0 };

  for (const part of parts) {
    const call = v.safeParse(CallSchema, part);

    if (!call.success) continue;
    const { toolCallId, toolName, input } = call.output;
    const ended = failed.get(toolCallId);

    if (toolName === BUILTIN_TOOL_SPECS.file.name && ended === undefined) {
      const changed = fileChanges(input);

      if (changed !== null) files.set(changed.path, [...files.get(changed.path) ?? [], ...changed.changes]);
    } else if (toolName === BUILTIN_TOOL_SPECS.shell.name && ended !== 'refused' && v.is(SHELL.run.input, input)) {
      commands.push({ command: v.parse(SHELL.run.input, input).command, exitCode: ended?.exitCode ?? null });
    } else if (toolName === BUILTIN_TOOL_SPECS.eval.name && v.is(EVAL_PROGRAM.input, input)) {
      // A program that failed may have done part of its work first: it ran, and is counted.
      programs.ran += 1;

      if (ended !== undefined) programs.failed += 1;
    }
  }

  return { files, commands, programs };
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

/** What the rewound turns ran: shell commands by name, programs by count. */
function ranText(work: RewoundWork): string {
  const { ran, failed } = work.programs;

  if (work.commands.length === 0 && ran === 0) return 'Your rewound turns ran no shell commands and no programs.';

  const commands = work.commands.length === 0
    ? []
    : ['Shell commands your rewound turns ran:', ...work.commands.map((run) => `- ${run.command}${run.exitCode === null ? '' : ` (exit ${String(run.exitCode)})`}`)];

  const programs = ran === 0
    ? []
    : [`Programs (eval) your rewound turns ran: ${String(ran)}${failed === 0 ? '' : `, ${String(failed)} of them failed`}. `
      + 'What a program did, its own file writes and commands included, is not listed here: read what it touched.'];

  return [...commands, ...(commands.length > 0 && programs.length > 0 ? [''] : []), ...programs, 'Whatever they did stands.'].join('\n');
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

export function rewindNotice(work: RewoundWork, computer: RewindComputer | undefined): RewindNotice {
  const files = [...work.files.keys()];

  const text = [
    'The person rewound this conversation to before one of its messages. Your turns after it are gone from the chat, '
      + 'but what they did stands. Read a file again before you rely on what you remember of it.',
    files.length === 0 ? 'Files your rewound turns changed with the file tool: none.' : `Files your rewound turns changed with the file tool:\n\n${changesText(work)}`,
    ranText(work),
    ...(computer === undefined ? [] : [computerText(computer).join('\n')]),
  ].join('\n\n');

  return {
    text,
    metadata: authoredTurnMetadata({ kind: 'programmatic', metadata: {
      kinuEvent: CHAT_REWOUND_EVENT,
      rewoundFiles: files.length,
      rewoundPaths: files.slice(0, CARD_PATHS),
      rewoundCommands: work.commands.length,
      rewoundPrograms: work.programs.ran,
      ...(computer !== undefined && computer.processes !== null && { runningProcesses: computer.processes.length }),
      ...(computer !== undefined && { exposedPorts: computer.ports.map((row) => row.port) }),
    } }),
  };
}
