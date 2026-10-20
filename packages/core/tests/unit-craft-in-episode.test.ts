/** In-episode evidence: derived from what the runtime saw; prose mentions are not calls, a block that failed on its
 *  own account blames nobody, and a stamped raise marks its tool broken until a clean return. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSql } from './helpers';
import {
  craftFailureBlame, craftFailureMarker, craftInvocationError, craftInvocationSites,
  createCraftLedger, observeCraftCall, type CraftLedger,
} from '../src/craft/in-episode';
import { initCraftedToolsTables } from '@kinu.run/agent-utils/stores';

describe('craftInvocationSites — what the runtime saw called', () => {
  test('finds a call under the one sandbox namespace, and nowhere else', () => {
    expect(craftInvocationSites('await tools.summarize({a:1})', ['summarize'])).toEqual(['summarize']);
    // `tools` is the only namespace a crafted tool is callable in, so a call
    // written against any other name reached nothing and credits nothing.
    expect(craftInvocationSites('return codemode.summarize(x)', ['summarize'])).toEqual([]);
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

  test('a stored name that is not the called name matches nothing', () => {
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

  test('a call is read off the syntax tree, whatever its spelling', () => {
    expect(craftInvocationSites('await tools["summarize"](1)', ['summarize'])).toEqual(['summarize']);
    expect(craftInvocationSites('await tools.summarize?.(1)', ['summarize'])).toEqual(['summarize']);
    // A regex literal holding a quote is not the start of a string that swallows the call after it.
    expect(craftInvocationSites('const q = /"/; await tools.summarize(1)', ['summarize'])).toEqual(['summarize']);
    // The sandbox strips a markdown fence before it runs the program.
    expect(craftInvocationSites('```js\nawait tools.summarize(1)\n```', ['summarize'])).toEqual(['summarize']);
  });
});

describe('a call is credited with creating a tool only when it asked for one', () => {
  /** The tools a call's program could have created: the store grew by `w` while it ran. */
  const grown: CraftLedger = { names: () => ['w'], broke: () => {}, repaired: () => {} };

  const created = (code: string): readonly string[] => observeCraftCall(grown, { code, before: new Set(), result: '{}', failed: false })?.created ?? [];

  test('a real call counts; a mention in a stored body does not', () => {
    expect(created('await workspace.createTool("a","b","c")')).toEqual(['w']);
    expect(created('return workspace.fs.text("/a")')).toEqual([]);
    expect(created('// workspace.createTool("a","b","c")')).toEqual([]);
    expect(created('await workspace.createTool("w","d","async()=>workspace.createTool(1)")')).toEqual(['w']);
    expect(created('const s = "workspace.createTool("')).toEqual([]);
    expect(created('other.workspace.createTool(1)')).toEqual([]);
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

/** A call of `name` that raised: its failure names it. */
function raised(ledger: CraftLedger, name: string, error = 'boom'): void {
  const failure = craftInvocationError(name, new Error(error)).message;

  observeCraftCall(ledger, { code: `await tools.${name}(1)`, before: new Set([name]), result: `Error: ${failure}\n    at program`, failed: true });
}

function ledgerFixture() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initCraftedToolsTables(sql);

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

  test('names() is the offered set: best preference first, and no more than 20', () => {
    const { ledger, db } = ledgerFixture();
    const sql = makeSql(db);

    for (let i = 0; i < 22; i++) db.run(`INSERT INTO crafted_tools (name) VALUES ('t${String(i)}')`);
    // Chosen in every turn that offered it, in turns rated 5: first. Offered often and never chosen: last, and cut.
    void sql`UPDATE crafted_tools SET offered = 10, chosen = 10, rated = 10, rating_sum = 10 WHERE name = 't5'`;
    void sql`UPDATE crafted_tools SET offered = 40 WHERE name IN ('t0', 't1')`;

    const names = ledger.names();
    expect(names).toHaveLength(20);
    expect(names[0]).toBe('t5');
    expect(names).not.toContain('t0');
    expect(names).not.toContain('t1');
  });

  test('a store that cannot answer is a fault, not a runtime with no crafted tools', () => {
    const db = new Database(':memory:');

    const ledger = createCraftLedger({
      craftStore: { list: () => { throw new Error('not initialized'); } },
      sql: makeSql(db),
    });

    // `crafted_tools` is in the workspace schema, so a store that cannot list is broken; an empty answer
    // would make the agent re-craft tools it owns.
    expect(() => ledger.names()).toThrow('not initialized');
  });

  test('a raise marks the tool broken with its stamped error, and a clean return clears it', () => {
    const { ledger, db } = ledgerFixture();
    db.run(`INSERT INTO crafted_tools (name) VALUES ('summarize')`);
    const broken = () => db.query<{ broken: string | null }, []>(`SELECT broken FROM crafted_tools WHERE name='summarize'`).get()?.broken;

    raised(ledger, 'summarize', 'args.text is undefined');
    expect(broken()).toBe('args.text is undefined');
    // Still offered: a broken tool stays callable, and its declaration says so.
    expect(ledger.names()).toEqual(['summarize']);

    observeCraftCall(ledger, { code: 'return await tools.summarize(1)', before: new Set(['summarize']), result: '{"result":1}', failed: false });
    expect(broken()).toBeNull();
  });

  test('a raise of a tool outside the store is a no-op, not a resurrection', () => {
    const { ledger, db } = ledgerFixture();
    ledger.broke('ghost', 'boom');
    ledger.repaired(['ghost']);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM crafted_tools`).get()?.n).toBe(0);
  });
});
