import * as v from 'valibot';
import { sha256Hex } from '../safety/argument-digest';
import {
  ShellExecOptionsSchema, type OutputSink, type Shell, type ShellCallJob, type ShellExecOptions, type ShellExecResult,
} from '../types/primitives';
import { shellQuote } from '../utils/shell';

/** A shell call's options, or a provider exec's context: a bare string is stdin; keys of neither are dropped. */
export function shellExecOptions(input: { value: unknown }): ShellExecOptions {
  const text = v.safeParse(v.string(), input.value);

  if (text.success) return { stdin: text.output };
  const options = v.safeParse(ShellExecOptionsSchema, input.value);

  return options.success ? options.output ?? {} : {};
}

const ReportsCwdSchema = v.object({ reportCwd: v.literal(true) });

/** The shell tool's call, answered as the model reads it (`commandResultAt`); a program's reads `commandResult`. */
export function reportsCwd(input: { context: unknown }): boolean {
  return v.is(ReportsCwdSchema, input.context);
}

export function callJob({ job, detached }: ShellExecOptions): ShellCallJob | undefined {
  return job === undefined || detached === undefined ? undefined : { id: job, detached };
}

/** A name a detached job holds: the call did not run, and says by what. */
export function busyShell(message: string): ShellExecResult {
  return { stdout: '', stderr: message, exitCode: 1, refusal: { reason: 'unavailable', error: message } };
}

/** Where a machine starts a command, and keeps one agent's named shells: `~` is the machine's home. */
export interface MachineShellPlace {
  /** Where a call without a `cwd` starts, as the result names it. */
  readonly home: string;
  /** Keys a name's state with it, so two agents' names never meet. */
  readonly scope: string;
  readonly stateDirectory: string;
}

/** An agent's named shells on a machine whose executor knows where the machine starts. */
export type MachineShells = Omit<MachineShellPlace, 'home'>;

const TRAILER = '\n\u001eKINUCWD\u0000';

const TRAILER_BYTES = new TextEncoder().encode(TRAILER);

/**
 * A named call: restores the name's directory and exported variables from `$4/$2.bash`, starts in `$3` when given, and
 * saves both there (mode 0600) as it exits, `exit 3` included, with a private trailer on stdout saying where it
 * started and ended.
 */
const WRAPPER = `
__kinu_dir=$4
__kinu_file="\${__kinu_dir/#\\~/$HOME}/$2.bash"
if [[ -f "$__kinu_file" ]]; then
  while IFS= read -r __kinu_key; do unset "$__kinu_key"; done < <(compgen -e)
  source "$__kinu_file"
fi
if [[ -n "$3" ]]; then cd -- "$3" || exit; fi
__kinu_start=$PWD
exec 3>&1
__kinu_save() {
  local __kinu_status=$?
  umask 077
  mkdir -p -- "\${__kinu_file%/*}"
  { printf '# cwd:%s\\n' "$PWD"; printf 'cd -- %q\\n' "$PWD"; export -p; } > "$__kinu_file"
  chmod 600 -- "$__kinu_file"
  printf '\\n\\036KINUCWD\\0%s\\0%s\\0' "$__kinu_start" "$PWD" >&3
  return "$__kinu_status"
}
trap __kinu_save EXIT
eval "$1"`;

/** The state file's name: hashed, so any name fits a filename. */
function stateKey(place: MachineShellPlace, name: string): string {
  return sha256Hex(`${place.scope}\u0000${name}`);
}

/** One call through the machine wrapper: the command to send instead, its live output's view, and its settle. */
export interface MachineShellCall {
  readonly command: string;
  output(sink: OutputSink): OutputSink;
  /** The trailer cut from stdout into where the command started and, for a name, where it ended. */
  settle<R extends { readonly stdout: string }>(result: R): R & { cwd?: string; finalCwd?: string };
}

/**
 * An unnamed call is the command itself, behind a `cd` when it has a `cwd`; it keeps nothing, so it needs no wrapper.
 * A named one runs through the wrapper.
 */
export function machineShellCall(command: string, call: Pick<ShellExecOptions, 'cwd' | 'name'>, place: MachineShellPlace): MachineShellCall {
  if (call.name === undefined && call.cwd === undefined) {
    return { command, output: (sink) => sink, settle: (result) => ({ ...result, cwd: place.home }) };
  }

  if (call.name === undefined) {
    const cwd = call.cwd ?? '';
    const start = cwd.startsWith('/') ? cwd : `${place.home}/${cwd}`;

    return {
      command: `cd -- ${shellQuote(cwd)} || exit\n${command}`,
      output: (sink) => sink,
      settle: (result) => ({ ...result, cwd: start }),
    };
  }

  const key = stateKey(place, call.name);

  return {
    command: `bash -c ${shellQuote(WRAPPER)} kinu ${shellQuote(command)} ${shellQuote(key)} ${shellQuote(call.cwd ?? '')} ${shellQuote(place.stateDirectory)}`,
    output: withoutTrailer,
    settle(result) {
      const at = result.stdout.lastIndexOf(TRAILER);

      if (at === -1) return result;
      const [start = '', final = ''] = result.stdout.slice(at + TRAILER.length).split('\u0000');
      const settled: typeof result & { cwd?: string; finalCwd?: string } = { ...result, stdout: result.stdout.slice(0, at) };

      if (start !== '') settled.cwd = start;

      if (final !== '') settled.finalCwd = final;

      return settled;
    },
  };
}

/** A named shell's saved directory on the machine; null when it has none yet or it is unreadable. */
async function machineShellCwd(raw: Shell, name: string, place: MachineShellPlace): Promise<string | null> {
  const read = `f="\${2/#\\~/$HOME}/$1.bash"; if [[ -f "$f" ]]; then IFS= read -r line < "$f"; printf '%s' "\${line#\\# cwd:}"; fi`;
  const result = await raw.exec(`bash -c ${shellQuote(read)} kinu ${shellQuote(stateKey(place, name))} ${shellQuote(place.stateDirectory)}`);

  return result.refusal === undefined && result.exitCode === 0 && result.stdout.startsWith('/') ? result.stdout : null;
}

/** Every call of a machine whose own shell keeps nothing (a host's `sh -c`) through the wrapper. */
export function createBashShell(raw: Shell, place: MachineShellPlace): Shell {
  return {
    cwd: (name) => machineShellCwd(raw, name, place),
    async exec(command, stdinOrOptions) {
      // The wrapper owns the directory and the name; the machine runs it where it starts every command.
      const { cwd, name, ...rest } = shellExecOptions({ value: stdinOrOptions });
      const call = machineShellCall(command, { ...(cwd !== undefined && { cwd }), ...(name !== undefined && { name }) }, place);
      const output = rest.output;

      return call.settle(await raw.exec(call.command, output === undefined ? rest : { ...rest, output: call.output(output) }));
    },
  };
}

function trailerAt(bytes: Uint8Array): number {
  search: for (let start = 0; start + TRAILER_BYTES.length <= bytes.length; start++) {
    for (let index = 0; index < TRAILER_BYTES.length; index++) if (bytes[start + index] !== TRAILER_BYTES[index]) continue search;

    return start;
  }

  return -1;
}

/** The longest tail of `bytes` that begins the trailer: held back until the next chunk says whether it is one. */
function trailerPrefix(bytes: Uint8Array): number {
  for (let length = Math.min(bytes.length, TRAILER_BYTES.length - 1); length > 0; length--) {
    if (bytes.subarray(bytes.length - length).every((byte, index) => byte === TRAILER_BYTES[index])) return length;
  }

  return 0;
}

/** A live view of a wrapped call's output: stdout ends where the trailer starts. */
function withoutTrailer(sink: OutputSink): OutputSink {
  let held = new Uint8Array(0);
  let ended = false;

  return {
    lost: (bytes) => { sink.lost(bytes); },
    write(stream, data) {
      if (stream !== 'stdout') {
        sink.write(stream, data);

        return;
      }

      if (ended) return;
      const chunk = v.is(v.string(), data) ? new TextEncoder().encode(data) : data;
      const bytes = new Uint8Array(held.length + chunk.length);

      bytes.set(held);
      bytes.set(chunk, held.length);
      const at = trailerAt(bytes);

      if (at !== -1) {
        ended = true;

        if (at > 0) sink.write(stream, bytes.subarray(0, at));

        return;
      }

      const keep = trailerPrefix(bytes);
      held = bytes.slice(bytes.length - keep);

      if (bytes.length > keep) sink.write(stream, bytes.subarray(0, bytes.length - keep));
    },
  };
}
