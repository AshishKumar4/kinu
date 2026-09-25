/**
 * Shell text as pipelines of commands of words, for the gates that ask what a
 * `package.json` script or a workflow `run:` body executes. No shell parser is
 * installed, so this is an owned reader over the subset of POSIX sh and bash
 * those files use:
 *
 *   script    := (separator | pipeline)*
 *   separator := ';' | ';;' | '&' | '&&' | '||' | newline | '(' | ')'
 *   pipeline  := command (('|' | '|&') command)*
 *   command   := (word | redirect)*
 *   redirect  := digit* ('<' | '<<<' | '<>' | '<&' | '>' | '>>' | '>&' | '>|') word | '&>' word | '&>>' word
 *              | digit* ('<<' | '<<-') word      the here-document body up to the delimiter line is data
 *   word      := (char | '\' char | '\' newline | "'" .* "'" | "$'" .* "'" | '"' (char | '\' char | expansion)* '"'
 *                | expansion | NAME '=(' balanced ')')+
 *   expansion := '$(' script ')' | '`' script '`' | '<(' script ')' | '>(' script ')'   (at word start for '<(' '>(')
 *              | '$((' balanced '))' | '${' balanced '}'
 *   comment   := '#' at word start, to the end of the line
 *
 * A word is its decoded value: quotes removed, escapes resolved, expansions kept
 * as their source text. Commands inside a substitution are read as a script of
 * their own and attached to the command whose word or redirect holds them.
 * An unterminated quote or substitution throws: a reader that guessed where it
 * ends would hand the gate a different program from the one the shell runs.
 */

export interface ShellCommand {
  readonly words: readonly string[];
  /** Pipelines run by `$(…)`, backticks, `<(…)` or `>(…)` inside this command. */
  readonly substitutions: ShellScript;
}

export type ShellPipeline = readonly ShellCommand[];

export type ShellScript = readonly ShellPipeline[];

interface Reader {
  readonly text: string;
  at: number;
  readonly heredocs: { readonly delimiter: string; readonly stripTabs: boolean }[];
}

const BLANK = new Set([' ', '\t']);

const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);

const REDIRECTS = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>&', '>|', '>'];

export function parseShell(text: string): ShellScript {
  const reader: Reader = { text, at: 0, heredocs: [] };

  return readScript(reader, undefined);
}

function readScript(reader: Reader, close: ')' | '`' | undefined): ShellScript {
  const { text } = reader;
  const script: ShellPipeline[] = [];
  let pipeline: ShellCommand[] = [];
  let words: string[] = [];
  let substitutions: ShellPipeline[] = [];

  const endCommand = (): void => {
    if (words.length > 0 || substitutions.length > 0) pipeline.push({ words, substitutions });
    words = [];
    substitutions = [];
  };

  const endPipeline = (): void => {
    endCommand();

    if (pipeline.length > 0) script.push(pipeline);
    pipeline = [];
  };

  while (reader.at < text.length) {
    const char = text[reader.at];
    const next = text[reader.at + 1];

    if (char === close) {
      reader.at += 1;
      endPipeline();

      return script;
    }

    if (BLANK.has(char)) {
      reader.at += 1;
    } else if (char === '\\' && next === '\n') {
      reader.at += 2;
    } else if (char === '\n') {
      reader.at += 1;
      endPipeline();
      skipHeredocBodies(reader);
    } else if (char === '#') {
      while (reader.at < text.length && text[reader.at] !== '\n') reader.at += 1;
    } else if (char === '|') {
      reader.at += next === '|' || next === '&' ? 2 : 1;

      if (next === '|') endPipeline(); else endCommand();
    } else if (char === '&' && next === '>') {
      reader.at += text[reader.at + 2] === '>' ? 3 : 2;
      substitutions.push(...readRedirectTarget(reader, close));
    } else if (char === ';' || char === '&' || char === '(' || char === ')') {
      reader.at += (char === ';' || char === '&') && next === char ? 2 : 1;
      endPipeline();
    } else if (redirectAt(reader) !== undefined) {
      const operator = redirectAt(reader) ?? '';
      reader.at += operator.length;

      if (operator === '<<' || operator === '<<-') {
        const delimiter = readWord(reader, [], close);
        reader.heredocs.push({ delimiter, stripTabs: operator === '<<-' });
      } else {
        substitutions.push(...readRedirectTarget(reader, close));
      }
    } else {
      words.push(readWord(reader, substitutions, close));
    }
  }

  if (close !== undefined) throw new Error(`shell: unterminated ${close === '`' ? '`…`' : '$(…)'} substitution`);
  endPipeline();

  return script;
}

/** The redirect operator at the cursor, digits included, or undefined. `<(` and `>(` are substitutions. */
function redirectAt(reader: Reader): string | undefined {
  const { text } = reader;
  let digits = reader.at;

  while (text[digits] !== undefined && text[digits] >= '0' && text[digits] <= '9') digits += 1;
  const operator = REDIRECTS.find((candidate) => text.startsWith(candidate, digits));

  if (operator === undefined) return undefined;

  if (digits === reader.at && (operator === '<' || operator === '>') && text[digits + 1] === '(') return undefined;

  return text.slice(reader.at, digits + operator.length);
}

function readRedirectTarget(reader: Reader, close: ')' | '`' | undefined): ShellScript {
  const substitutions: ShellPipeline[] = [];

  while (BLANK.has(reader.text[reader.at] ?? '')) reader.at += 1;
  readWord(reader, substitutions, close);

  return substitutions;
}

function skipHeredocBodies(reader: Reader): void {
  const { text } = reader;

  for (const { delimiter, stripTabs } of reader.heredocs.splice(0)) {
    while (reader.at < text.length) {
      const end = text.indexOf('\n', reader.at);
      const line = text.slice(reader.at, end === -1 ? text.length : end);
      reader.at = end === -1 ? text.length : end + 1;

      let indent = 0;

      while (stripTabs && line[indent] === '\t') indent += 1;

      if (line.slice(indent) === delimiter) break;
    }
  }
}

function readWord(reader: Reader, substitutions: ShellPipeline[], close: ')' | '`' | undefined): string {
  const { text } = reader;
  let value = '';

  while (reader.at < text.length) {
    const char = text[reader.at];
    const next = text[reader.at + 1];

    if (char === close) break;

    if ((char === '<' || char === '>') && next === '(' && value === '') {
      value += readSubstitution(reader, 2, ')', substitutions);
      continue;
    }

    if (char === '(' && value.endsWith('=') && ASSIGNMENT.test(value)) {
      value += readBalanced(reader, '(', ')');
      continue;
    }

    if (WORD_END.has(char)) break;

    if (char === '\\') {
      value += next === '\n' ? '' : (next ?? '');
      reader.at += 2;
    } else if (char === "'") {
      value += readUntil(reader, reader.at + 1, "'");
    } else if (char === '$' && next === "'") {
      value += readAnsiC(reader);
    } else if (char === '"') {
      value += readDoubleQuoted(reader, substitutions);
    } else if (char === '$' || char === '`') {
      value += readExpansion(reader, substitutions);
    } else {
      value += char;
      reader.at += 1;
    }
  }

  return value;
}

/** `$(…)`, `$((…))`, `${…}`, or a backtick substitution at the cursor, returned as its source text. */
function readExpansion(reader: Reader, substitutions: ShellPipeline[]): string {
  const { text } = reader;

  if (text[reader.at] === '`') return readSubstitution(reader, 1, '`', substitutions);

  if (text.startsWith('$((', reader.at)) {
    const start = reader.at;
    reader.at += 1;
    readBalanced(reader, '(', ')');

    return text.slice(start, reader.at);
  }

  if (text.startsWith('$(', reader.at)) return readSubstitution(reader, 2, ')', substitutions);

  if (text.startsWith('${', reader.at)) {
    reader.at += 1;

    return `$${readBalanced(reader, '{', '}')}`;
  }

  reader.at += 1;

  return '$';
}

function readSubstitution(reader: Reader, open: number, close: ')' | '`', substitutions: ShellPipeline[]): string {
  const start = reader.at;
  reader.at += open;
  substitutions.push(...readScript(reader, close));

  return reader.text.slice(start, reader.at);
}

function readDoubleQuoted(reader: Reader, substitutions: ShellPipeline[]): string {
  const { text } = reader;
  let value = '';
  reader.at += 1;

  while (reader.at < text.length) {
    const char = text[reader.at];
    const next = text[reader.at + 1] ?? '';

    if (char === '"') {
      reader.at += 1;

      return value;
    }

    if (char === '\\' && '$`"\\\n'.includes(next)) {
      value += next === '\n' ? '' : next;
      reader.at += 2;
    } else if (char === '$' || char === '`') {
      value += readExpansion(reader, substitutions);
    } else {
      value += char;
      reader.at += 1;
    }
  }

  throw new Error('shell: unterminated double quote');
}

function readAnsiC(reader: Reader): string {
  const { text } = reader;
  let value = '';
  reader.at += 2;

  while (reader.at < text.length) {
    const char = text[reader.at];

    if (char === "'") {
      reader.at += 1;

      return value;
    }

    value += char === '\\' ? (text[reader.at + 1] ?? '') : char;
    reader.at += char === '\\' ? 2 : 1;
  }

  throw new Error("shell: unterminated $'…' quote");
}

function readUntil(reader: Reader, from: number, quote: string): string {
  const end = reader.text.indexOf(quote, from);

  if (end === -1) throw new Error(`shell: unterminated ${quote} quote`);
  reader.at = end + 1;

  return reader.text.slice(from, end);
}

/** A bracketed run from the opener at the cursor through its matching closer, quotes respected. */
function readBalanced(reader: Reader, open: string, close: string): string {
  const { text } = reader;
  const start = reader.at;
  let depth = 0;

  while (reader.at < text.length) {
    const char = text[reader.at];

    if (char === "'") {
      readUntil(reader, reader.at + 1, "'");
      continue;
    }

    if (char === '"') {
      readDoubleQuoted(reader, []);
      continue;
    }

    reader.at += char === '\\' ? 2 : 1;

    if (char === open) depth += 1;

    if (char === close) depth -= 1;

    if (depth === 0) return text.slice(start, reader.at);
  }

  throw new Error(`shell: unterminated ${open}…${close}`);
}

/** Words that precede a command without being it. */
const PREFIX_WORDS = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time', '{', '[[']);

/** Programs that run their first non-option argument as the command. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'nice', 'bunx', 'npx', 'pnpx', 'xargs']);

const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/u;

export interface Invocation {
  /** The program's basename: `/bin/sh` and `sh` are one program. */
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * The program a command runs and its arguments, past reserved words, variable
 * assignments, and wrappers that run their argument (`sudo`, `env`, `bunx`,
 * `bun x`). A wrapper option that takes a separate value (`sudo -u root`) is
 * read as the program; no gate here depends on one.
 */
export function invocation(command: ShellCommand): Invocation | undefined {
  let words = command.words;
  let wrapped = false;

  for (;;) {
    const [head, ...rest] = words;

    if (head === undefined) return undefined;

    if (PREFIX_WORDS.has(head) || ASSIGNMENT.test(head) || (wrapped && head.startsWith('-'))) {
      words = rest;
      continue;
    }

    const program = head.slice(head.lastIndexOf('/') + 1);

    if (WRAPPERS.has(program) || (program === 'bun' && rest[0] === 'x')) {
      words = program === 'bun' ? rest.slice(1) : rest;
      wrapped = true;
      continue;
    }

    return { program, args: rest };
  }
}

/** Every command in the script, substitutions included, depth first. */
export function allCommands(script: ShellScript): ShellCommand[] {
  return script.flat().flatMap((command) => [command, ...allCommands(command.substitutions)]);
}
