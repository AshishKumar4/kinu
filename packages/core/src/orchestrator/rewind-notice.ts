/**
 * What a chat-only rewind tells its agent (REWIND-0924): the person took the conversation back to before a message,
 * so the agent no longer remembers its turns after it, but the computer still holds what they did. It is told the
 * files those turns changed and how, the commands and programs they ran, and, where its host can read the computer,
 * what runs and listens on it now. A program's own file writes, commands and other changes are its record's, as the
 * host made it while it ran (`execution/call-effects.ts`).
 */
import * as v from 'valibot';
import { JsonValueSchema, safeJsonParse, type JsonObject, type JsonValue } from '../utils/json';
import { FILE } from '../operations/file';
import { SHELL } from '../operations/shell';
import { BUILTIN_TOOL_SPECS } from '../tools/registry';
import { EVAL_PROGRAM } from '../tools/sandbox-contract';
import { programEffectsOf, type ProgramEffects } from '../execution/call-effects';

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
  /** Each command run, in order, with its exit code when it was not zero, and the machine a program ran it on. */
  readonly commands: readonly { readonly command: string; readonly exitCode: number | null; readonly machine?: string }[];
  /**
   * The `eval` programs that ran, how many of them failed, the other changes their records name, and how many ran with
   * no record (made before programs were recorded, or failed before changing anything): what those did is not known.
   */
  readonly programs: {
    readonly ran: number;
    readonly failed: number;
    readonly operations: ReadonlyMap<string, number>;
    readonly unrecorded: number;
    /** Files, commands and operations past a record's bounds, and calls no declaration classifies. */
    readonly untold: number;
  };
}

type FileChange =
  | { readonly op: 'edit'; readonly from: string; readonly to: string }
  | { readonly op: 'write'; readonly lines: number }
  | { readonly op: 'program'; readonly change: ProgramEffects['files'][number]['change'] };

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

/** A call's result as its part keeps it, settled or failed: what a program's record is read from. */
const ResultSchema = v.looseObject({ type: v.literal('tool-result'), toolCallId: v.string(), output: v.looseObject({ value: JsonValueSchema }) });

/** A program's record, kept as the rewound turns' own: its files, commands and operations beside the file tool's. */
function addProgram(work: { files: Map<string, FileChange[]>; commands: RewoundWork['commands'][number][]; operations: Map<string, number> }, effects: ProgramEffects): void {
  for (const file of effects.files) work.files.set(file.path, [...work.files.get(file.path) ?? [], { op: 'program', change: file.change }]);

  for (const ran of effects.commands) work.commands.push({ command: ran.command, exitCode: ran.exitCode === 0 ? null : ran.exitCode, machine: ran.machine });

  for (const [name, count] of Object.entries(effects.operations)) work.operations.set(name, (work.operations.get(name) ?? 0) + count);
}

/** The rewound turns' work, from their stored parts: a call refused before it ran changed nothing, and is left out. */
export function rewoundWork(parts: readonly JsonObject[]): RewoundWork {
  const failed = new Map(parts.flatMap((part) => {
    const result = v.safeParse(FailedResultSchema, part);

    return result.success ? [[result.output.toolCallId, failedAs(result.output.output.value)] as const] : [];
  }));

  const answered = new Map(parts.flatMap((part) => {
    const result = v.safeParse(ResultSchema, part);

    return result.success ? [[result.output.toolCallId, result.output.output.value] as const] : [];
  }));

  const files = new Map<string, FileChange[]>();
  const commands: RewoundWork['commands'][number][] = [];
  const operations = new Map<string, number>();
  const programs = { ran: 0, failed: 0, unrecorded: 0, untold: 0 };

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
      // A program that failed may have done part of its work first: it ran, is counted, and its record says what it did.
      const effects = programEffectsOf(toolCallId, answered.get(toolCallId));

      programs.ran += 1;

      if (ended !== undefined) programs.failed += 1;

      if (effects === null) programs.unrecorded += 1;
      else {
        addProgram({ files, commands, operations }, effects);
        programs.untold += (effects.more ?? 0) + (effects.unclassified ?? 0);
      }
    }
  }

  return { files, commands, programs: { ...programs, operations } };
}


/** The most of the changes' text the notice carries; past it, each file is named and its changes are left to read. */
const CHANGES_MAX_CHARS = 6000;

const quoted = (text: string, mark: '-' | '+'): string => text.split('\n').map((line) => `${mark} ${line}`).join('\n');

/** A program's change, by what it did to the file: its record holds no text, so the file is read for that. */
const PROGRAM_CHANGES = { created: 'a program created it', replaced: 'a program wrote the whole file', edited: 'a program edited it' } as const;

function changeText(change: FileChange): string {
  if (change.op === 'write') return `(wrote the whole file, ${String(change.lines)} lines)`;

  if (change.op === 'program') return `(${PROGRAM_CHANGES[change.change]})`;

  return `${quoted(change.from, '-')}\n${quoted(change.to, '+')}`;
}

function changesText(work: RewoundWork): string {
  let budget = CHANGES_MAX_CHARS;
  const blocks: string[] = [];

  for (const [path, changes] of work.files) {
    const body = changes.map(changeText).join('\n');
    const block = body.length <= budget ? `${path}\n${body}` : `${path} (changes not shown: read it)`;

    budget = Math.max(0, budget - body.length);
    blocks.push(block);
  }

  return blocks.join('\n\n');
}

/** What the rewound turns ran: commands by name, with the machine a program ran each on, and programs by count. */
function ranText(work: RewoundWork): string {
  const { ran, failed, operations, unrecorded, untold } = work.programs;

  if (work.commands.length === 0 && ran === 0) return 'Your rewound turns ran no shell commands and no programs.';

  const commands = work.commands.length === 0
    ? []
    : ['Commands your rewound turns ran:', ...work.commands.map((run) => `- ${run.command}${run.machine === undefined ? '' : ` (on ${run.machine}, from a program)`}${run.exitCode === null ? '' : ` (exit ${String(run.exitCode)})`}`)];

  const changed = [...operations].map(([name, count]) => `${name}${count === 1 ? '' : ` x${String(count)}`}`);

  const programs = ran === 0
    ? []
    : [
      `Programs (eval) your rewound turns ran: ${String(ran)}${failed === 0 ? '' : `, ${String(failed)} of them failed`}. `
        + 'Their file writes and commands are listed above; what they sent over the network, and files their commands wrote, are not.',
      ...(changed.length === 0 ? [] : [`What else they changed: ${changed.join(', ')}.`]),
      ...(untold === 0 ? [] : [`${String(untold)} more of their calls are not listed: they may have changed something.`]),
      ...(unrecorded === 0 ? [] : [`${String(unrecorded)} of them left no record of what they did: read what they touched.`]),
    ];

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

/** The notice owed, or null when it would say nothing: the rewound turns did nothing, and no computer was read. */
export function rewindNotice(work: RewoundWork, computer: RewindComputer | undefined): string | null {
  const files = [...work.files.keys()];

  if (computer === undefined && files.length === 0 && work.commands.length === 0 && work.programs.ran === 0) return null;

  return [
    'The person rewound this conversation to before one of its messages. Your turns after it are gone from the chat, '
      + 'but what they did stands. Read a file again before you rely on what you remember of it.',
    files.length === 0 ? 'Files your rewound turns changed: none.' : `Files your rewound turns changed:\n\n${changesText(work)}`,
    ranText(work),
    ...(computer === undefined ? [] : [computerText(computer).join('\n')]),
  ].join('\n\n');
}
