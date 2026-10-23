/**
 * `db.sql`: one SQL statement over the workspace's shared tables. What a statement may reach is decided from the program
 * SQLite compiles for it (`EXPLAIN`), never from its text: every b-tree it opens, clears or changes must be a shared
 * table's or one of its indexes', and every opcode is one this gate classifies, so an opcode a SQLite upgrade adds is
 * refused until it is. The text is read only to keep it one statement, bind its `?` in order, address tables by their
 * names, and translate `CREATE TABLE` into a declaration.
 */

import { Effect } from 'effect';
import * as v from 'valibot';
import type { Impact } from '@agent-core/core/facets';
import { KinuError } from '../obs/error';
import type { AppColumnType } from '../operations/db';
import type { JsonValue } from '../utils/json';

interface Token {
  readonly kind: 'word' | 'quoted' | 'string' | 'number' | 'param' | 'punct' | 'space';
  readonly text: string;
  /** A word's or a quoted identifier's name, unquoted. */
  readonly name?: string;
}

/** SQLite's keywords: a bare one is never a table's name, whatever a table is called. */
const KEYWORDS = new Set(`ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN
  BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME
  CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT
  EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF
  IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT
  MATCH MATERIALIZED NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN
  PRAGMA PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT RETURNING
  RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION TRIGGER UNBOUNDED UNION
  UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT`.split(/\s+/u));

const WORD_START = /[A-Za-z_\u0080-\uffff]/u;

const WORD = /[A-Za-z0-9_$\u0080-\uffff]/u;

const refusal = (message: string): KinuError => new KinuError('bad_input', `db.sql: ${message}`);

/** The end of a quoted run opened at `at` by `quote`, its doubled quote an escape; null where it never closes. */
function closing(text: string, at: number, quote: string): number | null {
  for (let end = at + 1; end < text.length; end += 1) {
    if (text[end] !== quote) continue;

    if (text[end + 1] !== quote) return end + 1;
    end += 1;
  }

  return null;
}

/** One token at `at`, or why the text holds none there. */
function tokenAt(text: string, at: number): Token | KinuError {
  const char = text[at] ?? '';
  const next = text[at + 1] ?? '';
  let end = at + 1;

  const run = (test: (char: string) => boolean): number => {
    while (end < text.length && test(text[end] ?? '')) end += 1;

    return end;
  };

  if (/\s/u.test(char)) return { kind: 'space', text: text.slice(at, run((c) => /\s/u.test(c))) };

  if (char === '-' && next === '-') {
    const line = text.indexOf('\n', at);

    return { kind: 'space', text: text.slice(at, line < 0 ? text.length : line) };
  }

  if (char === '/' && next === '*') {
    const close = text.indexOf('*/', at + 2);

    return { kind: 'space', text: text.slice(at, close < 0 ? text.length : close + 2) };
  }

  if (char === "'" || char === '"' || char === '`' || char === '[') {
    const close = char === '[' ? (text.indexOf(']', at) + 1 || null) : closing(text, at, char);

    if (close === null) return refusal(`a ${char === "'" ? 'string' : 'quoted name'} opened at character ${String(at)} is never closed`);
    const quoted = text.slice(at, close);

    if (char === "'") return { kind: 'string', text: quoted };

    return { kind: 'quoted', text: quoted, name: char === '[' ? quoted.slice(1, -1) : quoted.slice(1, -1).replaceAll(char + char, char) };
  }

  if (char === '?' || char === ':' || char === '@' || char === '$') {
    run((c) => WORD.test(c));

    return end > at + 1 || char !== '?' ? refusal(`it binds \`?\` placeholders in order, from params; \`${text.slice(at, end)}\` is not one`) : { kind: 'param', text: '?' };
  }

  if (/[0-9]/u.test(char) || (char === '.' && /[0-9]/u.test(next))) {
    return { kind: 'number', text: text.slice(at, run((c) => /[0-9A-Za-z_.]/u.test(c) || ('+-'.includes(c) && /[eE]/u.test(text[end - 1] ?? '')))) };
  }

  if (WORD_START.test(char)) {
    const word = text.slice(at, run((c) => WORD.test(c)));

    return { kind: 'word', text: word, name: word };
  }

  return { kind: 'punct', text: char };
}

function tokenize(text: string): Effect.Effect<Token[], KinuError> {
  const tokens: Token[] = [];

  for (let at = 0; at < text.length;) {
    const token = tokenAt(text, at);

    if (token instanceof KinuError) return Effect.fail(token);
    tokens.push(token);
    at += token.text.length;
  }

  return Effect.succeed(tokens);
}

/** A statement read: one to run, cut at its placeholders, or a table to declare. */
export type SqlStatement =
  | { readonly kind: 'run'; readonly tokens: readonly Token[]; readonly placeholders: number }
  | { readonly kind: 'create'; readonly declaration: SqlTableDeclaration };

export interface SqlTableDeclaration {
  readonly name: string;
  readonly ifNotExists: boolean;
  readonly columns: readonly { readonly name: string; readonly type: AppColumnType; readonly primaryKey?: true; readonly unique?: true; readonly notNull?: true }[];
}

const meaningful = (tokens: readonly Token[]): Token[] => tokens.filter((token) => token.kind !== 'space');

/** One statement: a `;` may only end it. */
function single(tokens: readonly Token[]): Effect.Effect<readonly Token[], KinuError> {
  const at = tokens.findIndex((token) => token.kind === 'punct' && token.text === ';');

  if (at < 0) return Effect.succeed(tokens);

  return tokens.slice(at + 1).some((token) => token.kind !== 'space')
    ? Effect.fail(refusal('it runs one statement per call; split the rest into calls of their own'))
    : Effect.succeed(tokens.slice(0, at));
}

const RUNS = new Set(['SELECT', 'VALUES', 'WITH', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE']);

export function readSqlStatement(text: string): Effect.Effect<SqlStatement, KinuError> {
  return Effect.flatMap(Effect.flatMap(tokenize(text), single), (tokens) => {
    const [first] = meaningful(tokens);
    const verb = first?.kind === 'word' ? first.text.toUpperCase() : '';

    if (verb === 'CREATE') return Effect.map(tableDeclaration(meaningful(tokens)), (declaration) => ({ kind: 'create', declaration }) as const);

    if (!RUNS.has(verb)) {
      return Effect.fail(refusal(`it runs SELECT, INSERT, UPDATE, DELETE and CREATE TABLE${verb === '' ? '' : `, not ${verb}`}; a table is dropped with db.dropTable`));
    }

    return Effect.succeed({ kind: 'run', tokens, placeholders: tokens.filter((token) => token.kind === 'param').length } as const);
  });
}

const COLUMN_TYPES = new Map<string, AppColumnType>([['INTEGER', 'integer'], ['INT', 'integer'], ['REAL', 'real'], ['TEXT', 'text'], ['BLOB', 'blob']]);

const TAKES = 'CREATE TABLE [IF NOT EXISTS] name (column TYPE [PRIMARY KEY] [UNIQUE] [NOT NULL], …), TYPE one of INTEGER, REAL, TEXT, BLOB';

/** `CREATE TABLE` as the declaration `db.createTable` takes: what a fork and the typed reads keep of a table. */
function tableDeclaration(tokens: readonly Token[]): Effect.Effect<SqlTableDeclaration, KinuError> {
  let at = 1;

  // Each takes the token it names, or leaves `at` where it was.
  const word = (expected: string): boolean => {
    if (tokens[at]?.kind !== 'word' || tokens[at]?.text.toUpperCase() !== expected) return false;
    at += 1;

    return true;
  };

  const punct = (expected: string): boolean => {
    if (tokens[at]?.kind !== 'punct' || tokens[at]?.text !== expected) return false;
    at += 1;

    return true;
  };

  const name = (): string | null => {
    const token = tokens[at];

    if (token?.kind !== 'word' && token?.kind !== 'quoted') return null;
    at += 1;

    return token.name ?? token.text;
  };

  const takes = refusal(`it takes ${TAKES}`);

  if (!word('TABLE')) return Effect.fail(refusal(`it creates tables only: ${TAKES}`));
  const ifNotExists = word('IF');

  if (ifNotExists && !(word('NOT') && word('EXISTS'))) return Effect.fail(takes);
  const table = name();

  if (table === null || !punct('(')) return Effect.fail(refusal(`it takes ${TAKES}; a table made from a query is not one`));
  const columns: SqlTableDeclaration['columns'][number][] = [];

  do {
    const column = name();
    const type = COLUMN_TYPES.get(tokens[at]?.kind === 'word' ? (tokens[at]?.text ?? '').toUpperCase() : '');

    if (column === null || type === undefined) return Effect.fail(refusal(`column \`${column ?? '?'}\` is not one it takes: ${TAKES}`));
    at += 1;
    let [primaryKey, unique, notNull] = [false, false, false];

    for (;;) {
      if (word('PRIMARY')) {
        if (!word('KEY')) return Effect.fail(takes);
        primaryKey = true;
      } else if (word('UNIQUE')) unique = true;
      else if (word('NOT')) {
        if (!word('NULL')) return Effect.fail(takes);
        notNull = true;
      } else break;
    }

    columns.push({ name: column, type, ...(primaryKey && { primaryKey: true }), ...(unique && { unique: true }), ...(notNull && { notNull: true }) });
  } while (punct(','));

  return punct(')') && at === tokens.length ? Effect.succeed({ name: table, ifNotExists, columns }) : Effect.fail(refusal(`it takes ${TAKES}, and nothing more`));
}

/** Its tables named as they are stored: a name a shared table holds, bare or quoted and not a column after `.`. */
export function storedText(tokens: readonly Token[], stored: (name: string) => string | null): string[] {
  const segments = [''];
  let previous: Token | undefined;

  for (const token of tokens) {
    if (token.kind === 'param') segments.push('');
    else {
      const named = token.kind === 'quoted' || (token.kind === 'word' && !KEYWORDS.has(token.text.toUpperCase()));
      const physical = named && !(previous?.kind === 'punct' && previous.text === '.') ? stored(token.name ?? token.text) : null;

      segments[segments.length - 1] += physical === null ? token.text : `"${physical}"`;
    }

    if (token.kind !== 'space') previous = token;
  }

  return segments;
}

/**
 * What a slate's call to `db.sql` does, read from its text before it runs: whether its owner is asked first. The text is
 * only the guess; a call guessed to read runs read-only, and its program refuses it there if it writes. A text it cannot
 * read is refused here, as it would be where it runs.
 */
export function sqlCallImpact(query: JsonValue | undefined): Effect.Effect<Impact, KinuError> {
  if (typeof query !== 'string') return Effect.succeed('mutate');

  return Effect.map(readSqlStatement(query), (statement): Impact => {
    if (statement.kind === 'create') return 'mutate';
    let depth = 0;

    for (const token of meaningful(statement.tokens)) {
      if (token.kind === 'punct' && (token.text === '(' || token.text === ')')) depth += token.text === '(' ? 1 : -1;
      const verb = token.kind === 'word' ? token.text.toUpperCase() : '';

      // The verb a WITH clause leads to stands outside its parentheses.
      if (depth === 0 && verb !== 'WITH' && RUNS.has(verb)) return verb === 'SELECT' || verb === 'VALUES' ? 'observe' : 'mutate';
    }

    return 'mutate';
  });
}

/** How each opcode reaches the database. `read`/`write`: opens the b-tree at `p2` of database `p3`; `clear`: empties the
 *  b-tree at `p1` of database `p2`; `refused`: changes the schema or the connection, or reaches a virtual table. */
type Access = 'inert' | 'read' | 'write' | 'clear' | 'refused';

const ACCESS = new Map<string, Access>([
  ['OpenRead', 'read'], ['ReopenIdx', 'read'], ['OpenWrite', 'write'], ['Clear', 'clear'],
  ...`Savepoint AutoCommit Checkpoint JournalMode Vacuum IncrVacuum SetCookie CreateBtree SqlExec
    ParseSchema LoadAnalysis Destroy DropTable DropIndex DropTrigger IntegrityCk Expire CursorLock CursorUnlock TableLock
    Pagecount MaxPgcnt VBegin VCreate VDestroy VOpen VCheck VInitIn VFilter VColumn VNext VRename VUpdate`
    .split(/\s+/u).map((name) => [name, 'refused'] as const),
  ...`Transaction Init Goto Gosub Return InitCoroutine EndCoroutine Yield HaltIfNull Halt Integer Int64
    String8 String BeginSubrtn Null SoftNull Blob Variable Move Copy SCopy IntCopy FkCheck ResultRow Concat Add Subtract
    Multiply Divide Remainder CollSeq BitAnd BitOr ShiftLeft ShiftRight AddImm MustBeInt RealAffinity Cast Eq Ne Lt Le Gt Ge
    ElseEq Permutation Compare Jump And Or IsTrue Not BitNot Once If IfNot IsNull IsType ZeroOrNull NotNull IfNullRow Offset
    Column TypeCheck Affinity MakeRecord Count ReadCookie OpenDup OpenAutoindex OpenEphemeral SorterOpen SequenceTest
    OpenPseudo Close ColumnsUsed SeekLT SeekLE SeekGE SeekGT SeekScan SeekHit IfNotOpen IfNoHope NoConflict NotFound Found
    SeekRowid NotExists Sequence NewRowid Insert RowCell Delete ResetCount SorterCompare SorterData RowData Rowid NullRow
    SeekEnd Last IfSizeBetween SorterSort Sort Rewind IfEmpty SorterNext Prev Next SorterInsert IdxInsert IdxDelete
    DeferredSeek IdxRowid FinishSeek IdxLE IdxGT IdxLT IdxGE ResetSorter RowSetAdd RowSetRead RowSetTest Program Param
    FkCounter FkIfZero MemMax IfPos OffsetLimit IfNotZero DecrJumpZero AggInverse AggStep AggStep1 AggValue AggFinal Real
    PureFunc Function ClrSubtype GetSubtype SetSubtype FilterAdd Filter Trace CursorHint ReleaseReg Noop Explain Abortable`
    .split(/\s+/u).map((name) => [name, 'inert'] as const),
]);

/** The opcodes this gate classifies; any other is refused. */
export const CLASSIFIED_OPCODES: readonly string[] = [...ACCESS.keys()];

export const ExplainRowSchema = v.looseObject({
  opcode: v.string(), p1: v.number(), p2: v.number(), p3: v.number(), p5: v.number(),
});

/** OPFLAG_P2ISREG in an open's P5: its root page is a register's, known only as it runs. */
const P2_IS_REGISTER = 0x10;

/**
 * Which shared tables a compiled statement writes, none for a read; refused where it reaches anything else.
 * `tables`: the root pages of the shared tables and their indexes, by the table each belongs to.
 */
export function gateProgram(
  program: readonly v.InferOutput<typeof ExplainRowSchema>[], tables: ReadonlyMap<number, string>,
): Effect.Effect<readonly string[], KinuError> {
  const writes = new Set<string>();

  for (const { opcode, p1, p2, p3, p5 } of program) {
    const access = ACCESS.get(opcode);

    if (access === undefined) return Effect.fail(refusal(`its program uses the opcode ${opcode}, which this gate does not classify`));

    if (access === 'refused') {
      return Effect.fail(refusal(opcode.startsWith('V') ? 'it reaches a virtual table (pragma_* and the other table-valued functions)' : `it changes the database itself (${opcode})`));
    }

    if (access === 'inert') continue;
    const [page, database] = access === 'clear' ? [p1, p2] : [p2, p3];
    const table = database === 0 && (access === 'clear' || (p5 & P2_IS_REGISTER) === 0) ? tables.get(page) : undefined;

    if (table === undefined) return Effect.fail(refusal("it reaches a table outside this workspace's shared tables (db.listTables names them)"));

    if (access !== 'read') writes.add(table);
  }

  return Effect.succeed([...writes]);
}
