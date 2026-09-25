/**
 * The context paths a GitHub Actions `${{ … }}` expression reads, from the
 * expression grammar GitHub documents for workflows
 * (https://docs.github.com/en/actions/reference/workflows-and-actions/expressions):
 *
 *   expression := or
 *   or         := and ('||' and)*
 *   and        := compare ('&&' compare)*
 *   compare    := unary (('==' | '!=' | '<' | '<=' | '>' | '>=') unary)*
 *   unary      := '!' unary | postfix
 *   postfix    := primary ('.' (name | '*') | '[' expression ']')*
 *   primary    := literal | name '(' (expression (',' expression)*)? ')' | name | '(' expression ')'
 *   literal    := 'null' | 'true' | 'false' | number | "'" ("''" | any but "'")* "'"
 *   name       := letter (letter | digit | '_' | '-')*
 *
 * Property names are case-insensitive, so a path is lowercased. An index that
 * is not a string literal is `*`: it may select any property. A call's name is
 * a function, not a context, and is not a path.
 */

export type ContextPath = readonly string[];

type Token =
  | { readonly kind: 'name'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'number' | 'punct'; readonly text: string };

const PUNCTUATORS = ['==', '!=', '<=', '>=', '&&', '||', '(', ')', '[', ']', '.', ',', '!', '<', '>', '*'];

const isNameStart = (char: string): boolean => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';

const isDigit = (char: string): boolean => char >= '0' && char <= '9';

/** Tokens from `from` up to the closing `}}`, and the offset just past it. */
function tokenize(text: string, from: number) {
  const tokens: Token[] = [];
  let at = from;

  while (at < text.length) {
    const char = text[at];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      at += 1;
    } else if (text.startsWith('}}', at)) {
      return { tokens, end: at + 2 };
    } else if (char === "'") {
      let value = '';
      at += 1;

      for (;;) {
        if (at >= text.length) throw new Error(`expression: unterminated string in ${text.slice(from - 3)}`);

        if (text[at] === "'" && text[at + 1] === "'") {
          value += "'";
          at += 2;
        } else if (text[at] === "'") {
          at += 1;
          break;
        } else {
          value += text[at];
          at += 1;
        }
      }

      tokens.push({ kind: 'string', text: value });
    } else if (isNameStart(char)) {
      const start = at;

      while (at < text.length && (isNameStart(text[at]) || isDigit(text[at]) || text[at] === '-')) at += 1;
      tokens.push({ kind: 'name', text: text.slice(start, at) });
    } else if (isDigit(char) || (char === '-' && isDigit(text[at + 1] ?? ''))) {
      const start = at;
      at += 1;

      while (at < text.length && (isDigit(text[at]) || text[at] === '.' || isNameStart(text[at]))) at += 1;
      tokens.push({ kind: 'number', text: text.slice(start, at) });
    } else {
      const punct = PUNCTUATORS.find((candidate) => text.startsWith(candidate, at));

      if (punct === undefined) throw new Error(`expression: unexpected ${JSON.stringify(char)} in ${text.slice(from - 3)}`);
      tokens.push({ kind: 'punct', text: punct });
      at += punct.length;
    }
  }

  throw new Error(`expression: unterminated \${{ in ${text.slice(from - 3)}`);
}

/** What an operand is, as far as a path cares: a context path, a string literal, or anything else. */
type Operand = { readonly path: string[] } | { readonly literal: string } | undefined;

function readPaths(tokens: readonly Token[], source: string): ContextPath[] {
  const paths: ContextPath[] = [];
  let at = 0;

  const peek = (text: string): boolean => tokens[at]?.kind === 'punct' && tokens[at]?.text === text;

  const expect = (text: string): void => {
    if (!peek(text)) throw new Error(`expression: expected ${text} in ${source}`);
    at += 1;
  };

  const binary = (operators: readonly string[], operand: () => Operand): Operand => {
    let left = operand();

    while (operators.some(peek)) {
      at += 1;
      operand();
      left = undefined;
    }

    return left;
  };

  const expression = (): Operand => binary(['||'], () => binary(['&&'], () => binary(['==', '!=', '<=', '>=', '<', '>'], unary)));

  function unary(): Operand {
    if (peek('!')) {
      at += 1;
      unary();

      return undefined;
    }

    const operand = primary();
    const path = operand !== undefined && 'path' in operand ? operand.path : undefined;

    for (;;) {
      if (peek('.')) {
        at += 1;
        const next = tokens[at];

        if (next?.kind !== 'name' && !(next?.kind === 'punct' && next.text === '*')) {
          throw new Error(`expression: expected a property name in ${source}`);
        }

        path?.push(next.kind === 'name' ? next.text.toLowerCase() : '*');
        at += 1;
      } else if (peek('[')) {
        at += 1;
        const index = expression();
        expect(']');
        path?.push(index !== undefined && 'literal' in index ? index.literal.toLowerCase() : '*');
      } else {
        if (path !== undefined) paths.push(path);

        return path === undefined ? operand : { path };
      }
    }
  }

  function primary(): Operand {
    const token = tokens[at];

    if (token === undefined) throw new Error(`expression: unexpected end of ${source}`);
    at += 1;

    if (token.kind === 'string') return { literal: token.text };

    if (token.kind === 'number') return undefined;

    if (token.kind === 'punct') {
      if (token.text !== '(') throw new Error(`expression: unexpected ${token.text} in ${source}`);
      const inner = expression();
      expect(')');

      return inner === undefined || 'literal' in inner ? inner : { path: [...inner.path] };
    }

    if (peek('(')) {
      at += 1;

      while (!peek(')')) {
        expression();

        if (!peek(')')) expect(',');
      }

      at += 1;

      return undefined;
    }

    const name = token.text.toLowerCase();

    return name === 'null' || name === 'true' || name === 'false' ? undefined : { path: [name] };
  }

  expression();

  if (at !== tokens.length) throw new Error(`expression: unexpected ${tokens[at]?.text ?? ''} in ${source}`);

  return paths;
}

/** Every context path read by any `${{ … }}` in `text`. Text outside the delimiters is not an expression. */
export function contextPaths(text: string): ContextPath[] {
  const paths: ContextPath[] = [];
  let at = text.indexOf('${{');

  while (at !== -1) {
    const { tokens, end } = tokenize(text, at + 3);
    paths.push(...readPaths(tokens, text.slice(at, end)));
    at = text.indexOf('${{', end);
  }

  return paths;
}
