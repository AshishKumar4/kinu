/**
 * 'allow', 'warn', 'gate' (the owner decides) or 'deny', by rule and whose files. Against accidents, not an adversary.
 * A rule judges the commands the line runs as the shell reads them (`shell-reading.ts`), and its signature judges the
 * line's text where that reading cannot see what runs (`followed: false`), where a word of one of its programs expands,
 * and always for a deny. Under both stands the text review this one replaced ({@link scanCommand}): a reading that
 * misses an act, as lifo misreads a few constructs bash runs, leaves the line judged as it was, never weaker.
 *
 * What the reading cannot resolve fails closed: a word it cannot know may be any word, so a rule it may trip asks the
 * owner, as does a line whose commands it cannot know at all (`unresolved`). A path it cannot know may be the user's.
 */

import type { ShellCwd, ShellSession } from '../execution/shell-session';
import { machinePath } from '../vfs/resolve';
import { workspacePath } from '../vfs/workspace-path';
import {
  commandsRun, joinedWords, programOf, readShell, UNRESOLVED, wordRuns, type CommandRun, type CommandsRun, type ShellCommand, type ShellWord,
} from './shell-reading';

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
  /** The rule over the commands the line runs, `may` taking each word it cannot know as whatever trips it; absent for
   *  one that is its signature wherever it appears. */
  fires?: (runs: readonly CommandRun[], may: boolean) => boolean;
  /** The act in the line's text, read where the shell's reading does not see what runs. */
  signature: RegExp;
  /** The programs whose expanding words leave the rule to its signature too. */
  binaries?: readonly string[];
}

/** A rule over the commands the line runs. */
const running = (test: (run: CommandRun, may: boolean) => boolean) => (runs: readonly CommandRun[], may: boolean): boolean => runs.some((run) => test(run, may));

/** A command's arguments, read as getopt reads them: short flags, long option names, and the operands. */
interface Arguments {
  readonly short: ReadonlySet<string>;
  readonly long: ReadonlySet<string>;
  readonly operands: readonly ShellWord[];
  /** A word the shell expands, which may be any flags and operands. */
  readonly open: boolean;
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

  return { short, long, operands, open: words.some((word) => word.literal === null) };
}

const argumentsAfter = (command: ShellCommand): Arguments => argumentsOf(command.words.slice(1));

const literals = (words: readonly ShellWord[]): string[] => words.flatMap((word) => (word.literal === null ? [] : [word.literal]));

/** Whether `word` is one `test` accepts; under `may`, a word the shell expands is. */
const could = (word: ShellWord | undefined, may: boolean, test: (literal: string) => boolean): boolean => word !== undefined && (word.literal === null ? may : test(word.literal));

const holds = (words: readonly ShellWord[], may: boolean, test: (literal: string) => boolean): boolean => words.some((word) => could(word, may, test));

/** git's global options that take the next word as their value (git.c). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** A `git` command's subcommand and the words after it, past any number of global options; under `may`, a word the
 *  shell expands before it may be any subcommand (null). */
function gitSubcommand(command: ShellCommand, may: boolean): { readonly name: string | null; readonly words: readonly ShellWord[] } | null {
  if (programOf(command) !== 'git') return null;

  for (let at = 1; at < command.words.length; at++) {
    const word = command.words[at]?.literal ?? null;

    if (word === null) return may ? { name: null, words: command.words.slice(at) } : null;

    if (!word.startsWith('-')) return { name: word, words: command.words.slice(at + 1) };

    if (GIT_VALUE_OPTIONS.has(word)) at++;
  }

  return null;
}

const gitRunning = (name: string, test: (words: readonly ShellWord[], may: boolean) => boolean) => running(({ command }, may) => {
  const sub = gitSubcommand(command, may);

  return sub !== null && (sub.name === name || sub.name === null) && test(sub.words, may);
});

const recursive = ({ short, long, open }: Arguments, may: boolean): boolean => short.has('r') || short.has('R') || long.has('recursive') || (may && open);

const forced = ({ short, long, open }: Arguments, may: boolean): boolean => short.has('f') || long.has('force') || (may && open);

/** The words a tool's subcommand may be, each with an operand that may follow it. Its first operand, and each later one
 *  while the word before it may have taken it as a value (`npm --registry <url> publish`); a word the shell expands may
 *  be none, or an option and its value, so it ends nothing, and past one the next operand may be the next known one. */
function subcommands(command: ShellCommand): (readonly [ShellWord, ShellWord | undefined])[] {
  const words = command.words.slice(1);
  const flags = words.map(({ text }) => text.startsWith('-') && text !== '-');
  const takes = words.map(({ literal, text }, at) => literal === null || (flags[at] === true && text !== '--' && !text.includes('=')));
  const operands = words.flatMap((word, at) => (flags[at] === true ? [] : [{ word, at }]));
  // From each operand on, the first known one: an expansion reads like any other, so one pair past a run of them stands
  // for the run.
  const known: (ShellWord | undefined)[] = [];

  for (let at = operands.length - 1; at >= 0; at--) {
    const word = operands[at]?.word;

    known[at] = word?.literal === null ? known[at + 1] : word;
  }

  const candidates: (readonly [ShellWord, ShellWord | undefined])[] = [];

  for (const [index, { word, at }] of operands.entries()) {
    const next = operands[index + 1]?.word;

    candidates.push([word, next]);

    if (next?.literal === null && known[index + 1] !== undefined) candidates.push([word, known[index + 1]]);

    if (word.literal !== null && takes[at - 1] !== true) break;
  }

  return candidates;
}

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

/** A mode that sets the setuid or setgid bit: a symbolic clause one of whose operations is `+…s` or `=…s` (`u+s-w`
 *  holds two), or four octal digits led by 2 to 7. */
const SETUID_MODE = /^(?:[ugoa]*(?:[-+=][rwxXstugo]*)*[+=][rwxXtugo]*s|[2-7][0-7]{3}$)/u;

const DOWNLOADERS = ['curl', 'wget'];

/** A shell stage that reads what a download earlier in its pipeline writes. */
const pipedFromDownload = (shells: readonly string[]) => running(({ command, stage, stages }) =>
  is(command, ...shells) && DOWNLOADERS.some((downloader) => (stages.get(downloader)?.first ?? stage) < stage));

const PUBLISHERS = [
  'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'uv', 'flit', 'hatch', 'twine', 'gem', 'mvn', 'gradle', 'gradlew', 'dotnet', 'python', 'python3',
];

/** A registry publish, per ecosystem: each tool's subcommand, an operand its options may leave first. */
function publishes(command: ShellCommand, may: boolean): boolean {
  const words = command.words.slice(1);
  const program = programOf(command) ?? '';

  const sub = (name: string, next?: string) => subcommands(command).some(([word, after]) => could(word, may, (literal) => literal === name)
    && (next === undefined || could(after, may, (literal) => literal === next)));

  if (program === 'yarn' && sub('npm', 'publish')) return true;

  if (['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'uv', 'flit', 'hatch'].includes(program)) return sub('publish');

  if (program === 'twine') return sub('upload');

  if (program === 'gem') return sub('push');

  // The `deploy` phase, or a goal of the deploy plugin by prefix or coordinates (`deploy:deploy-file`).
  if (program === 'mvn') return holds(words, may, (word) => word === 'deploy' || word.startsWith('deploy:') || /(?:^|:)maven-deploy-plugin(?::|$)/u.test(word));

  if (program === 'gradle' || program === 'gradlew') return holds(words, may, (word) => word.split(':').some((task) => task.startsWith('publish')));

  if (program === 'dotnet') return sub('nuget', 'push');

  if (program === 'python' || program === 'python3') {
    if (literals(words).join(' ').includes('-m twine') && literals(words).includes('upload')) return true;
    // Its options end at `-c`, `-m` or a script: a word before them the shell expands may be `-m twine upload`.
    const end = words.findIndex(({ literal }) => literal !== null && (literal === '-c' || literal === '-m' || !literal.startsWith('-')));
    const module = words[end]?.literal === '-m' ? words.slice(end + 1) : [];

    return may && (words.slice(0, end === -1 ? undefined : end).some(({ literal }) => literal === null)
      || (could(module[0], may, (literal) => literal === 'twine') && holds(module.slice(1), may, (literal) => literal === 'upload')));
  }

  return false;
}

/** A recursive delete: `-r`, `-R` or `--recursive`, wherever among the flags. */
const deletesRecursively = (command: ShellCommand, may: boolean): boolean => is(command, 'rm') && recursive(argumentsAfter(command), may);

const METADATA_IP = /\b169\.254\.169\.254\b/u;

const GCP_METADATA = /\bmetadata\.google\.internal\b/u;

/** A rule over every word a command the line runs holds, its quotes joined, wherever the line has it run. */
const naming = (target: RegExp) => running(({ command }) => [...command.words, ...command.redirects.map(({ target: file }) => file)].some((word) => target.test(word.text)));

/** Default rules, resolved by {@link reviewCommand}. `harm: 'local'`: damage stops at the machine. */
const RULES: Rule[] = [
  {
    fires: running(({ command }, may) => deletesRecursively(command, may) && command.words.slice(1).some((word) => {
      if (ROOT_TARGET.test(word.text)) return true;

      if (!may || word.literal !== null) return false;
      // A word the shell expands may be `/`, unless it is a glob under a directory it names (`dist/*`, `/tmp/*`).
      const directory = globDirectory(word, '/', '/');

      return directory === null || (directory === '' && word.text.startsWith('/'));
    })),
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
    fires: running(({ command }, may) => is(command, 'dd')
      && holds(command.words, may, (word) => /^if=\/dev\/(?:zero|urandom)$/iu.test(word))
      && holds(command.words, may, (word) => /^of=\/dev\/(?:sd[a-z]|nvme)/iu.test(word))),
    decision: 'deny',
    name: 'dd-overwrite-disk',
    signature: /\bdd\b(?=[^;|&\n]*if=\/dev\/(?:zero|urandom)\b)(?=[^;|&\n]*of=\/dev\/(?:sd[a-z]|nvme[^\s;|&]*))/i,
    why: 'Overwrites raw block devices.',
    harm: 'local',
  },
  {
    fires: running(({ command }, may) => /^mkfs(?:\.[a-z0-9]+)?$/iu.test(programOf(command) ?? '') && holds(command.words, may, (word) => /^\/dev\/sd[a-z]/iu.test(word))),
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
    fires: running(({ command }, may) => is(command, 'chmod') && holds(command.words.slice(1), may, (word) => word.split(',').some((mode) => SETUID_MODE.test(mode)))),
    decision: 'gate',
    name: 'chmod-setuid',
    binaries: ['chmod'],
    signature: /\bchmod\s+(?:[ugoa]*\+s|\+s|4\d\d\d?|7\d\d\d?|2\d{3}|3\d{3}|5\d{3}|6\d{3})/,
    why: 'Sets setuid/setgid bits.',
    harm: 'local',
  },
  {
    fires: running(({ command }, may) => {
      const args = argumentsAfter(command);

      return is(command, 'chown', 'chgrp') && (/^(?:root|0)(?:[:.]|$)/iu.test(args.operands[0]?.text ?? '') || (may && args.open));
    }),
    decision: 'gate',
    name: 'chown-root',
    binaries: ['chown', 'chgrp'],
    signature: /\b(chown|chgrp)\s+(?:-[^\s]+\s+)*(root|0)\b/i,
    why: 'Reassigns ownership to root.',
    harm: 'local',
  },
  {
    fires: running(({ command }, may) => deletesRecursively(command, may)),
    decision: 'gate',
    name: 'rm-recursive',
    binaries: ['rm'],
    signature: /\brm\s+-[a-zA-Z]*r/i,
    why: 'Recursive delete.',
    harm: 'local',
  },
  {
    fires: gitRunning('reset', (words, may) => holds(words, may, (word) => word === '--hard')),
    decision: 'gate',
    name: 'git-reset-hard',
    binaries: ['git'],
    signature: new RegExp(`${GIT}reset\\s+--hard`),
    why: 'Discards local changes irreversibly.',
    harm: 'local',
  },
  {
    fires: (runs, may) => gitRunning('checkout', (words) => holds(words, may, (word) => word === '--' || word === '.'))(runs, may)
      || gitRunning('restore', (words) => {
        const { short, long, open } = argumentsOf(words);

        return !(short.has('S') || long.has('staged')) || short.has('W') || long.has('worktree') || (may && open);
      })(runs, may),
    decision: 'gate',
    name: 'git-discard-changes',
    binaries: ['git'],
    signature: new RegExp(`${GIT}checkout(?:\\s+\\S+)*\\s+(?:--|\\.)(?:\\s|$)|${GIT}restore\\b(?:(?![^;|&\\n]*--staged)|[^;|&\\n]*--worktree)`),
    why: 'Discards uncommitted changes to tracked files.',
    harm: 'local',
  },
  {
    fires: gitRunning('clean', (words, may) => forced(argumentsOf(words), may)),
    decision: 'gate',
    name: 'git-clean',
    binaries: ['git'],
    signature: new RegExp(`${GIT}clean\\b[^;|&\\n]*\\s(?:-[a-zA-Z]*f|--force)`),
    why: 'Deletes untracked files.',
    harm: 'local',
  },
  {
    fires: running(({ command }, may) => is(command, 'find') && holds(command.words, may, (word) => word === '-delete')),
    decision: 'gate',
    name: 'find-delete',
    binaries: ['find'],
    signature: /\bfind\b[^;|&\n]*\s-delete\b/,
    why: 'Deletes every file the search matches.',
    harm: 'local',
  },
  {
    fires: running(({ command }, may) => is(command, 'rsync') && holds(command.words, may, (word) => word.startsWith('--del'))),
    decision: 'gate',
    name: 'rsync-delete',
    binaries: ['rsync'],
    signature: /\brsync\b[^;|&\n]*\s--del(?:ete[\w-]*)?\b/,
    why: 'Deletes destination files the source lacks.',
    harm: 'local',
  },
  {
    fires: running(({ command }, may) => {
      const removes = forced(argumentsAfter(command), may);

      return is(command, 'docker') && subcommands(command).some(([sub, next]) => (could(sub, may, (word) => word === 'rm') && removes)
        || (could(sub, may, (word) => word === 'container') && could(next, may, (word) => word === 'rm') && removes)
        || (could(sub, may, (word) => word === 'system') && could(next, may, (word) => word === 'prune')));
    }),
    decision: 'gate',
    name: 'docker-destructive',
    binaries: ['docker'],
    signature: /\bdocker\s+(rm\s+-f|system\s+prune)/,
    why: 'Docker destructive operation.',
    harm: 'local',
  },
  {
    fires: gitRunning('push', (words, may) => {
      const pushed = argumentsOf(words);

      return pushed.short.has('f') || [...pushed.long].some((name) => name.startsWith('force')) || pushed.operands.some((word) => word.text.startsWith('+')) || (may && pushed.open);
    }),
    decision: 'gate',
    name: 'git-force-push',
    binaries: ['git'],
    signature: new RegExp(`${GIT}push\\b[^;|&]*?(?:\\s--force\\b|\\s-f\\b)`),
    why: 'Force-push rewrites history on a remote nobody here owns.',
    harm: 'reaches_out',
  },
  {
    fires: running(({ command }, may) => publishes(command, may)),
    decision: 'gate',
    name: 'package-publish',
    binaries: PUBLISHERS,
    signature: PACKAGE_PUBLISH,
    why: 'Publishes to a public package registry.',
    harm: 'reaches_out',
  },

  {
    fires: naming(METADATA_IP),
    signature: METADATA_IP,
    decision: 'deny',
    name: 'cloud-metadata-ip',
    why: 'AWS/GCP/Azure cloud-metadata endpoint: common SSRF target.',
    harm: 'reaches_out',
  },
  {
    fires: naming(GCP_METADATA),
    signature: GCP_METADATA,
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
    fires: running(({ command }) => is(command, 'cat') && [...argumentsAfter(command).operands, ...command.redirects.flatMap((redirect) => (redirect.reads ? [redirect.target] : []))]
      .some((word) => SECRET_PATH.test(word.text))),
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

/** Expansions whose value is a number: an exit status, a count, a process id, arithmetic. */
const NUMERIC = /\$[?#$!]|\$\(\((?:[^()]|\([^()]*\))*\)\)/gu;

/** The directory every path a word the shell expands may name lies in, `..` resolved ('' for the root): a glob's, before
 *  its first pattern. Null where it may be anywhere: a parameter, a substitution, a brace bash expands, a part of a glob
 *  that may match `..`, another account's home. */
function globDirectory(word: ShellWord, cwd: string, home: string): string | null {
  const written = word.text.replace(NUMERIC, '0');

  if (/[$`{]/u.test(written) || written.split('/').some((part) => /[*?[]/u.test(part) && /^[.[]/u.test(part))) return null;
  const path = shellPath(written, cwd, home);

  if (path === null) return null;
  const glob = path.search(/[*?[]/u);

  return path.slice(0, path.lastIndexOf('/', glob === -1 ? path.length : glob));
}

/** Whether a word may name a path under `roots`, read from `cwd`: a known one by its path, unless it is an option (whose
 *  value `namesRoot` reads); one the shell expands by every path it may match. */
function mayReach(word: ShellWord, cwd: string, home: string, roots: readonly string[]): boolean {
  if (word.literal === null) {
    const directory = globDirectory(word, cwd, home);

    return directory === null || underRoots(directory, roots) || roots.some((root) => root.startsWith(`${directory}/`));
  }

  if (word.literal.startsWith('-')) return false;
  const path = shellPath(word.literal, cwd, home);

  return path === null || underRoots(path, roots);
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

/** The most directories a line's relative paths are read from: each `cd` is kept beside the directories before it, so
 *  a line of n of them reaches 2^n; past this many the line's paths are unknown. */
const CWD_BOUND = 64;

/** `cwds` with each `cd` in `words` taken from every one of them, or null where one goes somewhere unknown, or past
 *  {@link CWD_BOUND}. */
function movedThrough(cwds: ReadonlySet<string>, words: readonly ShellWord[], home: string): Set<string> | null {
  const next = new Set(cwds);

  for (const cwd of cwds) {
    const moved = cdTarget(words, cwd, home);

    if (moved === null) return null;

    if (moved !== undefined) next.add(moved);
  }

  return next.size > CWD_BOUND ? null : next;
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
  let cwds: Set<string> | null = new Set([session.cwd]);

  for (const { words } of runs) {
    for (const cwd of cwds) {
      if (words.some((word) => mayReach(word, cwd, session.home, roots))) return 'user';
    }

    cwds = movedThrough(cwds, words, session.home);

    if (cwds === null) return 'user';
  }

  return 'agent';
}

/** A `mv` or `cp` destination: `-t`'s, else the last argument. */
function copyTarget(step: ShellCommand): ShellWord | undefined {
  if (!is(step, 'mv', 'cp')) return undefined;
  const args = step.words.slice(1);
  const flag = args.findIndex((arg) => arg.literal === '-t');

  if (flag !== -1) return args[flag + 1];
  const long = args.find((arg) => arg.text.startsWith('--target-directory='));

  return long === undefined ? args.at(-1) : { literal: long.literal?.slice('--target-directory='.length) ?? null, text: long.text.slice('--target-directory='.length) };
}

function overwritesUserFiles(executor: GatedExecutor, read: CommandsRun | null, session: ShellCwd | undefined, owner: FilesOwner): boolean {
  const roots = executor.shellSession?.userRoots() ?? [];
  const home = session?.home ?? '/';

  if (roots.length === 0) return false;

  // A line whose writes this reading cannot see, that reaches the user's files, may replace one.
  if (read === null) return owner === 'user';
  // As ownership reads a line: each `cd` kept beside the directory before it. Every command the line runs, a shell's
  // script's and a wrapper's included, is one that may write.
  let cwds: Set<string> | null = new Set([session?.cwd ?? '/']);
  let writes = false;
  let linked = false;

  for (const { command: step } of read.runs) {
    // Files a `>` or `&>` truncates (`>>` appends), and where a move or copy lands.
    const targets = [...step.redirects.flatMap((redirect) => (redirect.truncates ? [redirect.target] : [])), copyTarget(step)]
      .filter((target): target is ShellWord => target !== undefined);

    const relative = targets.some(({ literal }) => literal === null || !/^[/~]/u.test(literal));

    writes ||= targets.length > 0;

    // From a directory that may be the user's, a relative write may land there; from one past those tracked, it may on
    // a line that reaches the user's files.
    if (relative && session?.mayBeUsers === true) return true;

    if (relative && cwds === null) return owner === 'user';

    for (const cwd of cwds ?? [home]) {
      if (targets.some((target) => mayReach(target, cwd, home, roots))) return true;
      // A link the line makes to the user's files may carry any write it makes there.
      linked ||= is(step, 'ln', 'link') && step.words.slice(1).some((word) => mayReach(word, cwd, home, roots));
    }

    if (cwds !== null) cwds = movedThrough(cwds, step.words, home);
  }

  return writes && linked;
}

const OVERWRITE: ApprovalRuleHit = {
  decision: 'gate', rule: 'overwrite-user-files', explanation: 'Moves, copies or writes onto the user\'s device or Drive, replacing what is there.',
};

/** The rule table for whose files a command reaches, and any overwrite onto the user's mounts. */
export function reviewShellCommand(executor: GatedExecutor, command: string, session: ShellCwd | undefined): ApprovalResult {
  const line = lineRead(command);
  const owner = commandFilesOwner(executor, command, session);
  const review = judged(line, owner);

  if (!overwritesUserFiles(executor, line.read, session, owner)) return review;
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

/** Prefix words that keep the next word in command position, as the text review read them. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(['sudo', 'command', 'exec', 'time', 'nice']);

/** Programs that run an argument as a program; under them the text review matched each signature to the whole line. */
const INLINE_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'perl', 'ruby', 'node', 'bun', 'deno',
  'xargs', 'ssh', 'env', 'nohup', 'timeout', 'watch', 'find', 'docker',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Outside quotes, each ends a simple command. `&&` and `||` fall out of `&` and `|`. */
const COMMAND_BREAKS: ReadonlySet<string> = new Set([';', '&', '|', '(', ')', '{', '}', '\n', '`']);

/** What the text review saw of a line. */
interface CommandScan {
  /** Programs in command position, after env assignments and prefix words. */
  readonly invoked: ReadonlySet<string>;
  /** The line with quoted spans blanked; a rule with programs matches its signature here. */
  readonly unquoted: string;
  /** An interpreter runs: every signature matches the whole line. */
  readonly opaque: boolean;
}

/**
 * The text review the shell reading replaced, kept as the floor under it: one quote-aware pass, independent of lifo, so
 * a construct lifo reads unlike bash (a heredoc's end, a locale quote) is judged by it as before. Over-collecting is
 * safe.
 */
function scanCommand(command: string): CommandScan {
  const invoked = new Set<string>();
  let unquoted = '';
  let word = '';
  let atCommandStart = true;
  let quote: string | null = null;

  const endWord = () => {
    if (word.length === 0) return;

    if (atCommandStart && !ENV_ASSIGNMENT.test(word)) {
      const base = word.slice(word.lastIndexOf('/') + 1);

      invoked.add(base);

      if (!COMMAND_PREFIXES.has(base)) atCommandStart = false;
    }

    word = '';
  };

  for (let at = 0; at < command.length; at++) {
    const ch = command.charAt(at);

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        unquoted += ' ';
      } else word += ch;

      continue;
    }

    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\') at += 1;
    else {
      unquoted += ch;

      if (ch === ' ' || ch === '\t') endWord();
      else if (COMMAND_BREAKS.has(ch) || (ch === '$' && command.charAt(at + 1) === '(')) {
        endWord();
        atCommandStart = true;

        if (ch === '$') at += 1;
      } else word += ch;
    }
  }

  endWord();

  return { invoked, unquoted, opaque: [...invoked].some((program) => INLINE_INTERPRETERS.has(program)) };
}

/** A line as each reading of it a rule may be judged by holds it, read once per review. */
interface LineRead {
  readonly command: string;
  readonly scan: CommandScan;
  readonly read: CommandsRun | null;
  /** The line as written, and as the shell joins its words (`169.254.169.''254`): what a signature reads. */
  readonly texts: readonly string[];
  /** Programs a word of which the shell expands. */
  readonly expanding: ReadonlySet<string>;
}

function lineRead(command: string): LineRead {
  const reading = readShell(command);
  const read = reading === null ? null : commandsRun(reading);
  const joined = joinedWords(command);

  return {
    command, scan: scanCommand(command), read, texts: joined === null ? [command] : [command, joined],
    expanding: new Set(read?.runs.flatMap(({ command: run }) => (run.words.some((word) => word.literal === null) ? programOf(run) ?? [] : []))),
  };
}

/** Whether `r` trips on the line, may trip by a word the shell expands, or neither. */
function tripped(r: Rule, { command, scan, read, texts, expanding }: LineRead): 'trips' | 'may' | null {
  const fires = r.fires !== undefined && read !== null && r.fires(read.runs, false);

  // The signature where the reading cannot see what runs, where a word of one of the rule's programs expands, and
  // always for a deny or a rule that is only its signature.
  const textToo = r.fires === undefined || r.decision === 'deny' || read === null || !read.followed
    || (r.binaries?.some((binary) => expanding.has(binary)) ?? false);

  const scanned = r.binaries !== undefined && !scan.opaque
    ? r.binaries.some((binary) => scan.invoked.has(binary)) && r.signature.test(scan.unquoted)
    : r.signature.test(command);

  if (fires || scanned || (textToo && texts.some((text) => r.signature.test(text)))) return 'trips';

  return r.fires !== undefined && read !== null && r.fires(read.runs, true) ? 'may' : null;
}

/** No default owner: no caller silently picks a trust tier. */
export function reviewCommand(command: string, filesOwner: FilesOwner): ApprovalResult {
  return judged(lineRead(command), filesOwner);
}

function judged(line: LineRead, filesOwner: FilesOwner): ApprovalResult {
  const hits: ApprovalRuleHit[] = [];

  for (const r of RULES) {
    const trip = tripped(r, line);

    // Local harm to the agent's own files is not gated; 'deny' is exempt.
    if (trip === null || (filesOwner === 'agent' && r.harm === 'local' && r.decision !== 'deny')) continue;

    // A deny a word the shell expands may trip is the owner's to answer.
    hits.push(trip === 'trips'
      ? { decision: r.decision, rule: r.name, explanation: r.why }
      : { decision: r.decision === 'deny' ? 'gate' : r.decision, rule: r.name, explanation: `${r.why} (Possibly: part of it is known only when it runs.)` });
  }

  const unresolved = line.read === null ? [UNRESOLVED.parse] : line.read.unresolved;

  // What runs that the reading cannot know may be anything, on any executor.
  if (unresolved.length > 0) hits.push({ decision: 'gate', rule: 'unresolved', explanation: `Not known before it runs: ${unresolved.join('; ')}.` });

  return { decision: dominant(hits), hits };
}
