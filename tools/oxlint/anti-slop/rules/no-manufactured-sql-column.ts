import { defineRule } from "@oxlint/plugins";

/**
 * Words that may appear in a select-list expression without naming a column. Anything else that
 * reads as a word and is not a function call names a column, so an expression that contains no
 * such word is computed from nothing the table holds.
 */
const NON_COLUMN_WORD = {
  and: true, as: true, between: true, case: true, else: true, end: true, false: true, in: true,
  is: true, like: true, not: true, null: true, or: true, then: true, true: true, when: true,
} satisfies Record<string, true>;

/** One lexical unit of a select-list expression. Strings are one token so their text is inert. */
const SQL_TOKEN = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_.]*|\*|\S/gu;

/**
 * Whether an expression reads a column. A word is a column reference unless it is a keyword, a
 * function name (followed by `(`) or a type name (preceded by `AS` inside a `CAST`). `*` reads
 * every column. Parameters (`?`) are bound values the caller already knows, like literals.
 */
function readsColumn(expression: string): boolean {
  const tokens = [...expression.matchAll(SQL_TOKEN)].map((match) => match[0]);
  return tokens.some((token, index) => {
    if (token === "*") return true;
    if (!/^[A-Za-z_]/u.test(token)) return false;
    if (Object.hasOwn(NON_COLUMN_WORD, token.toLowerCase())) return false;
    if (tokens[index + 1] === "(") return false;
    return tokens[index - 1]?.toLowerCase() !== "as";
  });
}

/** `expression AS alias` split at its last top-level `AS`; null when the item carries no alias. */
function aliased(item: string): string | null {
  const match = /^(.*?)\s+as\s+[A-Za-z_][A-Za-z0-9_]*$/isu.exec(item);
  return match?.[1] ?? null;
}

/**
 * The select list that starts at `from`, split at top-level commas and cut at the top-level
 * `FROM`. Null when the SELECT reads no table (`SELECT 1`), which can fake nothing.
 */
function selectList(sql: string, from: number): readonly string[] | null {
  const items: string[] = [];
  let depth = 0;
  let start = from;
  for (let index = from; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth < 0) return null;
    if (depth > 0) continue;
    if (char === ",") {
      items.push(sql.slice(start, index).trim());
      start = index + 1;
    } else if (/\s/u.test(char) && /^from\b/iu.test(sql.slice(index + 1))) {
      items.push(sql.slice(start, index).trim());
      return items;
    }
  }
  return null;
}

/**
 * Whether one SQL text has a select list that mixes columns the table holds with expressions
 * that read none, aliased as if it did.
 *
 * A statement with a `UNION` is exempt as a whole: its arms must agree column for column, and a
 * constant is how an arm fills a column it does not have. That is alignment, not a fake.
 */
export function mixesManufacturedColumns(sql: string): boolean {
  if (/\bunion\b/iu.test(sql)) return false;
  for (const match of sql.matchAll(/\bselect\b/giu)) {
    const items = selectList(sql, match.index + match[0].length);
    if (items === null) continue;
    const manufactured = items.filter((item) => {
      const expression = aliased(item);
      return expression !== null && !readsColumn(expression);
    }).length;
    if (manufactured > 0 && manufactured < items.length) return true;
  }
  return false;
}

/**
 * Reject a SELECT list that mixes real columns with values aliased as columns.
 *
 * `SELECT sequence, NULL AS part_no, 'open' AS operation, payload_json FROM message_projections`
 * existed so one row from a table WITHOUT `part_no` or `operation` could be handed to a reader
 * written for a table WITH them. The reader's type was satisfied and the schema was not: two of the
 * "columns" were facts the caller already knew, planted in the query so a helper could be reused.
 * The next reader of that query cannot tell which columns the store holds, and the next fix to the
 * helper silently changes what the constants mean.
 *
 * The store answers with what it holds; what the caller knows, the caller adds in code. The test is
 * whether the aliased expression reads any column at all, so `CAST(NULL AS TEXT) AS x`, `? AS x`
 * and `'a' || 'b' AS x` are all the same fake, and `COUNT(*) AS n`, `COALESCE(a, b) AS c` and
 * `json_extract(usage, '$.k') AS k` are all computed from the table. A SELECT of such values alone
 * (`SELECT 1 AS present FROM t WHERE … LIMIT 1`) is an existence probe and reads no column, so it
 * is not this rule's subject; neither is a `UNION`, whose arms fill columns to align.
 *
 * Text-level, over every template and string literal that spells a SELECT: the tagged `sql`
 * executor, `exec(...)` strings and prepared statements all carry SQL as text, and a rule keyed on
 * one tag would miss the other two.
 */
export const noManufacturedSqlColumnRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a SELECT list that mixes table columns with values aliased as columns to fake a row shape.",
    },
    messages: {
      manufacturedColumn:
        "This SELECT plants a value that reads no column (`NULL AS x`, `'value' AS x`) beside real columns so the row fits a reader written for another table. The store returns what it holds; add what the caller already knows in code, or give this reader its own row type.",
    },
  },
  createOnce(context) {
    return {
      TemplateLiteral(node) {
        // Each `${}` hole is a bound parameter: a value the caller already knows.
        const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(" ? ");
        if (mixesManufacturedColumns(text)) {
          context.report({ node, messageId: "manufacturedColumn" });
        }
      },
      Literal(node) {
        if (typeof node.value === "string" && mixesManufacturedColumns(node.value)) {
          context.report({ node, messageId: "manufacturedColumn" });
        }
      },
    };
  },
});
