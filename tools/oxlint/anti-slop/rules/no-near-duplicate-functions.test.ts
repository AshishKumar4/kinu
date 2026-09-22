// Kinu-local rule; see upstream.json's `kinuRules`. The seeded red->green run through the real
// `oxlint` binary lives in ../no-design-smells.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noNearDuplicateFunctionsRule } from "./no-near-duplicate-functions.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

/** A body comfortably over the token floor, parameterised on the literals it carries. */
const reader = (name: string, operation: string, absent: string): string => `
function ${name}(sql, actorId, messageId) {
  const rows = sql\`SELECT sequence, payload_json FROM message_updates
    WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = '${operation}'\`;
  if (rows.length === 0) throw new KinuError('${absent}');
  const [row] = rows;
  return { sequence: row.sequence, payload: JSON.parse(row.payload_json) };
}`;

tester.run("anti-slop/no-near-duplicate-functions", noNearDuplicateFunctionsRule, {
  valid: [
    // One function with the literal as a parameter: the shape this rule asks for.
    `function readPart(sql, actorId, messageId, operation) {
      const rows = sql\`SELECT sequence, payload_json FROM message_updates
        WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = \${operation}\`;
      if (rows.length === 0) throw new KinuError('absent');
      const [row] = rows;
      return { sequence: row.sequence, payload: JSON.parse(row.payload_json) };
    }
    const partOpened = (sql, a, m) => readPart(sql, a, m, 'open');
    const partEnded = (sql, a, m) => readPart(sql, a, m, 'content-end');`,
    // Bodies that differ in an identifier are different functions; the tree-wide duplication
    // gate, which frees identifiers and keeps literals, owns that case.
    `${reader("partOpened", "open", "absent")}
    function partEnded(sql, actorId, messageId) {
      const rows = sql\`SELECT sequence, payload_json FROM message_updates
        WHERE actor_id = \${actorId} AND message_id = \${messageId} AND operation = 'open'\`;
      if (rows.length === 0) throw new KinuError('absent');
      const [row] = rows;
      return { sequence: row.sequence, payload: JSON.parse(row.payload_path) };
    }`,
    // Below the floor: two small accessors that differ in a literal are cheaper than the parameter.
    `const isOpen = (row) => row.operation === 'open';
    const isEnded = (row) => row.operation === 'content-end';`,
    `class Store {
      pendingBirths(actorId) { return this.sql\`SELECT name FROM subs WHERE actor_id = \${actorId} AND birth = 1\`; }
      pendingDeaths(actorId) { return this.sql\`SELECT name FROM subs WHERE actor_id = \${actorId} AND death = 1\`; }
    }`,
    // A function alone.
    reader("partOpened", "open", "absent"),
  ],
  invalid: [
    {
      name: "the same body under two names with one literal swapped (messages.ts, 2026-09-21)",
      code: `${reader("partOpened", "open", "no open part")}\n${reader("partEnded", "open", "no ended part")}`,
      errors: [{
        messageId: "swappedLiterals",
        data: { name: "partEnded", original: "partOpened", line: "2", count: "1", swaps: "'no open part' → 'no ended part'" },
      }],
    },
    {
      name: "several literals swapped, all named",
      code: `${reader("partOpened", "open", "no open part")}\n${reader("partEnded", "content-end", "no ended part")}`,
      errors: [{ messageId: "swappedLiterals" }],
    },
    {
      name: "a token-for-token copy",
      code: `${reader("partOpened", "open", "absent")}\n${reader("partOpenedAgain", "open", "absent")}`,
      errors: [{ messageId: "exactCopy", data: { name: "partOpenedAgain", original: "partOpened", line: "2" } }],
    },
    {
      name: "class methods",
      code: `class Roster {
        ${reader("create", "open", "absent").replace("function ", "")}
        ${reader("restore", "restore", "absent").replace("function ", "")}
      }`,
      errors: [{ messageId: "swappedLiterals", data: { name: "restore", original: "create", line: "3", count: "1", swaps: "} AND operation = 'open'` → } AND operation = 'restore'`" } }],
    },
    {
      name: "arrow callbacks bound to properties",
      code: `const handlers = {
        onOpen: ${reader("", "open", "absent").replace("function (sql, actorId, messageId)", "(sql, actorId, messageId) =>")},
        onEnd: ${reader("", "content-end", "absent").replace("function (sql, actorId, messageId)", "(sql, actorId, messageId) =>")},
      };`,
      errors: [{ messageId: "swappedLiterals" }],
    },
    {
      name: "three copies report the second and third against the first",
      code: `${reader("a", "1", "x")}\n${reader("b", "2", "x")}\n${reader("c", "3", "x")}`,
      errors: [
        { messageId: "swappedLiterals", data: { name: "b", original: "a", line: "2", count: "1", swaps: "} AND operation = '1'` → } AND operation = '2'`" } },
        { messageId: "swappedLiterals", data: { name: "c", original: "a", line: "2", count: "1", swaps: "} AND operation = '1'` → } AND operation = '3'`" } },
      ],
    },
    {
      name: "a boolean flag swapped counts as a literal",
      code: `${reader("strict", "open", "absent").replace("JSON.parse(row.payload_json)", "JSON.parse(row.payload_json, true)")}
      ${reader("loose", "open", "absent").replace("JSON.parse(row.payload_json)", "JSON.parse(row.payload_json, false)")}`,
      errors: [{ messageId: "swappedLiterals", data: { name: "loose", original: "strict", line: "2", count: "1", swaps: "true → false" } }],
    },
  ],
});
