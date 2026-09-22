import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { parse, type Node as SqlNode, type Program, type SelectClause } from "sql-parser-cst";

/** A `${}` hole as SQLite reads it: a bound parameter. */
const HOLE_AS_PARAMETER = "?";
/** A `${}` hole in an identifier position, `FROM ${table}`: a name the caller supplies. */
const HOLE_AS_IDENTIFIER = '"hole"';

/** Text that reads as a statement this rule governs: a SELECT, or a CTE that leads to one. */
const STATEMENT_HEAD = /^\s*(?:select|with)\b/iu;

function parseSqlite(text: string): Program {
  return parse(text, { dialect: "sqlite", paramTypes: ["?"], includeRange: false });
}

/**
 * The template's SQL, parsed. A hole is a bound parameter first; a template whose holes name
 * identifiers (`FROM ${table}`) parses on the second try. Null when neither reads as SQLite.
 */
function parseTemplate(quasis: readonly string[]): Program | null {
  for (const hole of [HOLE_AS_PARAMETER, HOLE_AS_IDENTIFIER]) {
    try {
      return parseSqlite(quasis.join(` ${hole} `));
    } catch {
      // Tried the other reading of a hole; the caller decides what an unparsed statement means.
    }
  }
  return null;
}

/** Whether an expression reads a column: a bare name, a qualified name, or `*`. A function's own
 *  name and a CAST's type name are not columns, so only their arguments are walked. */
function readsColumn(node: SqlNode): boolean {
  switch (node.type) {
    case "identifier":
    case "member_expr":
    case "all_columns":
      return true;
    case "func_call":
      return node.args !== undefined && readsColumn(node.args);
    case "cast_expr":
      return readsColumn(node.args.expr.expr);
    default:
      return childNodes(node).some(readsColumn);
  }
}

function childNodes(node: SqlNode): SqlNode[] {
  const children: SqlNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type") continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (isSqlNode(item)) children.push(item);
    }
  }
  return children;
}

function isSqlNode(value: unknown): value is SqlNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

/**
 * Whether one select list mixes columns the table holds with values that read none, aliased as
 * if it did. A SELECT that reads no column at all is an existence probe; a UNION's arms fill
 * columns to align and tag rows by their arm (`'a' AS source`), so nothing under a compound
 * statement is judged, subqueries of its arms included.
 */
function mixesManufacturedColumns(select: SelectClause): boolean {
  const items = select.columns?.items ?? [];
  const aliased = items.filter((item) => item.type === "alias");
  const manufactured = aliased.filter((item) => !readsColumn(item.expr)).length;
  return manufactured > 0 && manufactured < items.length;
}

/** Every select clause in the program outside a compound statement. */
function judgedSelectClauses(node: SqlNode): SelectClause[] {
  if (node.type === "compound_select_stmt") return [];
  const own = node.type === "select_stmt" ? node.clauses.filter((clause) => clause.type === "select_clause") : [];
  return [...own, ...childNodes(node).flatMap(judgedSelectClauses)];
}

export function hasManufacturedColumn(program: Program): boolean {
  return judgedSelectClauses(program).some(mixesManufacturedColumns);
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
 * whether the aliased expression reads any column at all, decided on the statement's syntax tree
 * (`sql-parser-cst`, SQLite dialect), so `CAST(NULL AS TEXT) AS x`, `? AS x` and `'a' || 'b' AS x`
 * are all the same fake, and `COUNT(*) AS n`, `COALESCE(a, b) AS c` and `json_extract(usage, '$.k')
 * AS k` are all computed from the table. A SELECT of such values alone (`SELECT 1 AS present FROM t
 * WHERE … LIMIT 1`) is an existence probe and reads no column, so it is not this rule's subject;
 * neither is a `UNION`, whose arms fill columns to align.
 *
 * Every tagged template is SQL by construction (the tag is the executor), so one that does not
 * parse as SQLite is its own finding: a statement the gate cannot read is a statement it cannot
 * govern. A plain string or untagged template that begins as a SELECT is judged when it parses and
 * passed over when it does not, because prose and other dialects also begin that way.
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
      unparsedStatement:
        "This tagged SQL does not parse as SQLite ({{reason}}), so no gate can read what it selects. Write the statement so it parses; a hole may stand for a value or for one identifier, not for a clause.",
    },
  },
  createOnce(context) {
    const judge = (node: ESTree.Node, quasis: readonly string[], tagged: boolean): void => {
      const text = quasis.join(" ");
      if (!STATEMENT_HEAD.test(text)) return;
      const program = parseTemplate(quasis);
      if (program === null) {
        if (!tagged) return;
        let reason = "syntax error";
        try {
          parseSqlite(quasis.join(` ${HOLE_AS_PARAMETER} `));
        } catch (error) {
          reason = error instanceof Error ? error.message.split("\n")[0] ?? reason : reason;
        }
        context.report({ node, messageId: "unparsedStatement", data: { reason } });
        return;
      }
      if (hasManufacturedColumn(program)) context.report({ node, messageId: "manufacturedColumn" });
    };

    return {
      TemplateLiteral(node) {
        const quasis = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
        judge(node, quasis, node.parent?.type === "TaggedTemplateExpression");
      },
      Literal(node) {
        if (typeof node.value === "string") judge(node, [node.value], false);
      },
    };
  },
});
