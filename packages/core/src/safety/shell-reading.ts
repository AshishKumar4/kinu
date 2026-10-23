/**
 * A command line as the shell reads it, for the approval review: Nimbus's own shell parser (the workspace's shell, which
 * reads bash's grammar), walked into the simple commands it would run, with their words, redirections and pipelines. A
 * command a shell's `-c` script or heredoc holds is read too, and the command a wrapper (`sudo`, `xargs`, `find -exec`)
 * runs. What the reading cannot follow, it says: a program it does not read (another language's, a later shell's), an
 * expansion that runs a command it did not read, a script it could not parse. The review then judges the text as well.
 */

import { Effect } from 'effect';
import { lex, lexArrayElements } from '@nimbus-sh/core/substrate/lifo/shell/lexer.js';
import { parse, ParseError } from '@nimbus-sh/core/substrate/lifo/shell/parser.js';
import { TokenKind, type Token } from '@nimbus-sh/core/substrate/lifo/shell/types.js';
import type { CompoundCommandNode, ListNode, RedirectionNode, SimpleCommandNode, WordPart } from '@nimbus-sh/core/substrate/lifo/shell/types.js';
import { settleSync } from '../obs/effect';

export interface ShellWord {
  /** As the shell takes it, quotes removed; null where it would expand it (`$`, a substitution, an unquoted glob). */
  readonly literal: string | null;
  /** Quotes removed, expansions as written: what a rule reads of a word it cannot know. */
  readonly text: string;
}

interface ShellRedirect {
  /** `>` or `&>`: the target is emptied first. */
  readonly truncates: boolean;
  readonly target: ShellWord;
}

export interface ShellCommand {
  /** The program first, then its arguments; assignments before it are not words. */
  readonly words: readonly ShellWord[];
  readonly redirects: readonly ShellRedirect[];
  /** Its heredocs' bodies: what it reads on its input. */
  readonly heredocs: readonly string[];
}

/** Commands joined by `|`, each reading the one before. */
type ShellPipeline = readonly ShellCommand[];

/** What a command line runs, pipeline by pipeline in the order written, a substitution's before its command's. */
export interface ShellReading {
  readonly pipelines: readonly ShellPipeline[];
  /** False where a pipeline stage is a compound command, whose own commands the stages do not hold. */
  readonly followed: boolean;
}

/** A command a review judges, and where it stands: its stage in its pipeline, and the first and last stage at which each
 *  program the pipeline runs stands, read once for the pipeline. */
export interface CommandRun {
  readonly command: ShellCommand;
  readonly stage: number;
  readonly stages: ReadonlyMap<string, { readonly first: number; readonly last: number }>;
}

/** What an unquoted word holds that the shell expands: a parameter, a substitution or a glob. */
const UNQUOTED_EXPANSION = /[$`*?[]/u;

/** Text that runs a command when expanded, in a part the lexer left whole (`${v:-$(…)}`, `$(( $(…) ))`, `<(…)`). */
const RUNS_WHEN_EXPANDED = /\$\(|`|[<>]\(/u;

/** Whether a part runs a command the reading did not read as a substitution of its own. A single-quoted part runs
 *  nothing. */
const runsUnread = (part: WordPart): boolean => part.quoted !== 'single' && part.commandSubstitution === undefined && RUNS_WHEN_EXPANDED.test(part.text);

function wordOf(parts: readonly WordPart[]): ShellWord {
  const text = parts.map((part) => part.text).join('');

  const expands = parts.some((part) => part.commandSubstitution !== undefined
    || (part.quoted === 'double' && (part.text.includes('$') || part.text.includes('`')))
    || (part.quoted === 'none' && UNQUOTED_EXPANSION.test(part.text)));

  return { literal: expands ? null : text, text };
}

/** What the walk collects: each pipeline, and whether every stage was a command it holds. */
interface Walk {
  readonly pipelines: ShellPipeline[];
  followed: boolean;
  /** How many substitutions deep the walk stands. */
  depth: number;
}

/** The deepest a substitution is read: each is parsed again from its own text, so past a few no accident nests. */
const SUBSTITUTION_DEPTH = 8;

/** `text` as the shell's grammar reads it, or null where it reads none: lifo refuses a few constructs bash runs
 *  (`<<<`, `select`), so null is not bash's verdict, only this reading's. */
export function readShell(text: string): ShellReading | null {
  return settleSync(Effect.try({
    try: (): ShellReading => {
      const walk: Walk = { pipelines: [], followed: true, depth: 0 };

      readLists(parse(text).lists, walk);

      return walk;
    },
    catch: (cause) => ({ cause }),
  }).pipe(
    // Its lexer and parser throw nothing else, but a line nested past the stack is one no reading here can make.
    Effect.catchIf((failed) => failed.cause instanceof ParseError || failed.cause instanceof RangeError, () => Effect.succeed(null)),
    Effect.catch((failed) => Effect.die(failed.cause)),
  ));
}

function readLists(lists: readonly ListNode[], walk: Walk): void {
  for (const list of lists) {
    for (const { pipeline } of list.entries) {
      const stages: ShellCommand[] = [];

      for (const node of pipeline.commands) {
        if (node.type !== 'simple_command' && pipeline.commands.length > 1) walk.followed = false;
        readCompound(node, stages, walk);
      }

      if (stages.length > 0) walk.pipelines.push(stages);
    }
  }
}

/** The programs a word's `$(…)` and backticks run, read before the command that holds them. A syntax error in one is
 *  the whole line's, as it is bash's. */
function readSubstitutions(parts: readonly WordPart[], walk: Walk): void {
  for (const part of parts) {
    if (runsUnread(part)) walk.followed = false;

    if (part.commandSubstitution === undefined) continue;

    if (walk.depth >= SUBSTITUTION_DEPTH) {
      walk.followed = false;

      continue;
    }

    walk.depth += 1;
    readLists(parse(part.commandSubstitution).lists, walk);
    walk.depth -= 1;
  }
}

/** Arithmetic a command evaluates at run time (a subscript, `(( ))`, a `for (( ))` header): one that runs a command is
 *  unread here. */
function readArithmetic(texts: readonly (string | undefined)[], walk: Walk): void {
  if (texts.some((text) => text !== undefined && RUNS_WHEN_EXPANDED.test(text))) walk.followed = false;
}

/** A simple command read into `stages`: its words, the substitutions every part of it runs, its redirections. */
function readSimple(node: SimpleCommandNode, stages: ShellCommand[], walk: Walk): void {
  const elements = node.assignments.flatMap((assignment) => assignment.elements ?? []);

  for (const parts of [...node.assignments.map((assignment) => assignment.value), ...elements.map((element) => element.word), ...node.words]) {
    readSubstitutions(parts, walk);
  }

  readArithmetic([...node.assignments.map((assignment) => assignment.subscript), ...elements.map((element) => element.subscript)], walk);

  for (const redirect of node.redirections) readSubstitutions(redirect.target, walk);

  // An unquoted heredoc is expanded before its command reads it: a substitution in one runs, for any program.
  if (node.redirections.some(({ heredoc }) => heredoc !== undefined && !heredoc.quoted && RUNS_WHEN_EXPANDED.test(heredoc.body))) walk.followed = false;
  stages.push(stageOf(node.words, node.redirections));
}

function stageOf(words: readonly WordPart[][], redirections: readonly RedirectionNode[]): ShellCommand {
  return {
    words: words.map(wordOf),
    redirects: redirections.flatMap(redirectOf),
    heredocs: redirections.flatMap((redirect) => (redirect.heredoc === undefined ? [] : [redirect.heredoc.body])),
  };
}

/** `node` read into `stages`, its own pipeline's; any list it holds is read into `walk`. A compound command's own
 *  redirections stand as a stage of their own, so a file they truncate is one its commands write. */
function readCompound(node: CompoundCommandNode, stages: ShellCommand[], walk: Walk): void {
  switch (node.type) {
    case 'simple_command':
      readSimple(node, stages, walk);

      return;
    case 'function_def':
      readCompound(node.body, stages, walk);

      return;
    case 'if':
      readLists([...node.clauses.flatMap((clause) => [...clause.condition, ...clause.body]), ...node.elseBody ?? []], walk);
      break;
    case 'for':
      for (const parts of node.words ?? []) readSubstitutions(parts, walk);
      readLists(node.body, walk);
      break;
    case 'while':
    case 'until':
      readLists([...node.condition, ...node.body], walk);
      break;
    case 'case':
      for (const parts of [node.word, ...node.items.flatMap((item) => item.patterns)]) readSubstitutions(parts, walk);
      readLists(node.items.flatMap((item) => item.body), walk);
      break;
    case 'arithmetic_for':
      readArithmetic([node.init, node.test, node.step], walk);
      readLists(node.body, walk);
      break;
    case 'group':
    case 'subshell':
      readLists(node.body, walk);
      break;
    case 'double_bracket':
      for (const parts of node.words) readSubstitutions(parts, walk);
      break;
    case 'arithmetic':
      readArithmetic([node.expression], walk);
      break;
  }

  for (const redirect of node.redirections) readSubstitutions(redirect.target, walk);

  if (node.redirections.length > 0) stages.push(stageOf([], node.redirections));
}

function redirectOf(redirect: RedirectionNode): ShellRedirect[] {
  if (redirect.operator === 'heredoc' || redirect.operator === 'dupOutput' || redirect.operator === 'dupInput') return [];

  return [{ truncates: redirect.operator === 'write' || redirect.operator === 'writeAll', target: wordOf(redirect.target) }];
}

/** Tokens that end a run of words: an operator, a list break, a grouping parenthesis. */
const BREAKS: ReadonlySet<TokenKind> = new Set([
  TokenKind.Pipe, TokenKind.And, TokenKind.Or, TokenKind.Semi, TokenKind.Amp, TokenKind.Newline, TokenKind.DoubleSemi,
  TokenKind.LParen, TokenKind.RParen, TokenKind.EOF,
]);

/** A run of words between two operators, and whether it stands in the line's own scope or a scope of its own (a
 *  substitution's, a script's), whose `cd` moves nothing after it. */
export interface WordRun {
  readonly words: readonly ShellWord[];
  readonly scoped: boolean;
}

/** An array literal's words, `(a b)` in `name=(a b)`, as bash's reader reads them. */
const ARRAY_LITERAL = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=\((.*)\)$/su;

/**
 * Every word `text` holds, by the shell's lexer, in runs between its operators and in order: a loop's list, a case's
 * word, an array's elements, a redirection's target, a heredoc's words and a substitution's words among them. What
 * reaches a path is read here, where no word the grammar holds outside a command is lost; null where the lexer reads
 * none, or substitutions nest past {@link SUBSTITUTION_DEPTH}.
 */
export function wordRuns(text: string): WordRun[] | null {
  return settleSync(Effect.try({
    try: () => {
      const runs: WordRun[] = [];
      let whole = true;

      const read = (tokens: readonly Token[], depth: number, scoped: boolean) => {
        let words: ShellWord[] = [];

        const end = () => {
          if (words.length > 0) runs.push({ words, scoped });
          words = [];
        };

        for (const token of tokens) {
          if (BREAKS.has(token.kind)) end();
          else if (token.kind === TokenKind.HeredocBody) {
            // Its words are a script's when a shell reads it, text when another program does: read either way.
            if (depth >= SUBSTITUTION_DEPTH) whole = false;
            else read(lex(token.value), depth + 1, true);
          } else if (token.kind === TokenKind.Word) {
            const parts = token.parts ?? [];

            for (const part of parts) {
              if (part.commandSubstitution === undefined) continue;

              if (depth >= SUBSTITUTION_DEPTH) whole = false;
              else read(lex(part.commandSubstitution), depth + 1, true);
            }

            const array = ARRAY_LITERAL.exec(token.source ?? token.value);

            if (array === null) words.push(wordOf(parts));
            else read(lexArrayElements(array[1] ?? ''), depth + 1, scoped);
          }
        }

        end();
      };

      read(lex(text), 0, false);

      return whole ? runs : null;
    },
    catch: (cause) => ({ cause }),
  }).pipe(
    Effect.catchIf((failed) => failed.cause instanceof ParseError || failed.cause instanceof RangeError, () => Effect.succeed(null)),
    Effect.catch((failed) => Effect.die(failed.cause)),
  ));
}

/** One word as a shell reads it, its quotes and backslash escapes undone (a path a terminal pasted: `my\\ shot.png`,
 *  `"my shot.png"`); null for text that is no single word. */
export function readShellWord(text: string): string | null {
  const runs = wordRuns(text);
  const [word, ...rest] = runs?.length === 1 ? runs[0]?.words ?? [] : [];

  return word === undefined || rest.length > 0 ? null : word.text;
}

/** A program's name as a rule asks for it: the last segment of its word, null where the word expands. */
export function programOf(command: ShellCommand): string | null {
  const program = command.words[0]?.literal ?? null;

  return program === null ? null : program.slice(program.lastIndexOf('/') + 1);
}

/** Programs whose arguments name another command to run, by argv. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo', 'doas', 'command', 'builtin', 'exec', 'time', 'nice', 'nohup', 'timeout', 'xargs', 'env', 'stdbuf', 'ionice',
  'chroot', 'setsid', 'unshare', 'flock', 'find', 'docker', 'podman', 'kubectl', 'busybox',
]);

/** Shells, which run a `-c` script or their heredoc; `script -c` runs one under a terminal. */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'su', 'script']);

/** Builtins that hand the shell a script of their own: `eval`'s words joined, `trap`'s action, an alias's value. */
function laterScripts(program: string, command: ShellCommand): string[] {
  const words = command.words.slice(1);

  if (program === 'eval') return [words.map((word) => word.text).join(' ')];

  if (program === 'trap') return words.slice(0, 1).map((word) => word.text);

  if (program === 'alias') return words.flatMap((word) => (word.text.includes('=') ? [word.text.slice(word.text.indexOf('=') + 1)] : []));

  return [];
}

/** A short-option cluster that holds `-c`, whose next word is the script: `-c`, `-lc`, `-ec`. */
const SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/u;

/** The scripts a shell is handed: the word after a `-c` flag, and its heredocs' bodies. */
function shellScripts(command: ShellCommand): string[] {
  const flagged = command.words.flatMap((word, at) => {
    const script = command.words[at + 1]?.literal ?? null;

    return at > 0 && word.literal !== null && script !== null && SCRIPT_FLAG.test(word.literal) ? [script] : [];
  });

  return [...flagged, ...command.heredocs];
}

/** How many of a wrapper's argv suffixes are read: an option's value comes before its command, and no wrapper takes
 *  more than a few. Past them the reading stops following. */
const WRAPPED_SUFFIXES = 6;

/** The argv suffixes that start at a word not an option, the first {@link WRAPPED_SUFFIXES}: one of them is the wrapped
 *  command, and reading every one over-collects, which only asks more. */
function wrappedSuffixes(command: ShellCommand) {
  const starts = command.words.flatMap((word, at) => (at > 0 && word.literal !== null && !word.literal.startsWith('-') ? [at] : []));

  return { suffixes: starts.slice(0, WRAPPED_SUFFIXES).map((at) => command.words.slice(at)), whole: starts.length <= WRAPPED_SUFFIXES };
}

/** Programs whose argument is a program this reading does not read: another language's, another machine's or a
 *  clock's, or one a dispatcher picks (`env -S`, `xargs`, `find -exec`, `parallel`). A shell's own is read, and still
 *  counted here, as the old review did, since lifo reads a few constructs bash runs otherwise. */
const UNREAD_PROGRAMS: ReadonlySet<string> = new Set([
  'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'bun', 'deno', 'php', 'lua', 'awk', 'gawk', 'osascript',
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'su', 'script', 'eval', 'alias', 'trap', 'source', '.', 'builtin',
  'busybox', 'xargs', 'ssh', 'env', 'nohup', 'timeout', 'watch', 'find', 'docker', 'parallel',
]);

/** The most scripts one review reads: a line nests no deeper by accident, and past it the reading stops following. */
const SCRIPT_BUDGET = 64;

/** The commands a line runs, and whether the reading followed every one of them: false where a program it does not
 *  read, or a program word it cannot know, runs, or a script it was handed it could not read. */
export interface CommandsRun {
  readonly runs: readonly CommandRun[];
  readonly followed: boolean;
}

/**
 * Every command `reading` runs, and every command a shell's script or a wrapper runs from one of them: what a review
 * judges. Each script is read once, a wrapper's suffixes are never read as wrappers again (a suffix of a suffix is one
 * already), and each pipeline's stage programs are read once for all its runs.
 */
export function commandsRun(reading: ShellReading): CommandsRun {
  const runs: CommandRun[] = [];
  const read = new Set<string>();
  let followed = reading.followed;

  const handed = (script: string) => {
    if (read.has(script)) return;

    if (read.size >= SCRIPT_BUDGET) {
      followed = false;

      return;
    }

    read.add(script);
    const nested = readShell(script);

    if (nested === null) followed = false;
    else visit(nested);
  };

  const run = (command: ShellCommand, stage: number, wrapped: boolean, into: ShellCommand[][]) => {
    (into[stage] ??= []).push(command);
    const program = programOf(command);

    if (command.words.length > 0 && (program === null || UNREAD_PROGRAMS.has(program))) followed = false;

    if (program === null) return;

    if (SHELLS.has(program)) for (const script of shellScripts(command)) handed(script);

    for (const script of laterScripts(program, command)) handed(script);

    if (!wrapped && WRAPPERS.has(program)) {
      const { suffixes, whole } = wrappedSuffixes(command);

      followed &&= whole;

      for (const words of suffixes) run({ words, redirects: [], heredocs: command.heredocs }, stage, true, into);
    }
  };

  const visit = (nested: ShellReading) => {
    followed &&= nested.followed;

    for (const pipeline of nested.pipelines) {
      const byStage: ShellCommand[][] = [];

      for (const [stage, command] of pipeline.entries()) run(command, stage, false, byStage);
      const stages = new Map<string, { first: number; last: number }>();

      for (const [stage, commands] of byStage.entries()) {
        for (const command of commands) {
          const program = programOf(command);

          if (program === null) continue;
          const seen = stages.get(program);

          stages.set(program, { first: seen?.first ?? stage, last: stage });
        }
      }

      for (const [stage, commands] of byStage.entries()) for (const command of commands) runs.push({ command, stage, stages });
    }
  };

  visit(reading);

  return { runs, followed };
}
