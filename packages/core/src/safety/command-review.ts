/**
 * 'allow', 'warn', 'gate' (the owner decides) or 'deny', by rule and whose files. Against accidents, not an adversary.
 * A rule judges the commands the line runs as the shell reads them (`shell-reading.ts`), and its signature judges the
 * line's text where that reading cannot see what runs (`followed: false`), where a word of one of its programs expands,
 * and always for a deny: a review never weaker than one of the text alone.
 */

import type { ShellCwd, ShellSession } from '../execution/shell-session';
import { machinePath } from '../vfs/resolve';
import { workspacePath } from '../vfs/workspace-path';
import { commandsRun, programOf, readShell, wordRuns, type CommandRun, type ShellCommand, type ShellWord } from './shell-reading';

export type ApprovalDecision = 'allow' | 'warn' | 'gate' | 'deny';

/** Where a rule's harm lands: 'local' (the executing machine only) or 'reaches_out' (leaves the executor). */
type ApprovalHarm = 'local' | 'reaches_out';

/** 'agent': its own disposable state, where local harm is not gated; 'user': anything else. Declared, never read
 *  from a name. */
export type FilesOwner = 'agent' | 'user';

export interface GatedExecutor {
  readonly name: string;
  readonly filesOwner: FilesOwner;
  readonly shellSession?: ShellSession;
}

export interface ApprovalRuleHit {
  readonly decision: ApprovalDecision;
  readonly rule: string;
  readonly explanation: string;
}

export interface ApprovalResult {
  readonly decision: ApprovalDecision;
  /** Rules that fired, with their decision on this executor. */
  readonly hits: readonly ApprovalRuleHit[];
}

interface Rule {
  decision: ApprovalDecision;
  name: string;
  why: string;
  harm: ApprovalHarm;
  /** The rule over the commands the line runs; absent for one that is its signature wherever it appears. */
  fires?: (runs: readonly CommandRun[]) => boolean;
  /** The act in the line's text, read where the shell's reading does not see what runs. */
  signature: RegExp;
  /** The programs whose expanding words leave the rule to its signature too. */
  binaries?: readonly string[];
}

/** A rule over the commands the line runs. */
const running = (test: (run: CommandRun) => boolean) => (runs: readonly CommandRun[]): boolean => runs.some(test);

/** A command's arguments, read as getopt reads them: short flags, long option names, and the operands. */
interface Arguments {
  readonly short: ReadonlySet<string>;
  readonly long: ReadonlySet<string>;
  readonly operands: readonly ShellWord[];
}

function argumentsOf(words: readonly ShellWord[]): Arguments {
  const short = new Set<string>();
  const long = new Set<string>();
  const operands: ShellWord[] = [];
  let ended = false;

  // A flag's name is read as written: an expansion in its value, or past its letters, does not unmake the flag.
  for (const word of words) {
    const flag = word.text;

    if (ended || !flag.startsWith('-') || flag === '-') operands.push(word);
    else if (flag === '--') ended = true;
    else if (flag.startsWith('--')) long.add(flag.slice(2).split('=')[0] ?? '');
    else for (const ch of flag.slice(1)) short.add(ch);
  }

  return { short, long, operands };
}

const argumentsAfter = (command: ShellCommand): Arguments => argumentsOf(command.words.slice(1));

const literals = (words: readonly ShellWord[]): string[] => words.flatMap((word) => (word.literal === null ? [] : [word.literal]));

/** git's global options that take the next word as their value (git.c). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** A `git` command's subcommand and the words after it, past any number of global options. */
function gitSubcommand(command: ShellCommand): { readonly name: string; readonly words: readonly ShellWord[] } | null {
  if (programOf(command) !== 'git') return null;

  for (let at = 1; at < command.words.length; at++) {
    const word = command.words[at]?.literal ?? null;

    if (word === null) return null;

    if (!word.startsWith('-')) return { name: word, words: command.words.slice(at + 1) };

    if (GIT_VALUE_OPTIONS.has(word)) at++;
  }

  return null;
}

const gitRunning = (name: string, test: (words: readonly ShellWord[]) => boolean) => running(({ command }) => {
  const sub = gitSubcommand(command);

  return sub !== null && sub.name === name && test(sub.words);
});

const recursive = ({ short, long }: Arguments): boolean => short.has('r') || short.has('R') || long.has('recursive');

const forced = ({ short, long }: Arguments): boolean => short.has('f') || long.has('force');

const is = (command: ShellCommand, ...programs: string[]): boolean => programs.includes(programOf(command) ?? '');

/** `/`, however many slashes, and its every entry by glob: what a recursive delete of it destroys. */
const ROOT_TARGET = /^\/+(?:\*|\.)?$/u;

const SECRET_PATH = /(\.env|\.npmrc|\.pypirc|\.aws|\.ssh|credentials)/i;

/** Long options taking the next word as a value (git.c). */
const GIT_VALUE_OPTION = '(?:git-dir|work-tree|namespace|config-env|super-prefix)';

/** `git` and its global options, in a signature; each word reads one way, so a failed match stays linear. */
const GIT = String.raw`\bgit(?:\s+(?:(?:-[Cc]|--${GIT_VALUE_OPTION})\s+\S+|-[pP]|--(?!${GIT_VALUE_OPTION}(?:\s|$))[\w-]+(?:=\S+)?))*\s+`;

/** Every ecosystem's publish command, in a signature. */
const PACKAGE_PUBLISH = new RegExp(
  [
    /\b(?:npm|pnpm|yarn|bun|cargo|poetry|uv|flit|hatch)\s+publish\b/,
    /\btwine\s+upload\b/,
    /\bgem\s+push\b/,
    /\bmvn\s+deploy\b|\bgradlew?\s+[^&|;]*\bpublish[A-Za-z]*/,
    /\bdotnet\s+nuget\s+push\b/,
  ]
    .map((r) => r.source)
    .join('|'),
);

const SECRET_READ = { name: 'secret-file-read', why: 'Reads a file likely to contain secrets.' } as const;

/** A mode that sets the setuid or setgid bit: symbolic `+s` or `=…s`, or four octal digits led by 2 to 7. */
const SETUID_MODE = /^(?:[ugoa]*[+=][rwxXt]*s[rwxXt]*|[2-7][0-7]{3})$/u;

const DOWNLOADERS = ['curl', 'wget'];

/** A shell stage that reads what a download earlier in its pipeline writes. */
const pipedFromDownload = (shells: readonly string[]) => running(({ command, stage, stages }) =>
  is(command, ...shells) && DOWNLOADERS.some((downloader) => (stages.get(downloader)?.first ?? stage) < stage));

const PUBLISHERS = [
  'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'uv', 'flit', 'hatch', 'twine', 'gem', 'mvn', 'gradle', 'gradlew', 'dotnet', 'python', 'python3',
];

/** A registry publish, per ecosystem: each tool's subcommand, its first operand past its options. */
function publishes(command: ShellCommand): boolean {
  const words = literals(command.words.slice(1));
  const [sub, next] = literals(argumentsAfter(command).operands);
  const program = programOf(command) ?? '';

  if (program === 'yarn' && sub === 'npm') return next === 'publish';

  if (['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'uv', 'flit', 'hatch'].includes(program)) return sub === 'publish';

  if (program === 'twine') return sub === 'upload';

  if (program === 'gem') return sub === 'push';

  if (program === 'mvn') return words.includes('deploy');

  if (program === 'gradle' || program === 'gradlew') return words.some((word) => word.split(':').some((task) => task.startsWith('publish')));

  if (program === 'dotnet') return sub === 'nuget' && next === 'push';

  if (program === 'python' || program === 'python3') return words.join(' ').includes('-m twine') && words.includes('upload');

  return false;
}

/** A recursive delete: `-r`, `-R` or `--recursive`, wherever among the flags. */
const deletesRecursively = (command: ShellCommand): boolean => is(command, 'rm') && recursive(argumentsAfter(command));

/** Default rules, resolved by {@link reviewCommand}. `harm: 'local'`: damage stops at the machine. */
const RULES: Rule[] = [
  {
    fires: running(({ command }) => deletesRecursively(command) && argumentsAfter(command).operands.some((word) => ROOT_TARGET.test(word.text))),
    decision: 'deny',
    name: 'rm-rf-root',
    signature: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*(?:\s+(?:--[^\s]+|-[a-zA-Z]+))*\s+\/+(?=\s|$|[;&|])/,
    why: 'Deletes the entire root filesystem.',
    harm: 'local',
  },
  {
    signature: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    decision: 'deny',
    name: 'fork-bomb',
    why: 'Classic shell fork bomb pattern.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => is(command, 'dd')
      && literals(command.words).some((word) => /^if=\/dev\/(?:zero|urandom)$/iu.test(word))
      && literals(command.words).some((word) => /^of=\/dev\/(?:sd[a-z]|nvme)/iu.test(word))),
    decision: 'deny',
    name: 'dd-overwrite-disk',
    signature: /\bdd\b(?=[^;|&\n]*if=\/dev\/(?:zero|urandom)\b)(?=[^;|&\n]*of=\/dev\/(?:sd[a-z]|nvme[^\s;|&]*))/i,
    why: 'Overwrites raw block devices.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => /^mkfs(?:\.[a-z0-9]+)?$/iu.test(programOf(command) ?? '') && literals(command.words).some((word) => /^\/dev\/sd[a-z]/iu.test(word))),
    decision: 'deny',
    name: 'mkfs-physical-disk',
    signature: /\bmkfs(?:\.[a-z0-9]+)?\b[^;|&]*\/dev\/sd[a-z]/i,
    why: 'Reformats a real disk device.',
    harm: 'local',
  },
  {
    fires: pipedFromDownload(['sh', 'dash', 'zsh', 'ksh']),
    decision: 'deny',
    name: 'pipe-to-shell',
    signature: /\b(curl|wget)\s+[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|dash)\b/i,
    why: 'Downloads remote script and pipes directly to shell.',
    harm: 'reaches_out',
  },
  {
    fires: pipedFromDownload(['bash']),
    decision: 'deny',
    name: 'pipe-to-bash',
    signature: /\b(curl|wget)\s+[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?bash\b/i,
    why: 'Downloads remote script and pipes directly to bash.',
    harm: 'reaches_out',
  },

  {
    fires: running(({ command }) => is(command, 'sudo')),
    decision: 'gate',
    name: 'sudo',
    binaries: ['sudo'],
    signature: /\bsudo\b/,
    why: 'Privilege escalation on a machine that is not the agent\'s own.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => is(command, 'su')),
    decision: 'gate',
    name: 'su',
    binaries: ['su'],
    signature: /\bsu(?:\s+-|\s+\S|\s*$)/,
    why: 'User switching.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => is(command, 'chmod') && literals(command.words.slice(1)).some((word) => word.split(',').some((mode) => SETUID_MODE.test(mode)))),
    decision: 'gate',
    name: 'chmod-setuid',
    binaries: ['chmod'],
    signature: /\bchmod\s+(?:[ugoa]*\+s|\+s|4\d\d\d?|7\d\d\d?|2\d{3}|3\d{3}|5\d{3}|6\d{3})/,
    why: 'Sets setuid/setgid bits.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => is(command, 'chown', 'chgrp') && /^(?:root|0)(?:[:.]|$)/iu.test(argumentsAfter(command).operands[0]?.text ?? '')),
    decision: 'gate',
    name: 'chown-root',
    binaries: ['chown', 'chgrp'],
    signature: /\b(chown|chgrp)\s+(?:-[^\s]+\s+)*(root|0)\b/i,
    why: 'Reassigns ownership to root.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => deletesRecursively(command)),
    decision: 'gate',
    name: 'rm-recursive',
    binaries: ['rm'],
    signature: /\brm\s+-[a-zA-Z]*r/i,
    why: 'Recursive delete.',
    harm: 'local',
  },
  {
    fires: gitRunning('reset', (words) => literals(words).includes('--hard')),
    decision: 'gate',
    name: 'git-reset-hard',
    binaries: ['git'],
    signature: new RegExp(`${GIT}reset\\s+--hard`),
    why: 'Discards local changes irreversibly.',
    harm: 'local',
  },
  {
    fires: (runs) => gitRunning('checkout', (words) => literals(words).some((word) => word === '--' || word === '.'))(runs)
      || gitRunning('restore', (words) => {
        const { short, long } = argumentsOf(words);

        return !(short.has('S') || long.has('staged')) || short.has('W') || long.has('worktree');
      })(runs),
    decision: 'gate',
    name: 'git-discard-changes',
    binaries: ['git'],
    signature: new RegExp(`${GIT}checkout(?:\\s+\\S+)*\\s+(?:--|\\.)(?:\\s|$)|${GIT}restore\\b(?:(?![^;|&\\n]*--staged)|[^;|&\\n]*--worktree)`),
    why: 'Discards uncommitted changes to tracked files.',
    harm: 'local',
  },
  {
    fires: gitRunning('clean', (words) => forced(argumentsOf(words))),
    decision: 'gate',
    name: 'git-clean',
    binaries: ['git'],
    signature: new RegExp(`${GIT}clean\\b[^;|&\\n]*\\s(?:-[a-zA-Z]*f|--force)`),
    why: 'Deletes untracked files.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => is(command, 'find') && literals(command.words).includes('-delete')),
    decision: 'gate',
    name: 'find-delete',
    binaries: ['find'],
    signature: /\bfind\b[^;|&\n]*\s-delete\b/,
    why: 'Deletes every file the search matches.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => is(command, 'rsync') && literals(command.words).some((word) => word.startsWith('--del'))),
    decision: 'gate',
    name: 'rsync-delete',
    binaries: ['rsync'],
    signature: /\brsync\b[^;|&\n]*\s--del(?:ete[\w-]*)?\b/,
    why: 'Deletes destination files the source lacks.',
    harm: 'local',
  },
  {
    fires: running(({ command }) => {
      const [sub, next] = literals(argumentsAfter(command).operands);

      return is(command, 'docker')
        && ((sub === 'rm' && forced(argumentsAfter(command))) || (sub === 'container' && next === 'rm' && forced(argumentsAfter(command))) || (sub === 'system' && next === 'prune'));
    }),
    decision: 'gate',
    name: 'docker-destructive',
    binaries: ['docker'],
    signature: /\bdocker\s+(rm\s+-f|system\s+prune)/,
    why: 'Docker destructive operation.',
    harm: 'local',
  },
  {
    fires: gitRunning('push', (words) => {
      const pushed = argumentsOf(words);

      return pushed.short.has('f') || [...pushed.long].some((name) => name.startsWith('force')) || pushed.operands.some((word) => word.text.startsWith('+'));
    }),
    decision: 'gate',
    name: 'git-force-push',
    binaries: ['git'],
    signature: new RegExp(`${GIT}push\\b[^;|&]*?(?:\\s--force\\b|\\s-f\\b)`),
    why: 'Force-push rewrites history on a remote nobody here owns.',
    harm: 'reaches_out',
  },
  {
    fires: running(({ command }) => publishes(command)),
    decision: 'gate',
    name: 'package-publish',
    binaries: PUBLISHERS,
    signature: PACKAGE_PUBLISH,
    why: 'Publishes to a public package registry.',
    harm: 'reaches_out',
  },

  {
    signature: /\b169\.254\.169\.254\b/,
    decision: 'deny',
    name: 'cloud-metadata-ip',
    why: 'AWS/GCP/Azure cloud-metadata endpoint: common SSRF target.',
    harm: 'reaches_out',
  },
  {
    signature: /\bmetadata\.google\.internal\b/,
    decision: 'deny',
    name: 'gcp-metadata',
    why: 'GCP metadata endpoint.',
    harm: 'reaches_out',
  },

  // Both leak into the transcript, so neither is 'local'.
  {
    // `env` with a command to run is a wrapper, which prints nothing; a dump filtered by `grep` shows what it asked for.
    fires: running(({ command, stage, stages }) => (is(command, 'printenv') || (is(command, 'env') && argumentsAfter(command).operands.every((word) => word.text.includes('='))))
      && !['grep', 'egrep', 'fgrep', 'rg'].some((filter) => (stages.get(filter)?.last ?? stage) > stage)),
    decision: 'warn',
    name: 'env-dump',
    binaries: ['printenv', 'env'],
    signature: /\b(printenv|env)\b(?!\s*\|.*grep)/,
    why: 'Prints environment variables (may leak secrets to LLM output).',
    harm: 'reaches_out',
  },
  {
    fires: running(({ command }) => is(command, 'cat') && argumentsAfter(command).operands.some((word) => SECRET_PATH.test(word.text))),
    decision: 'warn',
    name: SECRET_READ.name,
    binaries: ['cat'],
    signature: new RegExp(String.raw`\bcat\s+.*` + SECRET_PATH.source, 'i'),
    why: SECRET_READ.why,
    harm: 'reaches_out',
  },
];

/** Severity rank for the dominant decision; higher is more severe. */
const SEVERITY = {
  allow: 0,
  warn: 1,
  gate: 2,
  deny: 3,
} satisfies Record<ApprovalDecision, number>;

export function dominant(hits: readonly ApprovalRuleHit[]): ApprovalDecision {
  return hits.reduce<ApprovalDecision>(
    (acc, h) => (SEVERITY[h.decision] > SEVERITY[acc] ? h.decision : acc),
    'allow',
  );
}

/** Every word the shell would take as written, unexpanded, wherever the line holds it. */
export function literalWords(command: string): string[] {
  return (wordRuns(command) ?? []).flatMap(({ words }) => literals(words));
}

/** `~name` is another account's home, which the shell would expand: unknown here. */
export function shellPath(word: string | null, cwd: string, home: string): string | null {
  if (word === null || (word.startsWith('~') && word !== '~' && !word.startsWith('~/'))) return null;

  return machinePath(word, { cwd, home });
}

function underRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** On a user mount, by its first segment or once `..` resolves. */
export function onUserRoots(path: string, roots: readonly string[]): boolean {
  return path.startsWith('/') && (roots.includes(`/${path.split('/')[1] ?? ''}`) || underRoots(workspacePath(path, '/'), roots));
}

/** null: unknown; `undefined`: not a `cd`. */
function cdTarget(run: readonly ShellWord[], cwd: string, home: string): string | null | undefined {
  const [verb, ...args] = run.map((word) => word.literal);

  if (verb === 'popd') return null;

  if (verb !== 'cd' && verb !== 'pushd') return undefined;
  const target = args.find((arg) => arg === null || arg === '-' || !arg.startsWith('-'));

  if (target === undefined) return verb === 'cd' ? home : null;

  return target === '-' ? null : shellPath(target, cwd, home);
}

function namesRoot(command: string, root: string): boolean {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(?<![\\w.~/-])${escaped}(?![\\w.-])`).test(command);
}

/** The user's when the command names or reaches under one of their roots, or its session may be there. */
function commandFilesOwner(executor: GatedExecutor, command: string, session: ShellCwd | undefined): FilesOwner {
  const roots = executor.shellSession?.userRoots() ?? [];

  if (executor.filesOwner === 'user' || roots.length === 0) return executor.filesOwner;

  if (roots.some((root) => namesRoot(command, root))) return 'user';

  if (session === undefined) return 'agent';

  if (session.mayBeUsers || underRoots(session.cwd, roots)) return 'user';
  const runs = wordRuns(command);

  // A line the lexer cannot read is one whose paths are unknown.
  if (runs === null) return 'user';
  // Every directory a relative path may be read from: a `cd` in a substitution, a subshell or a script moves only its
  // own scope, which this reading does not track, so each is kept beside the one before it, which only asks more.
  const cwds = new Set([session.cwd]);

  for (const { words } of runs) {
    for (const cwd of cwds) {
      const reached = words.map(({ literal }) => (literal?.startsWith('-') ? null : shellPath(literal, cwd, session.home)));

      if (reached.some((path) => path !== null && underRoots(path, roots))) return 'user';
    }

    for (const moved of Array.from(cwds, (cwd) => cdTarget(words, cwd, session.home))) if (moved !== undefined && moved !== null) cwds.add(moved);
  }

  return 'agent';
}

/** A `mv` or `cp` destination: `-t`'s, else the last argument. */
function copyTarget(step: ShellCommand): string | null | undefined {
  const [verb, ...args] = step.words.map((word) => word.literal);

  if (verb !== 'mv' && verb !== 'cp') return undefined;
  const flag = args.indexOf('-t');

  if (flag !== -1) return args[flag + 1];
  const long = args.find((arg) => arg?.startsWith('--target-directory=') === true);

  return long === undefined ? args.at(-1) : long?.slice('--target-directory='.length) ?? null;
}

/** Files a `>` or `&>` truncates; `>>` appends. */
function redirectTargets(step: ShellCommand): Array<string | null> {
  return step.redirects.flatMap((redirect) => (redirect.truncates ? [redirect.target.literal] : []));
}

function overwritesUserFiles(executor: GatedExecutor, command: string, session: ShellCwd | undefined, owner: FilesOwner): boolean {
  const roots = executor.shellSession?.userRoots() ?? [];
  const home = session?.home ?? '/';

  if (roots.length === 0) return false;
  const reading = readShell(command);

  // A line whose writes this reading cannot see, that reaches the user's files, may replace one.
  if (reading === null) return owner === 'user';
  // As ownership reads a line: each `cd` kept beside the directory before it.
  const cwds = new Set([session?.cwd ?? '/']);

  for (const step of reading.pipelines.flat()) {
    const targets = [...redirectTargets(step), copyTarget(step)].filter((target): target is string | null => target !== undefined);

    // From a directory that may be the user's, a relative write may land there.
    if (session?.mayBeUsers === true && targets.some((target) => target === null || !/^[/~]/u.test(target))) return true;

    for (const cwd of cwds) {
      if (targets.map((target) => shellPath(target, cwd, home)).some((path) => path !== null && underRoots(path, roots))) return true;
    }

    for (const moved of Array.from(cwds, (cwd) => cdTarget(step.words, cwd, home))) if (moved !== undefined && moved !== null) cwds.add(moved);
  }

  return false;
}

const OVERWRITE: ApprovalRuleHit = {
  decision: 'gate', rule: 'overwrite-user-files', explanation: 'Moves, copies or writes onto the user\'s device or Drive, replacing what is there.',
};

/** The rule table for whose files a command reaches, and any overwrite onto the user's mounts. */
export function reviewShellCommand(executor: GatedExecutor, command: string, session: ShellCwd | undefined): ApprovalResult {
  const owner = commandFilesOwner(executor, command, session);
  const review = reviewCommand(command, owner);

  if (!overwritesUserFiles(executor, command, session, owner)) return review;
  const hits = [...review.hits, OVERWRITE];

  return { decision: dominant(hits), hits };
}

/** Judged by the shell's rules for the same act. */
export interface FileAccess {
  readonly op: 'read' | 'write' | 'delete' | 'mkdir';
  /** As written: what a `cat` rule would see. */
  readonly path: string;
  readonly hostPath: string;
  readonly reaches: 'own' | 'outside-directory' | 'user-mount';
  /** Over a file already there; on a user mount only this and a delete ask. */
  readonly replaces?: boolean;
}

const WRITE_OUTSIDE: ApprovalRuleHit = {
  decision: 'gate', rule: 'write-outside-directory', explanation: 'Changes a file outside the workspace directory.',
};

export function reviewFileAccess(access: FileAccess): ApprovalResult {
  const hits: ApprovalRuleHit[] = [];

  if (access.op === 'read' && SECRET_PATH.test(access.path)) {
    hits.push({ decision: 'warn', rule: SECRET_READ.name, explanation: SECRET_READ.why });
  }

  if (access.op !== 'read' && access.reaches === 'outside-directory') hits.push(WRITE_OUTSIDE);

  if (access.reaches === 'user-mount' && (access.op === 'delete' || (access.op === 'write' && access.replaces === true))) hits.push(OVERWRITE);

  return { decision: dominant(hits), hits };
}

/** No default owner: no caller silently picks a trust tier. */
export function reviewCommand(command: string, filesOwner: FilesOwner): ApprovalResult {
  const reading = readShell(command);
  const read = reading === null ? null : commandsRun(reading);
  const expanding = new Set(read?.runs.flatMap(({ command: run }) => (run.words.some((word) => word.literal === null) ? programOf(run) ?? [] : [])));
  const agentsOwn = filesOwner === 'agent';

  const hits: ApprovalRuleHit[] = [];

  for (const r of RULES) {
    const fires = r.fires !== undefined && read !== null && r.fires(read.runs);

    // The signature where the reading cannot see what runs, where a word of one of the rule's programs expands, and
    // always for a deny or a rule that is only its signature.
    const textToo = r.fires === undefined || r.decision === 'deny' || read === null || !read.followed
      || (r.binaries?.some((binary) => expanding.has(binary)) ?? false);

    if (!fires && !(textToo && r.signature.test(command))) continue;

    // Local harm to the agent's own files is not gated; 'deny' is exempt.
    if (agentsOwn && r.harm === 'local' && r.decision !== 'deny') continue;
    hits.push({ decision: r.decision, rule: r.name, explanation: r.why });
  }

  return { decision: dominant(hits), hits };
}
