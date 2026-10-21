/**
 * What a program did, as the host saw it do it (WEB-3, REWIND-0924): the files it changed through the file plane, the
 * commands it ran with how each exited, and the other operations it called that change something, each by its declared
 * impact. Recorded at the executors' own seams (`file-operations.ts` writes, `commandAnswer`) while its member call runs,
 * and written by the host into the program's envelope, bound to its call's id: a program cannot know that id, so no
 * value it returns or throws can claim an effect for it. Not traced yet: a command's own file writes (no plane
 * attributes them to the command; it is listed as a command, as the shell tool's are) and a program's own network
 * requests (its `fetch` reaches the egress, which no program owns). So no record certifies a program changed nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as v from 'valibot';
import type { Impact } from '@agent-core/core/facets';
import { declaredImpact, NATIVE_ACTION_EFFECTS } from '../slates/members';
import { ImageCarrierSchema } from '../types/tool-images';
import { JsonObjectSchema, safeJsonParse, type JsonObject, type JsonValue } from '../utils/json';
import { oneLineClip } from '../utils/text';

/** The most of each a record carries; past them it counts the rest, so a program that writes thousands stays one line. */
const FILES_MAX = 50;

const COMMANDS_MAX = 20;

const COMMAND_CHARS = 200;

const PATH_CHARS = 300;

/** The most a record takes of its answer's room, an eighth of a program's default bound (`tools/clamp.ts`). */
const RECORD_CHARS = 1_000;

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
  /** Each command that ran; one refused before running is none. */
  commands: v.optional(v.array(v.object({ machine: v.string(), command: v.string(), exitCode: v.number() })), []),
  /** Other operations that change something, by `namespace.member`, with how many times each ran. */
  operations: v.optional(v.record(v.string(), v.number()), {}),
  /** Calls whose impact no declaration says: they may have changed something. */
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
    const named = oneLineClip(path, PATH_CHARS);

    if (!this.files.has(named) && this.files.size >= FILES_MAX) {
      this.more += 1;

      return;
    }

    // A file the program made, then edited, it made.
    this.files.set(named, this.files.get(named) === 'created' ? 'created' : change);
  }

  command(machine: string, command: string, exitCode: number): void {
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

  /**
   * The record for call `call`, each list only where it holds something, within `RECORD_CHARS`: past it, commands go
   * first, then files and operations past their first, each counted in `more`, so a change is never what is dropped.
   */
  record(call: string): ProgramEffectsRecord {
    const files = [...this.files].map(([path, change]) => ({ path, change }));
    const commands = [...this.commands];
    const operations = [...this.operations];
    let more = this.more;

    const built = (): ProgramEffectsRecord => ({
      call,
      ...(files.length > 0 && { files }),
      ...(commands.length > 0 && { commands }),
      ...(operations.length > 0 && { operations: Object.fromEntries(operations) }),
      ...(this.unclassified > 0 && { unclassified: this.unclassified }),
      ...(more > 0 && { more }),
    });

    for (const list of [commands, files, operations]) {
      const keep = list === commands ? 0 : 1;

      while (list.length > keep && JSON.stringify(built()).length > RECORD_CHARS) {
        list.pop();
        more += 1;
      }
    }

    return built();
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

/** A command a machine ran for the running member call, with its exit code: only one that ran, a refused one never did. */
export function noteCommand(machine: string, command: string, exitCode: number): void {
  const scope = member.getStore();

  if (scope === undefined) return;
  scope.recorded = true;
  scope.log.command(machine, command, exitCode);
}

/** A member call as its program made it: where, the operation its input names where it is a native tool's, and what
 *  the operation it serves declares, where it serves one. */
export interface MemberCall {
  readonly namespace: string;
  readonly member: string;
  readonly op: string | null;
  readonly impact: Impact | null;
}

/** Each member's declared impact, by the namespace and member a program calls it as; null where it serves no operation. */
export type MemberImpacts = (namespace: string, member: string) => Impact | null;

/**
 * Whether a call changes anything, by its declaration: false for one that only observes or computes, null unknown. A
 * native tool's operation says it per call; any other member, the operation it serves; one serving none, the catalog.
 */
function changes(address: MemberCall): boolean | null {
  const ops: Readonly<Record<string, 'read' | 'mutate'>> | undefined = address.namespace === NATIVE_NAMESPACE
    ? Object.entries(NATIVE_ACTION_EFFECTS).find(([name]) => name === address.member)?.[1]
    : undefined;

  const effect = ops !== undefined && address.op !== null && Object.hasOwn(ops, address.op) ? ops[address.op] : undefined;

  if (effect !== undefined) return effect === 'mutate';

  // A model call computes; it changes nothing it is not then told to.
  if (address.namespace === 'ai') return false;
  const impact: Impact | null = address.impact ?? declaredImpact(address);

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

const TextPartSchema = v.object({ type: v.literal('text'), text: v.string() });

/**
 * The host envelopes an answer holds, however it is kept: as the program answered, as its JSON text, as an image
 * result's carrier, or as the content parts the model was sent (a carrier's text and its images). Only an envelope's
 * own top level is read: never the program's result inside it.
 */
function envelopes(output: JsonValue | undefined): JsonObject[] {
  if (v.is(v.string(), output)) {
    const parsed = safeJsonParse(output);

    return v.is(v.string(), parsed) ? [] : envelopes(parsed);
  }

  if (Array.isArray(output)) return output.flatMap((part) => (v.is(TextPartSchema, part) ? envelopes(part.text) : []));
  const object = v.safeParse(JsonObjectSchema, output);

  if (!object.success) return [];
  const carrier = v.safeParse(ImageCarrierSchema, object.output);

  return carrier.success ? [object.output, ...envelopes(carrier.output.output)] : [object.output];
}

/**
 * A program's effects as its call's answer carries them, settled or failed, live or stored. Trusted only when the
 * record names this call.
 */
export function programEffectsOf(toolCallId: string, output: JsonValue | undefined): ProgramEffects | null {
  for (const envelope of envelopes(output)) {
    const record = v.safeParse(ProgramEffectsSchema, envelope['effects']);

    if (record.success && record.output.call === toolCallId) return record.output;
  }

  return null;
}

/**
 * What a program did, as its chip says it: it changed something, or what it did is not known. Never that it changed
 * nothing: its own network requests are not traced.
 */
export function programEffect(effects: ProgramEffects): 'mutate' | 'unknown' {
  return effects.files.length > 0 || Object.keys(effects.operations).length > 0 ? 'mutate' : 'unknown';
}
