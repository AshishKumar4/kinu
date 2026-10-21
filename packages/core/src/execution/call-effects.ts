/**
 * What a program did, as the host saw it do it (WEB-3, REWIND-0924): the files it changed through the file plane, the
 * commands it ran with how each exited, and the other operations it called that change something, each by its declared
 * impact. Recorded at the executors' own seams (`file-operations.ts` writes, `commandAnswer`) while its member call runs,
 * and written by the host into the program's envelope, bound to its call's id: a program cannot know that id, so no
 * value it returns or throws can claim an effect for it. A command's own file writes are not traced, no plane attributes
 * them to the command yet; it is listed as a command, as the shell tool's are.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as v from 'valibot';
import type { Impact } from '@agent-core/core/facets';
import { declaredImpact, NATIVE_ACTION_EFFECTS } from '../slates/members';
import { JsonObjectSchema, safeJsonParse, type JsonValue } from '../utils/json';
import { oneLineClip } from '../utils/text';

/** The most of each a record carries; past them it counts the rest, so a program that writes thousands stays one line. */
const FILES_MAX = 50;

const COMMANDS_MAX = 20;

const COMMAND_CHARS = 200;

const OPERATIONS_MAX = 20;

/** The namespace native tools are under in a program, each named by its tool. */
const NATIVE_NAMESPACE = 'tools';

const FileChangeSchema = v.picklist(['created', 'replaced', 'edited']);

/** A program's record; one that changed nothing is its call's id alone, so a call with no record is one never recorded. */
const ProgramEffectsSchema = v.object({
  /** The id of the call the record was made for. */
  call: v.string(),
  /** Each file by the name the program gave it, as the file tool's own calls name theirs. */
  files: v.optional(v.array(v.object({ path: v.string(), change: FileChangeSchema })), []),
  commands: v.optional(v.array(v.object({ machine: v.string(), command: v.string(), exitCode: v.nullable(v.number()) })), []),
  /** Other operations that change something, by `namespace.member`, with how many times each ran. */
  operations: v.optional(v.record(v.string(), v.number()), {}),
  /** Calls whose impact the catalog does not declare: they may have changed something. */
  unclassified: v.optional(v.number()),
  /** Files, commands and operations past the record's bounds. */
  more: v.optional(v.number()),
});

export type ProgramEffects = v.InferOutput<typeof ProgramEffectsSchema>;

/** A record as the host writes it: each list only where it holds something. */
export type ProgramEffectsRecord = v.InferInput<typeof ProgramEffectsSchema>;

/** One program's effects as its calls land, in the order they landed. */
export class EffectLog {
  private readonly files = new Map<string, v.InferOutput<typeof FileChangeSchema>>();
  private readonly commands: ProgramEffects['commands'][number][] = [];
  private readonly operations = new Map<string, number>();
  private unclassified = 0;
  private more = 0;

  file(path: string, change: v.InferOutput<typeof FileChangeSchema>): void {
    const was = this.files.get(path);

    if (was === undefined && this.files.size >= FILES_MAX) {
      this.more += 1;

      return;
    }

    // A file the program made, then edited, it made.
    this.files.set(path, was === 'created' ? 'created' : change);
  }

  command(machine: string, command: string, exitCode: number | null): void {
    if (this.commands.length >= COMMANDS_MAX) {
      this.more += 1;

      return;
    }

    this.commands.push({ machine, command: oneLineClip(command, COMMAND_CHARS), exitCode });
  }

  operation(name: string | null): void {
    if (name === null) {
      this.unclassified += 1;

      return;
    }

    if (!this.operations.has(name) && this.operations.size >= OPERATIONS_MAX) {
      this.more += 1;

      return;
    }

    this.operations.set(name, (this.operations.get(name) ?? 0) + 1);
  }

  /** Whether the program did anything that may change something. */
  get changed(): boolean {
    return this.files.size > 0 || this.commands.length > 0 || this.operations.size > 0 || this.unclassified > 0;
  }

  /** The record for call `call`, each list only where it holds something. */
  record(call: string): ProgramEffectsRecord {
    return {
      call,
      ...(this.files.size > 0 && { files: [...this.files].map(([path, change]) => ({ path, change })) }),
      ...(this.commands.length > 0 && { commands: [...this.commands] }),
      ...(this.operations.size > 0 && { operations: Object.fromEntries(this.operations) }),
      ...(this.unclassified > 0 && { unclassified: this.unclassified }),
      ...(this.more > 0 && { more: this.more }),
    };
  }
}

/** One member call's scope: the program's log, and whether a seam recorded what this call did. */
interface MemberScope {
  readonly log: EffectLog;
  recorded: boolean;
}

const member = new AsyncLocalStorage<MemberScope>();

/** A file the file plane wrote for the running member call; nothing outside a program. */
export function noteFileChange(path: string, change: v.InferOutput<typeof FileChangeSchema>): void {
  const scope = member.getStore();

  if (scope === undefined) return;
  scope.recorded = true;
  scope.log.file(path, change);
}

/** A command a machine ran for the running member call, with its exit code; null where it never ran. */
export function noteCommand(machine: string, command: string, exitCode: number | null): void {
  const scope = member.getStore();

  if (scope === undefined) return;
  scope.recorded = true;
  scope.log.command(machine, command, exitCode);
}

/** A member call as its program made it: where, and the operation its input names where it is a native tool's. */
export interface MemberCall {
  readonly namespace: string;
  readonly member: string;
  readonly op: string | null;
}

/** Whether a call changes anything, by its declaration: false for one that only observes or computes, null unknown. */
function changes(address: MemberCall): boolean | null {
  if (address.namespace === NATIVE_NAMESPACE) {
    const ops: Readonly<Record<string, 'read' | 'mutate'>> | undefined = Object.entries(NATIVE_ACTION_EFFECTS).find(([name]) => name === address.member)?.[1];
    const effect = ops !== undefined && address.op !== null && Object.hasOwn(ops, address.op) ? ops[address.op] : undefined;

    return effect === undefined ? null : effect === 'mutate';
  }

  // A model call computes; it changes nothing it is not then told to.
  if (address.namespace === 'ai') return false;
  const impact: Impact | null = declaredImpact(address);

  return impact === null ? null : impact !== 'observe';
}

/**
 * Runs one member call of a program under `log`: what the executors' seams record during it lands there, and a call
 * that changes something by its declaration and recorded nothing itself is counted as an operation. A refused call
 * changed nothing; `succeeded` says which. Outside a program (`log` undefined) it only runs.
 */
export async function withMemberEffects<A>(call: {
  readonly log: EffectLog | undefined;
  readonly address: MemberCall;
  readonly run: () => Promise<A>;
  readonly succeeded: (answer: A) => boolean;
}): Promise<A> {
  const { log, address } = call;

  if (log === undefined) return call.run();
  const scope: MemberScope = { log, recorded: false };
  const answer = await member.run(scope, call.run);

  if (!scope.recorded && call.succeeded(answer)) {
    const changed = changes(address);

    if (changed !== false) log.operation(changed === null ? null : `${address.namespace}.${address.member}`);
  }

  return answer;
}

/**
 * A program's effects as its call's stored output carries them: the envelope's value when it settled, the host's
 * envelope text when it failed. Trusted only when the record names this call.
 */
export function programEffectsOf(toolCallId: string, output: JsonValue | undefined): ProgramEffects | null {
  const envelope = v.safeParse(JsonObjectSchema, v.is(v.string(), output) ? safeJsonParse(output) : output);
  const record = v.safeParse(ProgramEffectsSchema, envelope.success ? envelope.output['effects'] : undefined);

  return record.success && record.output.call === toolCallId ? record.output : null;
}

/** What a program did, as its chip says it: it changed something, it only looked, or it ran what no record traces. */
export function programEffect(effects: ProgramEffects): 'read' | 'mutate' | 'unknown' {
  if (effects.files.length > 0 || Object.keys(effects.operations).length > 0) return 'mutate';

  return effects.commands.length > 0 || (effects.unclassified ?? 0) > 0 ? 'unknown' : 'read';
}
