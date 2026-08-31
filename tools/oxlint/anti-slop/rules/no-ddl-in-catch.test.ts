// Kinu-local rule; see upstream.json's `kinuRules`. Repo-level corpus count and the seeded
// red->green run through the real `oxlint` binary live in ../no-swallow.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noDdlInCatchRule } from "./no-ddl-in-catch.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "schemaByException" };

tester.run("anti-slop/no-ddl-in-catch", noDdlInCatchRule, {
  valid: [
    // The escape: ask the schema instead of guessing from an exception.
    "function ensureColumn(sql, table, column, ddl) { const rows = sql.exec(`PRAGMA table_info(${table})`).toArray(); if (rows.some((r) => r.name === column)) return; sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); }",
    // No guard needed at all.
    "execRaw(`CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)`);",
    // Classified and rethrown: the exception is the signal, and an unexpected one still propagates.
    "try { execRaw(`ALTER TABLE t ADD COLUMN c TEXT`); } catch (error) { if (!isDuplicateColumn(error)) throw error; }",
    "try { execRaw(`ALTER TABLE t ADD COLUMN c TEXT`); } catch (error) { throw new Error('migrate failed', { cause: error }); }",
    // A swallowing catch over non-schema work is other rules' business, not this one's.
    "try { void target`INSERT INTO messages (id) VALUES (${id})`; } catch (error) { report(error); }",
    // A comment mentioning the statement is not the statement — token-level detection, not text.
    "try { rebuild(); } catch (error) { report(error); /* an ALTER TABLE used to live here */ }",
    // try/finally has no handler to decide anything.
    "try { execRaw(`ALTER TABLE t ADD COLUMN c TEXT`); } finally { unlock(); }",
    // DML that merely contains the word `table`.
    "try { execRaw(`INSERT INTO tables (name) VALUES ('x')`); } catch (error) { report(error); }",
  ],
  invalid: [
    {
      name: "the ALTER-TABLE-by-exception shape, all nine sites",
      code: "try { execRaw(`ALTER TABLE replay_evals ADD COLUMN score_lo REAL`); } catch { /* exists */ }",
      errors: [error],
    },
    {
      name: "single-quoted",
      code: "try { execRaw('ALTER TABLE search_nodes ADD COLUMN code_used TEXT'); } catch { /* absent */ }",
      errors: [error],
    },
    {
      name: "RENAME TO, guarded the same way",
      code: "try { execRaw(`ALTER TABLE ${from} RENAME TO ${to}`); } catch { /* raced */ }",
      errors: [error],
    },
    {
      name: "the fork.ts CREATE TABLE + INSERT loop",
      code: "try { void target`CREATE TABLE IF NOT EXISTS assistant_messages (id TEXT PRIMARY KEY)`; for (const m of rows) { void target`INSERT INTO assistant_messages (id) VALUES (${m.id})`; } } catch { /* pure-test targets may lack the table */ }",
      errors: [error],
    },
    {
      name: "logging the error does not make the schema decision sound",
      code: "try { execRaw(`ALTER TABLE t ADD COLUMN c TEXT`); } catch (error) { log.warn('migrate', { event: 'schema.alter_failed', error }); }",
      errors: [error],
    },
    {
      name: "CREATE INDEX",
      code: "try { execRaw(`CREATE INDEX idx_a ON t(a)`); } catch { /* exists */ }",
      errors: [error],
    },
    {
      name: "DROP TABLE",
      code: "try { execRaw(`DROP TABLE memory_chunks_fts`); } catch { /* absent */ }",
      errors: [error],
    },
    {
      name: "the statement inside the handler, repairing by exception",
      code: "try { probe(); } catch (error) { execRaw(`CREATE TABLE t (id TEXT)`); }",
      errors: [error],
    },
    {
      name: "one finding per try, not one per statement",
      code: "try { execRaw(`ALTER TABLE t ADD COLUMN a TEXT`); execRaw(`ALTER TABLE t ADD COLUMN b TEXT`); } catch { /* exists */ }",
      errors: [error],
    },
    {
      name: "two independent try statements",
      code: "try { execRaw(`ALTER TABLE t ADD COLUMN a TEXT`); } catch { }\ntry { execRaw(`ALTER TABLE t ADD COLUMN b TEXT`); } catch { }",
      errors: [error, error],
    },
  ],
});
