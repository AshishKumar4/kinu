/**
 * SQL as the corpus spells it, read off the TypeScript syntax tree, and the SQL
 * parser the gates read it with.
 *
 * A string expression (a string literal, a template, a `+` of either) folds to
 * one text. A name it interpolates is followed to the `const` that binds it in
 * scope, through as many bindings as there are; any other interpolation becomes
 * a bound parameter `?` whose JavaScript source is kept, so a gate can show the
 * statement as written. The folded text is parsed by `sql-parser-cst` in its
 * SQLite dialect, so case, quoting, schema qualification and comments are the
 * parser's business, never a pattern's.
 */

import {
  cstVisitor, FormattedSyntaxError, type FullVisitorMap, parse as parseSql, type Node as SqlNode, type Program,
} from 'sql-parser-cst';
import { declaredName, literalString, parse, walk, type SyntaxNode } from './syntax';

/** An interpolation read as a parameter: `?` at `at` in the folded text. */
export interface Hole {
  readonly at: number;
  readonly source: string;
}

export interface SqlString {
  readonly node: SyntaxNode;
  readonly line: number;
  readonly text: string;
  readonly holes: readonly Hole[];
}

/** What a template has folded before an interpolation, and its literal chunk after it. */
export interface Around {
  readonly before: string;
  readonly after: string;
}

/** A gate's own reading of an interpolation the fold cannot follow: the text to
 *  splice in, or undefined to leave it a parameter. */
export type Expand = (expression: SyntaxNode, around: Around) => string | undefined;

interface Folded {
  readonly text: string;
  readonly holes: readonly Hole[];
}

/** Expressions that are their operand at runtime. */
export const UNWRAPPED = {
  ParenthesizedExpression: true, TSAsExpression: true, TSSatisfiesExpression: true, TSNonNullExpression: true,
} satisfies Record<string, true>;

const SCOPES = { Program: true, BlockStatement: true, StaticBlock: true } satisfies Record<string, true>;

const DECLARES_BY_ID = { FunctionDeclaration: true, ClassDeclaration: true, TSEnumDeclaration: true } satisfies Record<string, true>;

function joined(parts: readonly Folded[]): Folded {
  let text = '';
  const holes: Hole[] = [];

  for (const part of parts) {
    holes.push(...part.holes.map((hole) => ({ at: hole.at + text.length, source: hole.source })));
    text += part.text;
  }

  return { text, holes };
}

/** Whether `node` or any node under it is the identifier `name`: a binding
 *  pattern or parameter list that could shadow it. */
function binds(node: SyntaxNode, name: string): boolean {
  let found = false;

  walk(node, (child) => {
    if (child.raw.type === 'Identifier' && child.raw.name === name) found = true;
  });

  return found;
}

/**
 * The initializer of the `const` a reference to `name` at `from` resolves to, or
 * undefined when the nearest binding of that name is anything else: a `let` or
 * `var`, a parameter, a catch binding, an import, or nothing in this file.
 */
export function constInitializer(from: SyntaxNode, name: string): SyntaxNode | undefined {
  for (let scope = from.parent; scope !== undefined; scope = scope.parent) {
    const { raw } = scope;
    const caught = raw.type === 'CatchClause' ? raw.param : undefined;
    const parameters: readonly unknown[] = 'params' in raw ? raw.params : [caught];

    if (scope.children.some((child) => parameters.includes(child.raw) && binds(child, name))) return undefined;

    if (!Object.hasOwn(SCOPES, scope.type)) continue;

    for (const statement of scope.children) {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.children[0] : statement;

      if (declaration === undefined) continue;

      if (declaration.type === 'ImportDeclaration' && binds(declaration, name)) return undefined;

      if (Object.hasOwn(DECLARES_BY_ID, declaration.type) && declaredName(declaration) === name) return undefined;

      if (declaration.raw.type !== 'VariableDeclaration') continue;
      const { kind } = declaration.raw;

      for (const declarator of declaration.children) {
        const [id, init] = declarator.children;

        if (id === undefined || !binds(id, name)) continue;

        return kind === 'const' && id.raw.type === 'Identifier' ? init : undefined;
      }
    }
  }

  return undefined;
}

class Folder {
  private readonly following = new Set<SyntaxNode>();

  constructor(private readonly source: string, private readonly expand: Expand | undefined) {}

  private hole(node: SyntaxNode): Folded {
    return { text: '?', holes: [{ at: 0, source: this.source.slice(node.start, node.end) }] };
  }

  /** The string `node` evaluates to, or undefined when it is not a string this can follow. */
  fold(node: SyntaxNode): Folded | undefined {
    const { raw } = node;
    const literal = literalString(raw);

    if (literal !== undefined) return { text: literal, holes: [] };

    if (Object.hasOwn(UNWRAPPED, raw.type)) {
      const [inner] = node.children;

      return inner === undefined ? undefined : this.fold(inner);
    }

    if (raw.type === 'TemplateLiteral') return this.template(node);

    if (raw.type === 'BinaryExpression' && raw.operator === '+') {
      const [left, right] = node.children;

      if (left === undefined || right === undefined) return undefined;
      const folded = [this.fold(left), this.fold(right)];

      if (folded.every((part) => part === undefined)) return undefined;

      return joined([folded[0] ?? this.hole(left), folded[1] ?? this.hole(right)]);
    }

    if (raw.type !== 'Identifier') return undefined;
    const init = constInitializer(node, raw.name);

    if (init === undefined || this.following.has(init)) return undefined;
    this.following.add(init);
    const folded = this.fold(init);
    this.following.delete(init);

    return folded;
  }

  private template(node: SyntaxNode): Folded {
    const quasis = node.children.filter((child) => child.raw.type === 'TemplateElement');
    const expressions = node.children.filter((child) => child.raw.type !== 'TemplateElement');
    let folded: Folded = { text: '', holes: [] };

    for (const [index, quasi] of quasis.entries()) {
      const chunk = quasi.raw.type === 'TemplateElement' ? quasi.raw.value.cooked ?? quasi.raw.value.raw : '';
      folded = joined([folded, { text: chunk, holes: [] }]);
      const expression = expressions[index];

      if (expression === undefined) continue;
      const next = quasis[index + 1];
      const after = next?.raw.type === 'TemplateElement' ? next.raw.value.cooked ?? next.raw.value.raw : '';
      const spliced = this.expand?.(expression, { before: folded.text, after });
      const part = spliced === undefined ? this.fold(expression) ?? this.hole(expression) : { text: spliced, holes: [] };
      folded = joined([folded, part]);
    }

    return folded;
  }
}

const isPlus = (node: SyntaxNode | undefined): boolean =>
  node?.raw.type === 'BinaryExpression' && node.raw.operator === '+';

/**
 * Every string expression in one file, folded. An expression inside a larger
 * `+` is read as part of it; a template nested in an interpolation is read on
 * its own as well as where it is spliced.
 */
export function sqlStrings(file: string, source: string, expand?: Expand): SqlString[] {
  const tree = parse(file, source);
  const folder = new Folder(source, expand);
  const out: SqlString[] = [];

  walk(tree.root, (node) => {
    const { raw } = node;
    const stringy = raw.type === 'TemplateLiteral' || isPlus(node) || literalString(raw) !== undefined;

    if (!stringy || isPlus(node.parent)) return;
    const folded = folder.fold(node);

    if (folded !== undefined) out.push({ node, line: tree.lineAt(node.start), ...folded });
  });

  return out;
}

const WORD_START = /[A-Za-z_]/u;

const WORD_PART = /[A-Za-z0-9_]/u;

/**
 * The first `count` words of `text`, upper-cased, past the whitespace and SQL
 * comments before each. An owned grammar, `(trivia* word){count}` where trivia is
 * whitespace, `-- …\n` or `/* … *\/`, because the question is asked of text the
 * SQL parser has refused: whether it was meant to be a statement.
 */
export function leadingKeywords(text: string, count: number): string[] {
  const words: string[] = [];
  let i = 0;

  while (words.length < count && i < text.length) {
    const ch = text[i] ?? '';

    if (ch.trim() === '') i += 1;
    else if (text.startsWith('--', i)) i = text.includes('\n', i) ? text.indexOf('\n', i) + 1 : text.length;
    else if (text.startsWith('/*', i)) i = text.includes('*/', i + 2) ? text.indexOf('*/', i + 2) + 2 : text.length;
    else if (WORD_START.test(ch)) {
      let end = i;

      while (end < text.length && WORD_PART.test(text[end] ?? '')) end += 1;
      words.push(text.slice(i, end).toUpperCase());
      i = end;
    } else break;
  }

  return words;
}

/** The folded text with every hole read as a name, `FROM ${table}`: spelled `_`,
 *  one character like `?`, so every range the parser reports still holds. */
export function holesAsNames(sql: SqlString): string {
  let text = sql.text;

  for (const { at } of sql.holes) text = `${text.slice(0, at)}_${text.slice(at + 1)}`;

  return text;
}

/** The statements `text` holds, or undefined when it is not SQLite: prose, or a
 *  template whose interpolation sits where no parameter can. */
export function sqlProgram(text: string): Program | undefined {
  try {
    return parseSql(text, {
      dialect: 'sqlite', paramTypes: ['?', '?nr', ':name', '@name', '$name'], includeRange: true, includeComments: true,
    });
  } catch (error) {
    // A syntax error is this function's answer, not a failure; anything else is.
    if (error instanceof FormattedSyntaxError) return undefined;
    throw error;
  }
}

export type SqlStatement = Program['statements'][number];

/** Preorder over `node` and every node under it. `cstVisitor` calls
 *  `map[node.type]` on each node it enters, so a map that answers every type
 *  visits them all. */
export function sqlWalk(node: SqlNode, visit: (n: SqlNode) => void): void {
  cstVisitor(new Proxy<Partial<FullVisitorMap>>({}, { get: () => visit }))(node);
}

/** The unqualified name of an entity: `main."t"` answers `t`. */
export function entityName(node: SqlNode): string | undefined {
  if (node.type === 'identifier') return node.name.toLowerCase();

  if (node.type === 'member_expr' && node.property.type === 'identifier') return node.property.name.toLowerCase();

  return undefined;
}

/** The tables one relation operand names: a join's two sides, an alias's
 *  target, a parenthesized join. A subquery is left to the walk that reaches it. */
export function operandTables(node: SqlNode): string[] {
  if (node.type === 'alias') return operandTables(node.expr);

  if (node.type === 'join_expr') return [...operandTables(node.left), ...operandTables(node.right)];

  if (node.type === 'list_expr') return node.items.flatMap(operandTables);

  if (node.type === 'paren_expr') return operandTables(node.expr);

  if (node.type === 'indexed_table' || node.type === 'not_indexed_table' || node.type === 'partitioned_table') {
    return operandTables(node.table);
  }

  const name = entityName(node);

  return name === undefined ? [] : [name];
}

export interface Names {
  /** Every table or view a statement reads, writes, creates or drops; a CTE's own name is not one. */
  readonly tables: ReadonlySet<string>;
  readonly indexes: ReadonlySet<string>;
}

export function namesIn(node: SqlNode): Names {
  const tables = new Set<string>();
  const indexes = new Set<string>();
  const ctes = new Set<string>();

  const relation = (operand: SqlNode) => {
    for (const table of operandTables(operand)) tables.add(table);
  };

  const index = (name: SqlNode | undefined) => {
    const named = name === undefined ? undefined : entityName(name);

    if (named !== undefined) indexes.add(named);
  };

  cstVisitor({
    from_clause: (clause) => relation(clause.expr),
    insert_clause: (clause) => relation(clause.table),
    update_clause: (clause) => relation(clause.tables),
    delete_clause: (clause) => relation(clause.tables),
    alter_table_stmt: (statement) => relation(statement.table),
    trigger_target: (target) => relation(target.table),
    references_specification: (references) => relation(references.table),
    drop_table_stmt: (statement) => relation(statement.tables),
    drop_view_stmt: (statement) => relation(statement.views),
    create_table_stmt: (statement) => relation(statement.name),
    create_view_stmt: (statement) => relation(statement.name),
    create_index_stmt: (statement) => {
      relation(statement.table);
      index(statement.name);
    },
    drop_index_stmt: (statement) => {
      for (const name of statement.indexes.items) index(name);
    },
    common_table_expr: (cte) => {
      ctes.add(cte.table.name.toLowerCase());
    },
  })(node);

  for (const cte of ctes) tables.delete(cte);

  return { tables, indexes };
}

/** The ranges of every comment the parser attached to `node` or under it. */
export function commentRanges(node: SqlNode): [number, number][] {
  const ranges: [number, number][] = [];

  sqlWalk(node, (child) => {
    for (const trivia of [...child.leading ?? [], ...child.trailing ?? []]) {
      if ((trivia.type === 'line_comment' || trivia.type === 'block_comment') && trivia.range !== undefined) {
        ranges.push(trivia.range);
      }
    }
  });

  return ranges;
}

/**
 * The text of `range` as written: each comment in it dropped for a space, each
 * parameter a hole stands for shown as the `${…}` it was.
 */
export function writtenText(sql: SqlString, range: readonly [number, number], comments: readonly (readonly [number, number])[]): string {
  const [start, end] = range;

  const cuts = [
    ...comments.filter(([from, to]) => from >= start && to <= end).map(([from, to]) => ({ from, to, text: ' ' })),
    ...sql.holes.filter(({ at }) => at >= start && at < end).map(({ at, source }) => ({ from: at, to: at + 1, text: `\${${source}}` })),
  ].sort((a, b) => a.from - b.from);

  let out = '';
  let at = start;

  for (const cut of cuts) {
    out += sql.text.slice(at, cut.from) + cut.text;
    at = cut.to;
  }

  return out + sql.text.slice(at, end);
}
