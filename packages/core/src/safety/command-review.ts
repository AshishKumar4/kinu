/** 'allow', 'warn', 'gate' (the owner decides) or 'deny', by rule and whose files. Against accidents, not an adversary. */

import type { ShellCwd, ShellSession } from '../execution/shell-session';
import { machinePath } from '../vfs/resolve';
import { workspacePath } from '../vfs/workspace-path';

export type ApprovalDecision = 'allow' | 'warn' | 'gate' | 'deny';

/** Where a rule's harm lands: 'local' (the executing machine only) or 'reaches_out' (leaves the executor). */
export type ApprovalHarm = 'local' | 'reaches_out';

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
  pattern: RegExp;
  decision: ApprovalDecision;
  name: string;
  why: string;
  harm: ApprovalHarm;
  /** When present, the rule fires only if one of these is invoked; absent, on the whole line. Deny rules carry none. */
  binaries?: readonly string[];
}

/** Long options taking the next word as a value (git.c). */
const GIT_VALUE_OPTION = '(?:git-dir|work-tree|namespace|config-env|super-prefix)';

/** `git` and its global options; each word parses one way, so a failed match stays linear. */
const GIT = String.raw`\bgit(?:\s+(?:(?:-[Cc]|--${GIT_VALUE_OPTION})\s+\S+|-[pP]|--(?!${GIT_VALUE_OPTION}(?:\s|$))[\w-]+(?:=\S+)?))*\s+`;

const SECRET_PATH = /(\.env|\.npmrc|\.pypirc|\.aws|\.ssh|credentials)/i;

const SECRET_READ = { name: 'secret-file-read', why: 'Reads a file likely to contain secrets.' } as const;

/** Every ecosystem's publish command. `binaries` gates whether the rule fires, so extend both together. */
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

/** Default rules, resolved by {@link reviewCommand}. `harm: 'local'`: damage stops at the machine. */
const RULES: Rule[] = [
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*(?:\s+(?:--[^\s]+|-[a-zA-Z]+))*\s+\/+(?=\s|$|[;&|])/,
    decision: 'deny',
    name: 'rm-rf-root',
    why: 'Deletes the entire root filesystem.',
    harm: 'local',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    decision: 'deny',
    name: 'fork-bomb',
    why: 'Classic shell fork bomb pattern.',
    harm: 'local',
  },
  {
    pattern: /\bdd\b(?=[^;|&\n]*if=\/dev\/(?:zero|urandom)\b)(?=[^;|&\n]*of=\/dev\/(?:sd[a-z]|nvme[^\s;|&]*))/i,
    decision: 'deny',
    name: 'dd-overwrite-disk',
    why: 'Overwrites raw block devices.',
    harm: 'local',
  },
  {
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b[^;|&]*\/dev\/sd[a-z]/i,
    decision: 'deny',
    name: 'mkfs-physical-disk',
    why: 'Reformats a real disk device.',
    harm: 'local',
  },
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:sh|dash)\b/i,
    decision: 'deny',
    name: 'pipe-to-shell',
    why: 'Downloads remote script and pipes directly to shell.',
    harm: 'reaches_out',
  },
  {
    pattern: /\b(curl|wget)\s+[^|]*\|\s*(?:sudo\s+)?(?:\S*\/)?bash\b/i,
    decision: 'deny',
    name: 'pipe-to-bash',
    why: 'Downloads remote script and pipes directly to bash.',
    harm: 'reaches_out',
  },

  {
    // Just the word: `binaries` decides command position.
    pattern: /\bsudo\b/,
    decision: 'gate',
    name: 'sudo',
    why: 'Privilege escalation on a machine that is not the agent\'s own.',
    harm: 'local',
    binaries: ['sudo'],
  },
  {
    pattern: /\bsu(?:\s+-|\s+\S|\s*$)/,
    decision: 'gate',
    name: 'su',
    why: 'User switching.',
    harm: 'local',
    binaries: ['su'],
  },
  {
    pattern: /\bchmod\s+(?:[ugoa]*\+s|\+s|4\d\d\d?|7\d\d\d?|2\d{3}|3\d{3}|5\d{3}|6\d{3})/,
    decision: 'gate',
    name: 'chmod-setuid',
    why: 'Sets setuid/setgid bits.',
    harm: 'local',
    binaries: ['chmod'],
  },
  {
    pattern: /\b(chown|chgrp)\s+(?:-[^\s]+\s+)*(root|0)\b/i,
    decision: 'gate',
    name: 'chown-root',
    why: 'Reassigns ownership to root.',
    harm: 'local',
    binaries: ['chown', 'chgrp'],
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r/i,
    decision: 'gate',
    name: 'rm-recursive',
    why: 'Recursive delete.',
    harm: 'local',
    binaries: ['rm'],
  },
  {
    pattern: new RegExp(`${GIT}reset\\s+--hard`),
    decision: 'gate',
    name: 'git-reset-hard',
    why: 'Discards local changes irreversibly.',
    harm: 'local',
    binaries: ['git'],
  },
  {
    pattern: new RegExp(`${GIT}checkout(?:\\s+\\S+)*\\s+(?:--|\\.)(?:\\s|$)|${GIT}restore\\b(?:(?![^;|&\\n]*--staged)|[^;|&\\n]*--worktree)`),
    decision: 'gate',
    name: 'git-discard-changes',
    why: 'Discards uncommitted changes to tracked files.',
    harm: 'local',
    binaries: ['git'],
  },
  {
    pattern: new RegExp(`${GIT}clean\\b[^;|&\\n]*\\s(?:-[a-zA-Z]*f|--force)`),
    decision: 'gate',
    name: 'git-clean',
    why: 'Deletes untracked files.',
    harm: 'local',
    binaries: ['git'],
  },
  {
    pattern: /\bfind\b[^;|&\n]*\s-delete\b/,
    decision: 'gate',
    name: 'find-delete',
    why: 'Deletes every file the search matches.',
    harm: 'local',
    binaries: ['find'],
  },
  {
    pattern: /\brsync\b[^;|&\n]*\s--del(?:ete[\w-]*)?\b/,
    decision: 'gate',
    name: 'rsync-delete',
    why: 'Deletes destination files the source lacks.',
    harm: 'local',
    binaries: ['rsync'],
  },
  {
    pattern: /\bdocker\s+(rm\s+-f|system\s+prune)/,
    decision: 'gate',
    name: 'docker-destructive',
    why: 'Docker destructive operation.',
    harm: 'local',
    binaries: ['docker'],
  },
  {
    pattern: new RegExp(`${GIT}push\\b[^;|&]*?(?:\\s--force\\b|\\s-f\\b)`),
    decision: 'gate',
    name: 'git-force-push',
    why: 'Force-push rewrites history on a remote nobody here owns.',
    harm: 'reaches_out',
    binaries: ['git'],
  },
  {
    pattern: PACKAGE_PUBLISH,
    decision: 'gate',
    name: 'package-publish',
    why: 'Publishes to a public package registry.',
    harm: 'reaches_out',
    binaries: [
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'cargo',
      'poetry',
      'uv',
      'flit',
      'hatch',
      'twine',
      'gem',
      'mvn',
      'gradle',
      'gradlew',
      'dotnet',
      'python',
      'python3',
    ],
  },

  {
    pattern: /\b169\.254\.169\.254\b/,
    decision: 'deny',
    name: 'cloud-metadata-ip',
    why: 'AWS/GCP/Azure cloud-metadata endpoint: common SSRF target.',
    harm: 'reaches_out',
  },
  {
    pattern: /\bmetadata\.google\.internal\b/,
    decision: 'deny',
    name: 'gcp-metadata',
    why: 'GCP metadata endpoint.',
    harm: 'reaches_out',
  },

  // Both leak into the transcript, so neither is 'local'.
  {
    pattern: /\b(printenv|env)\b(?!\s*\|.*grep)/,
    decision: 'warn',
    name: 'env-dump',
    why: 'Prints environment variables (may leak secrets to LLM output).',
    harm: 'reaches_out',
    binaries: ['printenv', 'env'],
  },
  {
    pattern: new RegExp(String.raw`\bcat\s+.*` + SECRET_PATH.source, 'i'),
    decision: 'warn',
    name: SECRET_READ.name,
    why: SECRET_READ.why,
    harm: 'reaches_out',
    binaries: ['cat'],
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

/** Prefix words that keep the next word in command position. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(['sudo', 'command', 'exec', 'time', 'nice']);

/** Programs that run an argument as a program; under them, binary-scoped rules match the whole line. */
const INLINE_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'python', 'python3', 'perl', 'ruby', 'node', 'bun', 'deno',
  'xargs', 'ssh', 'env', 'nohup', 'timeout', 'watch', 'find', 'docker',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Outside quotes, each ends a simple command. `&&` and `||` fall out of `&` and `|`. */
const COMMAND_BREAKS = new Set([';', '&', '|', '(', ')', '{', '}', '\n', '`']);

interface CommandScan {
  readonly invoked: ReadonlySet<string>;
  /** The line with quoted spans blanked; binary-scoped rules match against it. */
  readonly unquoted: string;
}

/** One quote-aware pass: programs in command position (after env assignments and prefix words) and the unquoted
 *  text. Over-collecting is safe. */
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

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote !== null) {
      if (ch === quote) { quote = null; unquoted += ' '; }
      else word += ch;
      continue;
    }

    if (ch === '"' || ch === "'") { quote = ch; continue; }

    if (ch === '\\') { i++; continue; }

    unquoted += ch;

    if (ch === ' ' || ch === '\t') { endWord(); continue; }

    if (COMMAND_BREAKS.has(ch)) { endWord(); atCommandStart = true; continue; }

    if (ch === '$' && command[i + 1] === '(') { endWord(); atCommandStart = true; i++; continue; }

    word += ch;
  }

  endWord();

  return { invoked, unquoted };
}

/** null: the shell would expand it. */
type ShellWord = string | null;

/** `after`: the separator before it, `;` for a newline or parenthesis. */
interface ShellStep {
  readonly after: string;
  readonly words: readonly ShellWord[];
}

const EXPANDING: ReadonlySet<string> = new Set(['$', '`', '*', '?', '[']);

const STEP_BREAKS: ReadonlySet<string> = new Set([';', '\n', '(', ')']);

/** Every word the shell would take as written, unexpanded. */
export function literalWords(command: string): string[] {
  return shellSteps(command).flatMap((step) => step.words.filter((word) => word !== null));
}

/** A subshell's `cd` counts as the session's, which only asks more. */
function shellSteps(command: string): ShellStep[] {
  const steps: ShellStep[] = [];
  let words: ShellWord[] = [];
  let after = '';
  let word = '';
  let started = false;
  let expands = false;
  let quote: string | null = null;

  const endWord = () => {
    if (started) words.push(expands ? null : word);
    word = '';
    started = false;
    expands = false;
  };

  const endStep = (next: string) => {
    endWord();

    if (words.length > 0) steps.push({ after, words });
    words = [];
    after = next;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);

    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`')) { expands = true; word += ch; }
      else word += ch;
      continue;
    }

    const pair = command.slice(i, i + 2);

    if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (ch === '\\') { word += command.charAt(++i); started = true; }
    else if (ch === ' ' || ch === '\t') endWord();
    else if (pair === '&&' || pair === '||') { endStep(pair); i++; }
    else if (STEP_BREAKS.has(ch)) endStep(';');
    else if (ch === '|' || ch === '&') endStep(ch);
    else { word += ch; started = true; expands ||= EXPANDING.has(ch); }
  }

  endStep('');

  return steps;
}

/** `~name` is another account's home, which the shell would expand: unknown here. */
export function shellPath(word: ShellWord, cwd: string, home: string): string | null {
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
function cdTarget(step: ShellStep, cwd: string, home: string): string | null | undefined {
  const [verb, ...args] = step.words;

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
export function commandFilesOwner(executor: GatedExecutor, command: string, session: ShellCwd | undefined): FilesOwner {
  const roots = executor.shellSession?.userRoots() ?? [];

  if (executor.filesOwner === 'user' || roots.length === 0) return executor.filesOwner;

  if (roots.some((root) => namesRoot(command, root))) return 'user';

  if (session === undefined) return 'agent';

  if (session.mayBeUsers || underRoots(session.cwd, roots)) return 'user';
  let cwd = session.cwd;

  for (const step of shellSteps(command)) {
    const reached = step.words.map((word) => (word?.startsWith('-') ? null : shellPath(word, cwd, session.home)));

    if (reached.some((path) => path !== null && underRoots(path, roots))) return 'user';
    cwd = cdTarget(step, cwd, session.home) ?? cwd;
  }

  return 'agent';
}

/** A `mv` or `cp` destination: `-t`'s, else the last argument. */
function copyTarget(step: ShellStep): ShellWord | undefined {
  const [verb, ...args] = step.words;

  if (verb !== 'mv' && verb !== 'cp') return undefined;
  const flag = args.indexOf('-t');

  if (flag !== -1) return args[flag + 1];
  const long = args.find((arg) => arg?.startsWith('--target-directory=') === true);

  return long === undefined ? args.at(-1) : long?.slice('--target-directory='.length) ?? null;
}

function truncatingRedirect(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (word.charAt(i) === '>' && word.charAt(i - 1) !== '>' && word.charAt(i + 1) !== '>') return i;
  }

  return -1;
}

/** Files a `>` truncates; `>>` appends. */
function redirectTargets(step: ShellStep): ShellWord[] {
  const targets: ShellWord[] = [];

  for (const [index, word] of step.words.entries()) {
    const at = word === null ? -1 : truncatingRedirect(word);

    if (word === null || at === -1) continue;
    const rest = word.slice(at + 1);
    targets.push(rest === '' ? step.words[index + 1] ?? null : rest);
  }

  return targets;
}

function overwritesUserFiles(executor: GatedExecutor, command: string, session: ShellCwd | undefined): boolean {
  const roots = executor.shellSession?.userRoots() ?? [];
  const home = session?.home ?? '/';
  let cwd = session?.cwd ?? '/';

  for (const step of roots.length === 0 ? [] : shellSteps(command)) {
    const targets = [...redirectTargets(step), copyTarget(step)].filter((target): target is ShellWord => target !== undefined);

    // From a directory that may be the user's, a relative write may land there.
    if (session?.mayBeUsers === true && targets.some((target) => target === null || !/^[/~]/u.test(target))) return true;
    const written = targets.map((target) => shellPath(target, cwd, home));

    if (written.some((path) => path !== null && underRoots(path, roots))) return true;
    cwd = cdTarget(step, cwd, home) ?? cwd;
  }

  return false;
}

const OVERWRITE: ApprovalRuleHit = {
  decision: 'gate', rule: 'overwrite-user-files', explanation: 'Moves, copies or writes onto the user\'s device or Drive, replacing what is there.',
};

/** The rule table for whose files a command reaches, and any overwrite onto the user's mounts. */
export function reviewShellCommand(executor: GatedExecutor, command: string, session: ShellCwd | undefined): ApprovalResult {
  const review = reviewCommand(command, commandFilesOwner(executor, command, session));

  if (!overwritesUserFiles(executor, command, session)) return review;
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

/** `runCode` in another language: its text cannot show what it does to the user's files, so it asks there. */
export function reviewProgram(code: string, filesOwner: FilesOwner): ApprovalResult {
  const review = reviewCommand(code, filesOwner);

  if (filesOwner === 'agent') return review;
  const hits = [...review.hits, { decision: 'gate', rule: 'program-on-user-files', explanation: 'Runs a program over the user\'s files.' } as const];

  return { decision: dominant(hits), hits };
}

/** No default owner: no caller silently picks a trust tier. */
export function reviewCommand(command: string, filesOwner: FilesOwner): ApprovalResult {
  const { invoked, unquoted } = scanCommand(command);
  let opaque = false;

  for (const binary of invoked) {
    if (INLINE_INTERPRETERS.has(binary)) { opaque = true; break; }
  }

  const agentsOwn = filesOwner === 'agent';

  const hits: ApprovalRuleHit[] = [];

  for (const r of RULES) {
    // Rules without binaries, and every rule under an interpreter, match the raw text.
    if (r.binaries && !opaque) {
      if (!r.binaries.some((b) => invoked.has(b))) continue;

      if (!r.pattern.test(unquoted)) continue;
    } else if (!r.pattern.test(command)) continue;

    // Local harm to the agent's own files is not gated; 'deny' is exempt.
    if (agentsOwn && r.harm === 'local' && r.decision !== 'deny') continue;
    hits.push({ decision: r.decision, rule: r.name, explanation: r.why });
  }

  return { decision: dominant(hits), hits };
}
