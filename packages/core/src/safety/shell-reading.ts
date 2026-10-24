/**
 * A command line as the shell reads it, for the approval review: Nimbus's own shell parser (the workspace's shell, which
 * reads bash's grammar), walked into the simple commands it would run, with their words, redirections and pipelines. A
 * command a shell's `-c` script or heredoc holds is read too, and the command a wrapper (`sudo`, `xargs`, `find -exec`)
 * runs. What the reading cannot follow, it says: a program it does not read (another language's, a later shell's), an
 * expansion that runs a command it did not read, a script it could not parse. The review then judges the text as well,
 * and asks the owner about what runs that the reading could not resolve.
 */

import { Effect } from 'effect';
import { expandBraceWord } from '@nimbus-sh/core/substrate/lifo/shell/expander.js';
import { lex, lexArrayElements } from '@nimbus-sh/core/substrate/lifo/shell/lexer.js';
import { parse, ParseError } from '@nimbus-sh/core/substrate/lifo/shell/parser.js';
import { TokenKind, type Token } from '@nimbus-sh/core/substrate/lifo/shell/types.js';
import type { CompoundCommandNode, ListNode, RedirectionNode, SimpleCommandNode, WordPart } from '@nimbus-sh/core/substrate/lifo/shell/types.js';
import { settleSync } from '../obs/effect';

export interface ShellWord {
  /** As the shell takes it, quotes removed and braces expanded; null where it would expand it further (`$`, a
   *  substitution, an unquoted glob, a brace Nimbus leaves and bash expands). */
  readonly literal: string | null;
  /** Quotes removed, expansions as written: what a rule reads of a word it cannot know. */
  readonly text: string;
}

interface ShellRedirect {
  /** `>` or `&>`: the target is emptied first. */
  readonly truncates: boolean;
  /** `<` or `<>`: the command reads the target. */
  readonly reads: boolean;
  readonly target: ShellWord;
}

export interface ShellCommand {
  /** The program first, then its arguments; assignments before it are not words. */
  readonly words: readonly ShellWord[];
  readonly redirects: readonly ShellRedirect[];
  /** Its heredocs' bodies: what it reads on its input. */
  readonly heredocs: readonly string[];
}

/** Stages joined by `|`, each reading the one before: every command a stage runs, a compound's or a substitution's,
 *  reads what the stage reads. */
type ShellPipeline = readonly (readonly ShellCommand[])[];

/** What a command line runs, pipeline by pipeline in the order written, a substitution's before its command's. */
export interface ShellReading {
  readonly pipelines: readonly ShellPipeline[];
  /** False where a pipeline stage is a compound command, or a command runs that the reading did not read. */
  readonly followed: boolean;
  /** Why what runs is not known before it runs, each as the owner reads it. */
  readonly unresolved: readonly string[];
  /** The functions the line defines. */
  readonly functions: readonly string[];
}

/** What a reading cannot resolve, as the owner is told it. */
export const UNRESOLVED = {
  parse: 'the line cannot be parsed',
  expansion: 'a command inside an expansion it does not read',
  program: 'a program named by an expansion',
  script: 'a script built from an expansion, or one it cannot parse',
  piped: 'a script piped into a shell',
  defined: 'a function or alias the line defines',
  wrapped: 'a wrapper whose program it cannot find',
} as const;

/** A command a review judges, and where it stands: its stage in its pipeline, and the first and last stage at which each
 *  program the pipeline runs stands, read once for the pipeline. */
export interface CommandRun {
  readonly command: ShellCommand;
  readonly stage: number;
  readonly stages: ReadonlyMap<string, { readonly first: number; readonly last: number }>;
}

/** What a word's open characters hold that the shell expands: a parameter, a substitution, a glob (`[` only where a `]`
 *  closes it) or a brace bash expands, across quotes as Nimbus does not (`{a,"b"}`, `{1..3}`). */
const EXPANDS = /[$`*?]|\[.*\]|\{.*(?:,|\.\.).*\}/su;

/** A character quotes keep as written. */
const QUOTED = '\u0000';

/** Text that may run a command when expanded, in a part the lexer left whole (`${v:-$(…)}`, `$(( $(…) ))`, `<(…)`). */
const RUNS_WHEN_EXPANDED = /\$\(|`|[<>]\(/u;

/** Of that, what does run one: a `$(` that opens no arithmetic, or a backtick. */
const RUNS_COMMAND = /\$\((?!\()|`/u;

/** Outside quotes, a process substitution runs one too. */
const SUBSTITUTES_PROCESS = /[<>]\(/u;

/** Whether a part runs a command the reading did not read as a substitution of its own. A single-quoted part runs
 *  nothing. */
const runsUnread = (part: WordPart): boolean => part.quoted !== 'single' && part.commandSubstitution === undefined && RUNS_WHEN_EXPANDED.test(part.text);

function wordOf(written: readonly WordPart[]): ShellWord {
  // `$"…"`, a locale quote, which lifo reads as a `$` before a quoted string, is that string where no catalog
  // translates it, as under `LC_ALL=C`.
  const parts = written.map((part, at) => (part.quoted === 'none' && part.text.endsWith('$') && written[at + 1]?.quoted === 'double'
    ? { ...part, text: part.text.slice(0, -1) }
    : part));

  const text = parts.map((part) => part.text).join('');

  const open = parts.map((part) => {
    if (part.quoted === 'none') return part.text;

    // Double quotes keep only their `$` and backticks open.
    return part.quoted === 'double' ? part.text.replace(/[^$`]/gu, QUOTED) : QUOTED.repeat(part.text.length);
  });

  const expands = parts.some((part) => part.commandSubstitution !== undefined) || EXPANDS.test(open.join(''));

  return { literal: expands ? null : text, text };
}

/** The most words a brace may expand one word into before the reading leaves it unexpanded, and so unknown: each
 *  `{a,b}` doubles the product, and the review decides a line inside a Worker's 128 MB. */
const BRACE_WORDS = 1024;

/** At most how many words a word's unquoted braces expand it into, past {@link BRACE_WORDS} where it stops counting. */
function braceProduct(parts: readonly WordPart[]): number {
  let product = 1;

  for (const part of parts) {
    if (part.quoted !== 'none') continue;
    const commas: number[] = [];

    for (const ch of part.text) {
      if (ch === '{') commas.push(0);
      else if (ch === ',' && commas.length > 0) commas.push((commas.pop() ?? 0) + 1);
      else if (ch === '}' && commas.length > 0) product *= (commas.pop() ?? 0) + 1;

      if (product > BRACE_WORDS) return product;
    }
  }

  return product;
}

/** The words one written word is, its braces expanded as Nimbus expands them, or one unknown word past
 *  {@link BRACE_WORDS}. */
function wordsOf(parts: readonly WordPart[]): ShellWord[] {
  if (braceProduct(parts) > BRACE_WORDS) return [{ literal: null, text: parts.map((part) => part.text).join('') }];

  return expandBraceWord([...parts]).map(wordOf);
}

/** What the walk collects: each pipeline, and whether every stage was a command it holds. */
interface Walk {
  readonly pipelines: ShellPipeline[];
  followed: boolean;
  readonly unresolved: string[];
  readonly functions: string[];
  /** A heredoc lifo ends where bash would not: the commands after it are unknown. */
  misread: boolean;
  /** How many substitutions deep the walk stands. */
  depth: number;
}

/** Text the walk holds but did not read; where it runs a command, what that runs is unknown before it runs. */
function unread(walk: Walk, runs: boolean): void {
  walk.followed = false;

  if (runs) walk.unresolved.push(UNRESOLVED.expansion);
}

/** The deepest a substitution is read: each is parsed again from its own text, so past a few no accident nests. */
const SUBSTITUTION_DEPTH = 8;

/** Heredocs lifo ends elsewhere than bash does: a delimiter in locale quotes (`<<$"EOF"`), which lifo reads with its
 *  `$`, and a line holding a carriage return, which bash keeps in the delimiter and lifo strips from the body. */
const HEREDOC_MISREAD = /<<-?[ \t]*\$"|<<[^\n]*\r|\r[^\n]*<</u;

/** What `read` makes of a line through lifo's lexer or parser, or null where they read none. */
function lexed<T>(read: () => T): Effect.Effect<T | null> {
  return Effect.try({ try: read, catch: (cause) => ({ cause }) }).pipe(
    // Its lexer and parser throw nothing else, but a line nested past the stack is one no reading here can make.
    Effect.catchIf((failed) => failed.cause instanceof ParseError || failed.cause instanceof RangeError, () => Effect.succeed(null)),
    Effect.catch((failed) => Effect.die(failed.cause)),
  );
}

/** `text` as the shell's grammar reads it, or null where it reads none: lifo refuses a few constructs bash runs
 *  (`<<<`, `select`) and ends a few heredocs elsewhere than bash, so null is not bash's verdict, only this reading's. */
export function readShell(text: string): ShellReading | null {
  if (HEREDOC_MISREAD.test(text)) return null;

  return settleSync(lexed((): ShellReading | null => {
    const walk: Walk = { pipelines: [], followed: true, unresolved: [], functions: [], misread: false, depth: 0 };
    const tokens = lex(text);
    let read = text;

    // A process substitution, which lifo's grammar refuses, is read as a substitution running the same command: `<(…)`
    // as `$(…)`, and `>(…)`, whose command reads what is written to it, as `$(: | …)`. Rewritten last to first, so each
    // position still holds.
    for (const [at, token] of [...tokens.entries()].reverse()) {
      const next = tokens[at + 1];

      if ((token.kind === TokenKind.RedirectIn || token.kind === TokenKind.RedirectOut) && token.fd === undefined && next?.kind === TokenKind.LParen
        && next.pos === token.pos + 1) read = `${read.slice(0, token.pos)}$(${token.kind === TokenKind.RedirectOut ? ': | ' : ''}${read.slice(next.pos + 1)}`;
    }

    readLists(parse(read).lists, walk);

    return walk.misread ? null : walk;
  }));
}

function readLists(lists: readonly ListNode[], walk: Walk): void {
  for (const list of lists) {
    for (const { pipeline } of list.entries) {
      const piped = pipeline.commands.length > 1;
      const stages: ShellCommand[][] = [];

      for (const node of pipeline.commands) {
        const stage: ShellCommand[] = [];
        const before = walk.pipelines.length;

        if (node.type !== 'simple_command' && piped) walk.followed = false;
        readCompound(node, stage, walk);

        // What a compound stage or a substitution runs reads the stage's pipe too: `curl … | (bash)`. Each once, though
        // its own pipeline nested inside holds it already.
        if (piped) stage.push(...new Set(walk.pipelines.slice(before).flat(2)));
        stages.push(stage);
      }

      if (stages.some((stage) => stage.length > 0)) walk.pipelines.push(stages);
    }
  }
}

/** The programs a word's `$(…)` and backticks run, read before the command that holds them. A syntax error in one is
 *  the whole line's, as it is bash's. */
function readSubstitutions(parts: readonly WordPart[], walk: Walk): void {
  for (const part of parts) {
    if (runsUnread(part)) unread(walk, RUNS_COMMAND.test(part.text) || (part.quoted === 'none' && SUBSTITUTES_PROCESS.test(part.text)));

    if (part.commandSubstitution === undefined) continue;

    if (walk.depth >= SUBSTITUTION_DEPTH) {
      unread(walk, true);

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
  if (texts.some((text) => text !== undefined && RUNS_WHEN_EXPANDED.test(text))) unread(walk, texts.some((text) => text !== undefined && RUNS_COMMAND.test(text)));
}

/** A simple command read into its stage: its words, the substitutions every part of it runs, its redirections. */
function readSimple(node: SimpleCommandNode, stage: ShellCommand[], walk: Walk): void {
  const elements = node.assignments.flatMap((assignment) => assignment.elements ?? []);

  for (const parts of [...node.assignments.map((assignment) => assignment.value), ...elements.map((element) => element.word), ...node.words]) {
    readSubstitutions(parts, walk);
  }

  readArithmetic([...node.assignments.map((assignment) => assignment.subscript), ...elements.map((element) => element.subscript)], walk);

  for (const redirect of node.redirections) readSubstitutions(redirect.target, walk);

  // An unquoted heredoc is expanded before its command reads it: a substitution in one runs, for any program.
  const expanded = node.redirections.flatMap(({ heredoc }) => (heredoc !== undefined && !heredoc.quoted ? [heredoc.body] : []));

  if (expanded.some((body) => RUNS_WHEN_EXPANDED.test(body))) unread(walk, expanded.some((body) => RUNS_COMMAND.test(body)));

  // Bash joins an unquoted heredoc's continued lines before it looks for the delimiter; lifo looks line by line.
  if (node.redirections.some(({ heredoc }) => heredoc !== undefined && !heredoc.quoted && heredoc.body.includes('\\\n'))) walk.misread = true;
  stage.push(stageOf(node.words, node.redirections));
}

function stageOf(words: readonly WordPart[][], redirections: readonly RedirectionNode[]): ShellCommand {
  return {
    words: words.flatMap(wordsOf),
    redirects: redirections.flatMap(redirectOf),
    heredocs: redirections.flatMap((redirect) => (redirect.heredoc === undefined ? [] : [redirect.heredoc.body])),
  };
}

/** `node` read into `stage`, its stage of its pipeline; any list it holds is read into `walk`. A compound command's own
 *  redirections stand as a command of their own, so a file they truncate is one its commands write. */
function readCompound(node: CompoundCommandNode, stage: ShellCommand[], walk: Walk): void {
  switch (node.type) {
    case 'simple_command':
      readSimple(node, stage, walk);

      return;
    case 'function_def':
      walk.functions.push(node.name);
      readCompound(node.body, stage, walk);

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

  if (node.redirections.length > 0) stage.push(stageOf([], node.redirections));
}

function redirectOf(redirect: RedirectionNode): ShellRedirect[] {
  if (redirect.operator === 'heredoc' || redirect.operator === 'dupOutput' || redirect.operator === 'dupInput') return [];

  return [{
    truncates: redirect.operator === 'write' || redirect.operator === 'writeAll',
    reads: redirect.operator === 'read' || redirect.operator === 'readWrite',
    target: wordOf(redirect.target),
  }];
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
  return settleSync(lexed(() => {
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

          if (array === null) words.push(...wordsOf(parts));
          else read(lexArrayElements(array[1] ?? ''), depth + 1, scoped);
        }
      }

      end();
    };

    read(lex(text), 0, false);

    return whole ? runs : null;
  }));
}

/** The line as the shell reads its words, quotes joined and braces expanded, its operators as written: what a rule's
 *  signature reads where a word is written in pieces and no grammar reads the line. Null where the lexer reads none. */
export function joinedWords(text: string): string | null {
  return settleSync(lexed(() => lex(text).map((token) => (token.kind === TokenKind.Word ? wordsOf(token.parts ?? []).map((word) => word.text).join(' ') : token.value)).join(' ')));
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

/** Builtins that hand the shell a script of their own, as the words it is read from after they expand: `eval`'s words
 *  joined, `trap`'s action, an alias's value. */
function laterScripts(program: string, command: ShellCommand): ShellWord[][] {
  const words = command.words.slice(1);

  if (program === 'eval') return [words];

  if (program === 'trap') return [words.slice(0, 1)];

  if (program === 'alias') {
    return words.flatMap(({ literal, text }) => (text.includes('=') ? [[{ literal: literal?.slice(literal.indexOf('=') + 1) ?? null, text: text.slice(text.indexOf('=') + 1) }]] : []));
  }

  return [];
}

/** A short-option cluster that holds `-c`, whose next word is the script: `-c`, `-lc`, `-ec`. */
const SCRIPT_FLAG = /^-[a-z]*c[a-z]*$/u;

/** The scripts a shell is handed as words: the word after a `-c` flag, and before it any word it cannot know, which
 *  may be the flag and its script. The words after a script are its arguments. */
function shellScripts(command: ShellCommand): ShellWord[][] {
  const scripts: ShellWord[][] = [];

  for (const [at, word] of command.words.entries()) {
    if (at === 0) continue;

    if (word.literal === null) scripts.push([word]);
    else if (SCRIPT_FLAG.test(word.literal)) return [...scripts, command.words.slice(at + 1, at + 2)];
  }

  return scripts;
}

/** How many of a wrapper's argv suffixes are read: an option's value comes before its command, and no wrapper takes
 *  more than a few. Past them what it runs is unknown. */
const WRAPPED_SUFFIXES = 6;

/** A word that sets a variable for the command after it, where `env` and `sudo` take one, never their program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** The words a wrapper takes before its program, past its options and their values: `timeout`'s duration, `chroot`'s
 *  directory, `docker run`'s image. */
const WRAPPER_OPERANDS: ReadonlyMap<string, number> = new Map([['timeout', 1], ['chroot', 1], ['flock', 1], ['docker', 3], ['podman', 3], ['kubectl', 3]]);

/** find's actions that run a command, whose words run to a `;` or a `+`. */
const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * The argv suffixes that start where a wrapper's program may, the first {@link WRAPPED_SUFFIXES}: one of them is the
 * wrapped command, and reading every one over-collects, which only asks more. A program may start at every word not an
 * option nor an assignment, and at a word the shell expands until the program's place has passed (the wrapper's own
 * operands and the word after them, counting none an option before it may have taken, nor any word it expands, which
 * may be none). A wrapper standing where its program may opens a place of its own (`command timeout 30 "$p"`), each
 * read once. find runs only what its actions name, each to its `;` or `+`.
 */
function wrappedSuffixes(program: string, command: ShellCommand) {
  const found = new Set<number>();
  const opened = new Set<number>();

  const startsAfter = (wrapper: string, from: number): void => {
    let passed = 0;

    for (const [at, { literal }] of command.words.entries()) {
      if (at <= from || literal?.startsWith('-') === true || (literal !== null && (wrapper === 'env' || wrapper === 'sudo') && ASSIGNMENT.test(literal))) continue;
      const action = FIND_ACTIONS.has(command.words[at - 1]?.literal ?? '');
      const open = wrapper === 'find' ? action : passed <= (WRAPPER_OPERANDS.get(wrapper) ?? 0);
      const inner = literal?.slice(literal.lastIndexOf('/') + 1) ?? '';

      if ((literal !== null && wrapper !== 'find') || open) found.add(at);

      if (open && WRAPPERS.has(inner) && !opened.has(at)) {
        opened.add(at);
        startsAfter(inner, at);
      }

      if (literal !== null && command.words[at - 1]?.text.startsWith('-') !== true) passed += 1;
    }
  };

  startsAfter(program, 0);
  const starts = [...found].sort((a, b) => a - b);

  // `command -v` and `-V` name programs; they run none.
  if (program === 'command' && command.words.slice(1, starts[0]).some(({ literal }) => literal !== null && /^-[pvV]*[vV]/u.test(literal))) return { suffixes: [], whole: true };

  const suffix = (at: number) => {
    const words = command.words.slice(at);
    const end = program === 'find' ? words.findIndex(({ literal }) => literal === ';' || literal === '+') : -1;

    return end === -1 ? words : words.slice(0, end);
  };

  return { suffixes: starts.slice(0, WRAPPED_SUFFIXES).map(suffix), whole: starts.length <= WRAPPED_SUFFIXES };
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
  /** Why what runs is not known before it runs: what the review asks the owner about. */
  readonly unresolved: readonly string[];
}

/**
 * Every command `reading` runs, and every command a shell's script or a wrapper runs from one of them: what a review
 * judges. Each script is read once, a wrapper's suffixes are never read as wrappers again (a suffix of a suffix is one
 * already), and each pipeline's stage programs are read once for all its runs.
 */
export function commandsRun(reading: ShellReading): CommandsRun {
  const runs: CommandRun[] = [];
  const read = new Set<string>();
  const unresolved = new Set<string>();
  const defined = new Set<string>();
  let followed = reading.followed;

  const unknown = (why: string) => {
    followed = false;
    unresolved.add(why);
  };

  const handed = (script: string) => {
    if (read.has(script)) return;

    if (read.size >= SCRIPT_BUDGET) {
      unknown(UNRESOLVED.script);

      return;
    }

    read.add(script);
    const nested = readShell(script);

    if (nested === null) unknown(UNRESOLVED.script);
    else visit(nested);
  };

  // The shell parses a script it is handed after expanding the words it is made of: one that expands is unknown, and is
  // still read as written, so what it surely runs keeps its rule.
  const handedWords = (words: readonly ShellWord[]) => {
    if (words.some((word) => word.literal === null)) unknown(UNRESOLVED.script);

    handed(words.map((word) => word.literal ?? word.text).join(' '));
  };

  const run = (command: ShellCommand, stage: number, wrapped: boolean, into: ShellCommand[][]) => {
    (into[stage] ??= []).push(command);
    const program = programOf(command);

    if (command.words.length > 0 && program === null) unknown(UNRESOLVED.program);

    if (program === null) return;

    if (UNREAD_PROGRAMS.has(program)) followed = false;

    if (SHELLS.has(program)) {
      const scripts = shellScripts(command);

      // With no script of its own, a shell reads one from its input: the pipe it stands in, or a file it cannot know
      // (`bash < <(…)`).
      if (scripts.length === 0 && command.heredocs.length === 0
        && (stage > 0 || command.redirects.some(({ reads, target }) => reads && target.literal === null))) unknown(UNRESOLVED.piped);

      for (const script of scripts) handedWords(script);

      for (const heredoc of command.heredocs) handed(heredoc);
    }

    for (const script of laterScripts(program, command)) handedWords(script);

    // `source` and `.` read the script a word names: one a command's output names is piped in (`source <(curl …)`).
    if ((program === 'source' || program === '.') && command.words.slice(1).some(({ literal, text }) => literal === null && /\$\(|`/u.test(text))) unknown(UNRESOLVED.piped);

    if (program === 'alias') for (const { text } of command.words.slice(1)) if (text.indexOf('=') > 0) defined.add(text.slice(0, text.indexOf('=')));

    if (!wrapped && WRAPPERS.has(program)) {
      const { suffixes, whole } = wrappedSuffixes(program, command);

      if (!whole) unknown(UNRESOLVED.wrapped);

      for (const words of suffixes) run({ words, redirects: command.redirects, heredocs: command.heredocs }, stage, true, into);
    }
  };

  const visit = (nested: ShellReading) => {
    followed &&= nested.followed;

    for (const why of nested.unresolved) unknown(why);

    for (const name of nested.functions) defined.add(name);

    for (const pipeline of nested.pipelines) {
      const byStage: ShellCommand[][] = [];

      for (const [stage, commands] of pipeline.entries()) {
        byStage[stage] ??= [];

        for (const command of commands) run(command, stage, false, byStage);
      }

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

  // A name the line defines runs what its definition holds, with words this reading does not carry into it.
  if (runs.some(({ command }) => defined.has(programOf(command) ?? ''))) unknown(UNRESOLVED.defined);

  return { runs, followed, unresolved: [...unresolved] };
}
