/**
 * Whether a shell command runs an interpreter on a program given as text, which the gate cannot read for what it does
 * to the files it reaches: an inline option (`node -e`, `python3 -c`), a program on stdin (`-`, a pipe, a heredoc, a
 * redirection), or `deno eval`. The command is read as the workspace shell reads it, by Nimbus's own parser: quotes
 * kept, redirections apart from words, every compound command and command substitution; and each interpreter's
 * arguments by its own grammar, so an option's value is never taken for the script. A program run from a file is not
 * one: the gate's other rules read the command, not the file.
 */
import { lex } from '@nimbus-sh/core/substrate/lifo/shell/lexer.js';
import { parse, ParseError } from '@nimbus-sh/core/substrate/lifo/shell/parser.js';
import { Cause, Effect } from 'effect';
import { settleSync } from '../obs/index';
import type { CompoundCommandNode, ListNode, RedirectionNode, SimpleCommandNode, WordPart } from '@nimbus-sh/core/substrate/lifo/shell/types.js';

/** A program's file name, as a shell finds it by name or by path. */
const basename = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/** An interpreter's command line, from its own `--help` (node 22, CPython 3.14, ruby 3.3, perl 5.40, bun 1.4). */
interface Grammar {
  /** Options whose value is the program's text. */
  readonly inline: readonly string[];
  /** Options whose value is the next word, unless written in the option's own word (`-rfs`, `--require=fs`). */
  readonly valued: readonly string[];
  /** Single-letter options whose value can only be written in their own word, the rest of it (`-i.bak`, `-x/dir`). */
  readonly attached: readonly string[];
  /** Single-letter options whose value is the octal digits written after them (`-0777`, `-l0`), the cluster going on. */
  readonly octal: readonly string[];
  /** Options after which no program runs: a version, help, or a syntax check that runs nothing. */
  readonly inert: readonly string[];
  /** Options whose value names something else that runs, a module or a package script: no program given as text. */
  readonly runs: readonly string[];
  /** Whether single-letter options combine in one word (`-Bc`, `-ne`). */
  readonly clusters: boolean;
  /** Whether, given no script, it reads its program from stdin. */
  readonly bare: boolean;
  /** Where its first operand names what runs: subcommands taking the program as text, from stdin, or a script. */
  readonly subcommands?: { readonly inline: readonly string[]; readonly stdin: readonly string[]; readonly script: readonly string[] };
}

const NODE: Grammar = {
  inline: ['-e', '--eval', '-p', '--print', '-pe'],
  valued: [
    '-r', '--require', '--import', '-C', '--conditions', '--loader', '--experimental-loader', '--input-type', '--inspect-port', '--debug-port',
    '--env-file', '--env-file-if-exists', '--title', '--redirect-warnings', '--diagnostic-dir', '--disable-warning', '--disable-proto',
    '--dns-result-order', '--heapsnapshot-signal', '--heapsnapshot-near-heap-limit', '--heap-prof-dir', '--heap-prof-interval',
    '--heap-prof-name', '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name', '--icu-data-dir', '--openssl-config',
    '--localstorage-file', '--max-http-header-size', '--max-old-space-size-percentage', '--network-family-autoselection-attempt-timeout',
    '--report-directory', '--report-dir', '--report-filename', '--report-signal', '--secure-heap', '--secure-heap-min', '--snapshot-blob',
    '--build-snapshot-config', '--experimental-config-file', '--experimental-default-type', '--experimental-sea-config',
    '--experimental-test-isolation', '--inspect-publish-uid', '--allow-fs-read', '--allow-fs-write', '--test-concurrency',
    '--test-coverage-branches', '--test-coverage-exclude', '--test-coverage-functions', '--test-coverage-include', '--test-coverage-lines',
    '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-shard', '--test-skip-pattern', '--test-timeout',
    '--tls-cipher-list', '--tls-keylog', '--trace-event-categories', '--trace-event-file-pattern', '--trace-require-module',
    '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--watch-kill-signal', '--watch-path',
  ],
  attached: [],
  octal: [],
  inert: ['-v', '--version', '-h', '--help', '-c', '--check', '--v8-options'],
  runs: ['--run'],
  clusters: false,
  bare: true,
};

const PYTHON: Grammar = {
  inline: ['-c'],
  valued: ['-W', '-X', '--check-hash-based-pycs'],
  attached: [],
  octal: [],
  inert: ['-V', '--version', '-h', '-?', '--help', '--help-env', '--help-xoptions', '--help-all'],
  runs: ['-m'],
  clusters: true,
  bare: true,
};

const RUBY: Grammar = {
  inline: ['-e'],
  valued: [
    '-I', '-r', '-C', '-E', '--encoding', '--external-encoding', '--internal-encoding', '--enable', '--disable', '--dump', '--parser',
    '--backtrace-limit', '--crash-report',
  ],
  attached: ['-F', '-i', '-x', '-W', '-K', '-T'],
  octal: ['-0'],
  inert: ['-v', '--version', '-h', '--help', '-c', '--copyright'],
  runs: [],
  clusters: true,
  bare: true,
};

/** `-c` checks syntax but runs BEGIN and CHECK blocks: a program, not inert. */
const PERL: Grammar = {
  inline: ['-e', '-E'],
  valued: ['-I', '-M', '-m'],
  attached: ['-C', '-d', '-D', '-F', '-i', '-V', '-x'],
  octal: ['-0', '-l'],
  inert: ['-v', '-h'],
  runs: [],
  clusters: true,
  bare: true,
};

/** `bun exec` runs its text in Bun's shell: read as a shell's `-c`. Given nothing, bun prints its help. */
const BUN: Grammar = {
  inline: ['-e', '--eval', '-p', '--print'],
  valued: [
    '--cwd', '-r', '--preload', '--env-file', '-c', '--config', '--tsconfig-override', '-d', '--define', '-l', '--loader', '--conditions',
    '--main-fields', '--port', '--install', '-F', '--filter', '--elide-lines', '--shell', '--extension-order', '--console-depth',
    '--jsx-factory', '--jsx-fragment', '--jsx-import-source', '--jsx-runtime', '--user-agent', '--max-http-header-size',
  ],
  attached: [],
  octal: [],
  inert: ['-v', '--version', '-h', '--help', '--revision'],
  runs: [],
  clusters: false,
  bare: false,
  subcommands: { inline: [], stdin: ['repl'], script: ['run'] },
};

/** Given nothing, deno opens its REPL on stdin. */
const DENO: Grammar = {
  inline: [],
  valued: [
    '-c', '--config', '--import-map', '--location', '--seed', '--cert', '--lock', '--env-file', '-L', '--log-level', '--ext',
    '--watch-exclude', '--inspect-wait',
  ],
  attached: [],
  octal: [],
  inert: ['-V', '--version', '-h', '--help'],
  runs: [],
  clusters: false,
  bare: true,
  subcommands: { inline: ['eval'], stdin: ['repl'], script: ['run', 'serve'] },
};

const INTERPRETERS = {
  node: NODE, nodejs: NODE, python: PYTHON, python3: PYTHON, ruby: RUBY, perl: PERL, bun: BUN, deno: DENO,
} as const satisfies Readonly<Record<string, Grammar>>;

/** The grammar of the program a word names, read by its file name. */
function grammarOf(word: string): Grammar | undefined {
  const name = basename(word);

  return Object.entries(INTERPRETERS).find(([named]) => named === name)?.[1];
}

/** A shell's `-c` makes its first operand the program; its own options with values. */
const SHELLS: readonly string[] = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'];

const SHELL_VALUED: readonly string[] = ['-o', '+o', '-O', '+O', '--rcfile', '--init-file'];

/** Words that run a command named later among their own arguments, whose options are not parsed here: every later word
 *  naming a program is read as where that command may start. */
const RUNNERS: readonly string[] = [
  'sudo', 'doas', 'command', 'exec', 'time', 'nice', 'nohup', 'env', 'timeout', 'xargs', 'stdbuf', 'setsid', 'ionice', 'chrt', 'taskset',
  'find', 'watch',
];

/** A word as the shell hands it on, quotes removed; null where the shell would expand it. */
type Word = string | null;

/** Each command substitution in a word, a program the shell runs too. */
function substitutions(parts: readonly WordPart[]): string[] {
  return parts.flatMap((part) => (part.commandSubstitution === undefined ? [] : [part.commandSubstitution]));
}

function literal(parts: readonly WordPart[]): Word {
  let text = '';

  for (const part of parts) {
    if (part.commandSubstitution !== undefined) return null;

    if (part.quoted !== 'single' && /[$`]/u.test(part.text)) return null;

    // A glob: `*`, `?`, or a bracket expression `[...]`, which only a closing `]` makes one (`[` alone is a command).
    if (part.quoted === 'none' && (/[*?]|\[[^\]]*\]/u.test(part.text) || (text === '' && part.text.startsWith('~')))) return null;
    text += part.text;
  }

  return text;
}

/** Whether a program at `words[at]` runs a program given as text; `appended`: its stdin is not its program (xargs). */
function runsAt(words: readonly Word[], at: number, redirections: readonly RedirectionNode[], appended: boolean): boolean {
  const head = words[at];

  // A name the shell expands may be any interpreter: read its arguments as any interpreter's.
  if (head === null || head === undefined) {
    return head === null && words.slice(at + 1).some((word) => word !== null && Object.values(INTERPRETERS).some((grammar) => grammar.inline.includes(word)));
  }

  const name = basename(head);
  const grammar = grammarOf(head);

  if (grammar !== undefined) return readsInline(grammar, words.slice(at + 1), !appended);

  if (SHELLS.includes(name)) return shellRuns(words.slice(at + 1), redirections);

  if (name === 'eval') return words.slice(at + 1).every((word) => word !== null) && runsInlineProgram(words.slice(at + 1).join(' '));

  if (!RUNNERS.includes(name)) return false;

  // `command -v node` names a program; it runs none.
  if (name === 'command' && words.slice(at + 1).some((word) => word === '-v' || word === '-V')) return false;

  return words.some((word, index) => index > at && word !== null && runsAt(words, index, redirections, appended || name === 'xargs'));
}

/** An option word read by `grammar`: what it means, and whether it takes the next word as its value. */
type Read = 'inline' | 'inert' | 'runs' | { readonly takesNext: boolean };

function readOption(grammar: Grammar, word: string): Read {
  const [name = word] = word.startsWith('--') ? word.split('=', 1) : [word];

  if (word.startsWith('--') || !grammar.clusters) {
    const given = word.includes('=');

    if (grammar.inline.includes(name)) return 'inline';

    if (grammar.inert.includes(name)) return 'inert';

    if (grammar.runs.includes(name)) return 'runs';

    return { takesNext: !given && grammar.valued.includes(name) };
  }

  // A cluster: each letter in turn, until one takes the rest of the word, or the next word, as its value.
  for (let index = 1; index < word.length; index++) {
    const option = `-${word.charAt(index)}`;
    const rest = word.slice(index + 1);

    if (grammar.inline.includes(option)) return 'inline';

    if (grammar.inert.includes(option)) return 'inert';

    if (grammar.runs.includes(option)) return 'runs';

    if (grammar.valued.includes(option)) return { takesNext: rest === '' };

    if (grammar.attached.includes(option)) return { takesNext: false };

    // Perl's `-0` also takes a hexadecimal value, after an `x`.
    if (grammar.octal.includes(option)) index += /^(?:x[0-9a-fA-F]*|[0-7]*)/u.exec(rest)?.[0].length ?? 0;
  }

  return { takesNext: false };
}

/** Whether `grammar`'s interpreter, given `args`, runs a program given as text; `bare`: with no script, stdin's. */
function readsInline(grammar: Grammar, args: readonly Word[], stdin: boolean): boolean {
  let operandSeen = false;

  for (let index = 0; index < args.length; index++) {
    const word = args[index];

    // A word the shell expands may be options or a script: read on past it.
    if (word === null || word === undefined) {
      operandSeen = true;
      continue;
    }

    if (word === '-') return stdin;

    if (word === '--') return index + 1 >= args.length && !operandSeen && grammar.bare && stdin;

    if (word.startsWith('-') && word.length > 1) {
      const read = readOption(grammar, word);

      if (read === 'inline') return true;

      if (read === 'inert' || read === 'runs') return false;

      if (read.takesNext) index += 1;
      continue;
    }

    if (operandSeen) return false;
    const sub = grammar.subcommands;

    if (sub === undefined) return false;

    // The first operand names what runs.
    if (sub.inline.includes(word)) return true;

    if (sub.stdin.includes(word)) return stdin;

    if (!sub.script.includes(word)) return false;

    return readsInline({ ...grammar, bare: false, subcommands: undefined }, args.slice(index + 1), stdin);
  }

  return !operandSeen && grammar.bare && stdin;
}

/** A shell's `-c` program, or the heredoc it reads its script from, read as a command in its own right. */
function shellRuns(args: readonly Word[], redirections: readonly RedirectionNode[]): boolean {
  let program = false;

  for (let index = 0; index < args.length; index++) {
    const word = args[index];

    if (word === null || word === undefined) return false;

    if (SHELL_VALUED.includes(word)) {
      index += 1;
      continue;
    }

    if (/^-[a-zA-Z]*c[a-zA-Z]*$/u.test(word)) {
      program = true;
      continue;
    }

    if (word.startsWith('-') || word.startsWith('+')) continue;

    return program && runsInlineProgram(word);
  }

  return redirections.some((redirection) => redirection.heredoc !== undefined && runsInlineProgram(redirection.heredoc.body));
}

function simpleRuns(command: SimpleCommandNode): boolean {
  const nested = [
    ...command.words.flatMap(substitutions),
    ...command.assignments.flatMap((assignment) => [...substitutions(assignment.value), ...(assignment.elements ?? []).flatMap(substitutions)]),
    ...command.redirections.flatMap((redirection) => substitutions(redirection.target)),
    // An unquoted heredoc's body is expanded, its substitutions run.
    ...command.redirections.flatMap((redirection) => (redirection.heredoc === undefined || redirection.heredoc.quoted ? [] : bodySubstitutions(redirection.heredoc.body))),
  ];

  if (nested.some((program) => runsInlineProgram(program))) return true;
  const words = command.words.map(literal);

  return words.length > 0 && runsAt(words, 0, command.redirections, false);
}

/** The command substitutions an expanded heredoc body runs; the lexer reads any text, never refusing it. */
function bodySubstitutions(body: string): string[] {
  return lex(body).flatMap((token) => substitutions(token.parts ?? []));
}

function compoundRuns(node: CompoundCommandNode): boolean {
  switch (node.type) {
    case 'simple_command': return simpleRuns(node);
    case 'double_bracket': return node.words.flatMap(substitutions).some(runsInlineProgram);
    case 'if': return node.clauses.some((clause) => listsRun(clause.condition) || listsRun(clause.body)) || (node.elseBody !== null && listsRun(node.elseBody));
    case 'for': return (node.words ?? []).flatMap(substitutions).some(runsInlineProgram) || listsRun(node.body);
    case 'while':
    case 'until': return listsRun(node.condition) || listsRun(node.body);
    case 'case': return substitutions(node.word).some(runsInlineProgram) || node.items.some((item) => listsRun(item.body));
    case 'group':
    case 'subshell': return listsRun(node.body);
    case 'function_def': return compoundRuns(node.body);
  }
}

function listsRun(lists: readonly ListNode[]): boolean {
  return lists.some((list) => list.entries.some((entry) => entry.pipeline.commands.some(compoundRuns)));
}

export function runsInlineProgram(command: string): boolean {
  // The parser refuses a command it cannot read with ParseError; any other throw is a defect, and surfaces.
  const script = settleSync(Effect.catchCause(Effect.sync(() => parse(lex(command))), (cause) => (
    Cause.squash(cause) instanceof ParseError ? Effect.succeed(null) : Effect.failCause(cause))));

  // A command this parser cannot read (bash's `<(...)`) asks whenever any word of it names an interpreter or a shell.
  if (script === null) return command.split(/[\s;&|()<>`$"']+/u).some((word) => grammarOf(word) !== undefined || SHELLS.includes(basename(word)));

  return listsRun(script.lists);
}
