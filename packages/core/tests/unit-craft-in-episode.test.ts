/**
 * The in-episode fitness signal — the pure half.
 *
 * These pin the properties the signal's worth rests on: it is derived from
 * what the runtime saw (call sites in submitted code, an attribution stamp on
 * a real failure), a name that merely APPEARS in prose is not a call, and a
 * block that failed on its own account blames nobody.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw } from './helpers';
import {
  CRAFT_INVOCATION_QUALITY, CRAFT_NEUTRAL_PRIOR,
  craftCreatesTool, craftFailureBlame, craftFailureMarker, craftInvocationError, craftInvocationSites,
  createCraftLedger, stripNonCode,
} from '../src/craft/in-episode';
import { initCraftQualityColumns } from '../src/craft/schemas';
import { feedbackToQuality } from '../src/evolution/outcomes';

describe('craftInvocationSites — what the runtime saw called', () => {
  test('finds a call under either sandbox namespace', () => {
    expect(craftInvocationSites('await tools.summarize({a:1})', ['summarize'])).toEqual(['summarize']);
    expect(craftInvocationSites('return codemode.summarize(x)', ['summarize'])).toEqual(['summarize']);
  });

  test('a mention that is not a call is not a call', () => {
    expect(craftInvocationSites('const n = tools.summarize;', ['summarize'])).toEqual([]);
    expect(craftInvocationSites('summarize(1)', ['summarize'])).toEqual([]);
    expect(craftInvocationSites('other.summarize(1)', ['summarize'])).toEqual([]);
  });

  test('a name inside a string or comment is not a call — the createTool case', () => {
    // The realistic false positive: a tool BODY passed as a string argument,
    // whose own text calls another crafted tool.
    const code = `await workspace.createTool("wrapper", "d", "async () => tools.summarize(1)")`;
    expect(craftInvocationSites(code, ['summarize'])).toEqual([]);
    expect(craftInvocationSites('// tools.summarize(1)\nreturn 1', ['summarize'])).toEqual([]);
    expect(craftInvocationSites('/* tools.summarize(1) */ return 1', ['summarize'])).toEqual([]);
    expect(craftInvocationSites('console.log("tools.summarize(")', ['summarize'])).toEqual([]);
  });

  test('only tools that actually exist can match', () => {
    expect(craftInvocationSites('tools.whatever(1)', ['summarize'])).toEqual([]);
    expect(craftInvocationSites('tools.summarize(1)', [])).toEqual([]);
  });

  test('similar names do not bleed into each other', () => {
    expect(craftInvocationSites('tools.summarizeAll(1)', ['summarize', 'summarizeAll']))
      .toEqual(['summarizeAll']);
  });

  test('a stored name that cannot be dot-called is skipped, never interpolated', () => {
    // Regex metacharacters in a stored name must not become pattern syntax.
    expect(craftInvocationSites('tools.a.b(1)', ['a.b'])).toEqual([]);
    expect(craftInvocationSites('tools.x(1)', ['.*'])).toEqual([]);
  });

  test('a template interpolation is code — the literal text around it is not', () => {
    expect(craftInvocationSites('`plain tools.summarize( text`', ['summarize'])).toEqual([]);
    expect(craftInvocationSites('`n=${await tools.summarize(1)}`', ['summarize'])).toEqual(['summarize']);
    // Nested: a template inside an interpolation returns to literal text.
    expect(craftInvocationSites('`${ `tools.summarize(` }`', ['summarize'])).toEqual([]);
    expect(craftInvocationSites('`${ f({a: tools.summarize(1)}) }`', ['summarize'])).toEqual(['summarize']);
  });

  test('stripNonCode replaces spans rather than joining what surrounded them', () => {
    expect(stripNonCode('a"x"b')).toBe('a b');
    expect(stripNonCode('a/*x*/b')).toBe('a b');
    expect(stripNonCode('"\\""')).toBe(' ');
  });
});

describe('craftCreatesTool — the block asked for a tool of its own', () => {
  test('a real call counts; a mention in a stored body does not', () => {
    expect(craftCreatesTool('await workspace.createTool("a","b","c")')).toBe(true);
    expect(craftCreatesTool('return workspace.readFile("/a")')).toBe(false);
    expect(craftCreatesTool('// workspace.createTool("a","b","c")')).toBe(false);
    expect(craftCreatesTool('await workspace.createTool("w","d","async()=>workspace.createTool(1)")')).toBe(true);
    expect(craftCreatesTool('const s = "workspace.createTool("')).toBe(false);
    expect(craftCreatesTool('other.workspace.createTool(1)')).toBe(false);
  });
});

describe('craftFailureBlame — attribution by stamp only', () => {
  test('the stamped tool is blamed', () => {
    const err = craftInvocationError('summarize', new Error('boom'));
    expect(err.message).toBe('[crafted:summarize] boom');
    expect(err.cause).toBeInstanceOf(Error);
    expect(craftFailureBlame(err.message, ['summarize', 'other'])).toEqual(['summarize']);
  });

  test('a block that failed on its own account blames nobody', () => {
    expect(craftFailureBlame('TypeError: x is not a function', ['summarize'])).toEqual([]);
  });

  test('only tools the block actually called can be blamed', () => {
    const text = craftFailureMarker('ghost');
    expect(craftFailureBlame(text, ['summarize'])).toEqual([]);
  });

  test('a non-Error throw still carries the stamp', () => {
    expect(craftInvocationError('t', 'plain string').message).toBe('[crafted:t] plain string');
  });
});

function ledgerFixture() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initCraftQualityColumns(makeExecRaw(db), sql);
  const ledger = createCraftLedger({
    craftStore: { list: () => db.query<{ name: string }, []>('SELECT name FROM crafted_tools').all() },
    sql,
  });
  return { ledger, db };
}

describe('the craft ledger — where an in-episode observation lands', () => {
  test('names() reads the store live, so a tool crafted mid-turn is visible at once', () => {
    const { ledger, db } = ledgerFixture();
    expect(ledger.names()).toEqual([]);
    db.run(`INSERT INTO crafted_tools (name) VALUES ('summarize')`);
    expect(ledger.names()).toEqual(['summarize']);
  });

  test('names() is the callable set, not the whole store — a retired tool is gone', () => {
    const { ledger, db } = ledgerFixture();
    const sql = makeSql(db);
    db.run(`INSERT INTO crafted_tools (name) VALUES ('kept'), ('retired')`);
    // Column defaults seed the neutral prior; the retired tool's score is set low.
    void sql`UPDATE crafted_tools SET score = 0.01 WHERE name = 'retired'`;
    expect(ledger.names()).toEqual(['kept']);
  });

  test('a store that cannot answer is a fault, not a runtime with no crafted tools', () => {
    const db = new Database(':memory:');
    const ledger = createCraftLedger({
      craftStore: { list: () => { throw new Error('not initialized'); } },
      sql: makeSql(db),
    });
    // `crafted_tools` belongs to the one workspace schema, so a store that
    // cannot list is a broken database. Answered as an empty set, the agent
    // re-crafts tools it already owns and every call to them goes unscored.
    expect(() => ledger.names()).toThrow('not initialized');
  });

  test('observations accumulate through the existing EMA, not a parallel score', () => {
    const { ledger, db } = ledgerFixture();
    db.run(`INSERT INTO crafted_tools (name) VALUES ('summarize')`);
    const before = db.query<{ score: number; uses: number }, []>(
      `SELECT score, uses FROM crafted_tools WHERE name='summarize'`,
    ).get();
    if (!before) throw new Error('expected seeded craft score');
    expect(before.score).toBe(CRAFT_NEUTRAL_PRIOR);
    expect(before.uses).toBe(0);

    ledger.observe(['summarize'], CRAFT_INVOCATION_QUALITY.returned);
    const after = db.query<{ score: number; uses: number }, []>(
      `SELECT score, uses FROM crafted_tools WHERE name='summarize'`,
    ).get();
    if (!after) throw new Error('expected observed craft score');
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.uses).toBe(1);
  });

  test('a tool that keeps raising falls below the injection floor, and says which', () => {
    const { ledger, db } = ledgerFixture();
    db.run(`INSERT INTO crafted_tools (name) VALUES ('broken')`);

    const dropped: string[] = [];
    for (let i = 0; i < 4; i++) {
      dropped.push(...ledger.observe(['broken'], CRAFT_INVOCATION_QUALITY.raised));
    }
    // Forgiving of a flake, decisive about a persistently broken artifact.
    expect(dropped).toEqual(['broken']);
  });

  test('one success is enough to keep a tool that merely stumbled', () => {
    const { ledger, db } = ledgerFixture();
    db.run(`INSERT INTO crafted_tools (name) VALUES ('flaky')`);
    expect(ledger.observe(['flaky'], CRAFT_INVOCATION_QUALITY.raised)).toEqual([]);
    expect(ledger.observe(['flaky'], CRAFT_INVOCATION_QUALITY.returned)).toEqual([]);
    expect(ledger.observe(['flaky'], CRAFT_INVOCATION_QUALITY.raised)).toEqual([]);
  });

  test('machine evidence never reaches the pole a person\'s verdict does', () => {
    // Read from the human band itself, so the invariant cannot be voided by
    // someone moving that band and leaving a stale literal here.
    expect(CRAFT_INVOCATION_QUALITY.returned).toBeLessThan(feedbackToQuality('positive'));
    expect(CRAFT_INVOCATION_QUALITY.raised).toBeLessThan(CRAFT_NEUTRAL_PRIOR);
  });

  test('a creation carries its neutral prior in the same INSERT — nothing to seed', () => {
    const { db } = ledgerFixture();
    db.run(`INSERT INTO crafted_tools (name) VALUES ('fresh')`);
    const row = db.query<{ score: number; uses: number }, []>(
      `SELECT score, uses FROM crafted_tools WHERE name='fresh'`,
    ).get();
    expect(row).toEqual({ score: CRAFT_NEUTRAL_PRIOR, uses: 0 });
  });

  test('an observation of a tool outside the store is a no-op, not a resurrection', () => {
    const { ledger, db } = ledgerFixture();
    expect(ledger.observe(['ghost'], CRAFT_INVOCATION_QUALITY.returned)).toEqual([]);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM crafted_tools`).get()?.n).toBe(0);
  });
});
