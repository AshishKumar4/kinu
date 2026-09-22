/**
 * The one command an agent may not run: the one that ends the process running
 * the turn.
 *
 * WHY THIS IS NOT AN APPROVAL RULE. The approval table already decides what a
 * shell may do, and it decides this one wrong by construction.
 * `AGENT_OWN_EXECUTORS` (safety/approval-gate.ts) ungates every `harm: 'local'`
 * rule on `workspace` and `sandbox`, on the sound argument that a wiped scratch
 * workspace is a re-clone; `workspace.exec` is additionally exempt from
 * `gateProviderExec` (docs/EXECUTION-LAYER-SPEC.md). Both statements are about
 * DAMAGE TO STATE, and both are right about it. Neither contemplates the
 * process hosting the current turn, whose continuity is not the agent's to
 * spend: a turn that kills its own host loses the work in flight, re-enters
 * through fiber recovery, and — if the model believes the command was the right
 * one — issues it again.
 *
 * So the refusal belongs at the seam that knows the answer, which is the one
 * holding the host's own pid. A rule ABOUT the host cannot live in a table that
 * has never heard of it, and the alternative — a new harm class meaning "lands
 * on the turn itself" — would put a third word in a two-word vocabulary for one
 * rule, on a gate the owner can grant away anyway.
 *
 * WHAT THIS IS NOT. Not a security boundary. A shell that runs `sh -c` can
 * reach the same syscall through a variable, a base64 decode, or a script it
 * just wrote, and nothing short of dropping the capability stops that. What it
 * refuses is the FORM an agent actually writes when it decides to restart
 * itself — which is the failure being closed, because the agent is not an
 * adversary here, it is a caller that does not know it is standing on the
 * branch.
 */

import { KinuError, refusalOf } from '../obs/error';
import type { Shell, ShellExecResult } from '../types/primitives';

/** What a process hosting a turn knows about itself. Supplied by the adapter
 *  that IS that process (the CLI backend's host shell); a workspace whose shell
 *  runs somewhere else has no host to protect and installs none of this. */
export interface HostProcessIdentity {
  /** The OS process id of the process running this turn. */
  readonly pid: number;
  /** The names this host answers to on this machine: its binary, its service
   *  unit. Empty is legal and leaves only the pid protected — a host that
   *  cannot name itself must not guess, because a guessed name refuses somebody
   *  else's process. */
  readonly names: readonly string[];
}

/** Commands that send a signal by pid or by pattern. */
const SIGNAL_SENDERS = /\b(kill|pkill|killall)\b/;

/** `pkill`/`killall` arguments are patterns, so a name matches a process whose
 *  command line merely CONTAINS it. Anchored on token boundaries for the same
 *  reason the approval table anchors: `kinugram` is not `kinu`. */
const nameTargeted = (command: string, name: string): boolean =>
  new RegExp(`(?:pkill|killall)\\b[^;|&]*(?<![\\w.-])${name}(?![\\w.-])`).test(command);

/** A service manager asked to stop, restart or kill a unit. `systemctl`,
 *  SysV `service`, `pm2`, `supervisorctl` and launchd's `bootout`/`kickstart`
 *  are the five ways a host process is cycled on the machines this runs on. */
const serviceCycled = (command: string, name: string): boolean =>
  new RegExp(
    `\\b(?:systemctl|service|pm2|supervisorctl|launchctl)\\b[^;|&]*\\b`
    + `(?:stop|restart|reload|kill|disable|bootout|kickstart|delete)\\b[^;|&]*`
    + `(?<![\\w.-])${name}(?![\\w.-])`,
  ).test(command)
  || new RegExp(
    `\\b(?:systemctl|service|pm2|supervisorctl)\\b[^;|&]*(?<![\\w.-])${name}(?![\\w.-])`
    + `[^;|&]*\\b(?:stop|restart|reload|kill|disable|delete)\\b`,
  ).test(command);

/** Signals aimed at every process the caller owns: `-1` as a pid means "all",
 *  and `pkill -u`/`killall5` say the same thing in words. The host is in that
 *  set however it is named. */
const KILLS_EVERYTHING = /\b(?:kill\s+(?:-\S+\s+)*--?\s*1\b|pkill\b[^;|&]*\s-u\b|killall5\b)/;

/** Powering the machine off or cycling it. The host dies with it, and a turn
 *  cannot survive its own kernel. */
const POWER_CYCLE =
  /(?:^|[;|&]\s*)(?:sudo\s+)?(?:\S*\/)?(?:reboot|shutdown|poweroff|halt)\b|\bsystemctl\b[^;|&]*\b(?:reboot|poweroff|halt|suspend|hibernate)\b|\binit\s+[06]\b/;

/**
 * Why this command would end the turn, or null when it would not.
 *
 * Read as five named forms rather than one pattern, because the refusal has to
 * say WHICH one fired: an agent told only "denied" writes the same command
 * again in a different spelling, and an owner reading the ledger cannot tell a
 * self-kill from a typo.
 */
export function selfTargetedCommand(command: string, host: HostProcessIdentity): string | null {
  const pid = String(host.pid);

  if (SIGNAL_SENDERS.test(command) && new RegExp(`(?<![\\w.-])-?${pid}(?![\\w.-])`).test(command)) {
    return `it signals process ${pid}, which is the process running this turn`;
  }

  for (const name of host.names) {
    if (nameTargeted(command, name)) return `it kills processes matching "${name}", which is the process running this turn`;

    if (serviceCycled(command, name)) return `it cycles the service "${name}", which is the process running this turn`;
  }

  if (KILLS_EVERYTHING.test(command)) return 'it signals every process this user owns, including the one running this turn';

  if (POWER_CYCLE.test(command)) return 'it powers the machine down, and the turn goes with it';

  return null;
}

/** The refused command's result. Shaped exactly as the approval gate shapes
 *  one — exit 1, the reason on stderr for a reader of the process fields, the
 *  classification in `refusal` for a reader of the ledger — so a refusal reads
 *  the same whichever seam produced it. */
function refuseSelfTargeted(reason: string): ShellExecResult {
  const error = new KinuError('denied',
    `This command was not run: ${reason}. Killing the process that is running this turn `
    + 'loses the work in flight and settles nothing — ask the owner to restart it, or do '
    + 'the work that does not require the restart.');

  return { stdout: '', stderr: error.message, exitCode: 1, refusal: refusalOf(error) };
}

/**
 * Wrap a shell that runs ON the host process, so a command that would kill or
 * restart that process is refused instead of executed.
 *
 * Applied by the adapter that owns the process, outside every other wrapper:
 * the decision needs no approval channel (it is not the owner's to grant — the
 * turn is already running) and no checkpoint (nothing is about to change on
 * disk), so asking for either first would spend work on a command that is not
 * going to run.
 */
export function withSelfPreservingShell(shell: Shell, host: HostProcessIdentity): Shell {
  return {
    exec: (command, stdinOrOptions) => {
      const reason = selfTargetedCommand(command, host);

      return reason === null
        ? shell.exec(command, stdinOrOptions)
        : Promise.resolve(refuseSelfTargeted(reason));
    },
  };
}
