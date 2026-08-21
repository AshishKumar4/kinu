import { describe, expect, test } from 'bun:test';

import { readSources } from './sources';
import { declaredRpcs, findUnreachable, invokedNames, keyOf } from './reachability';

/** One DO with one public RPC. Every case below varies only what the second
 *  file does with the name `listDeferredApprovals`. */
const AGENT = `
export class OrchestratorAgent {
  @callable()
  async listDeferredApprovals(): Promise<string[]> {
    return this.deferrals.list();
  }

  private async internal(): Promise<void> {
    await this.listDeferredApprovals();
  }
}
`;

const KEY = 'agent.ts#OrchestratorAgent.listDeferredApprovals';

function scan(consumer: string): string[] {
  return findUnreachable(new Map([['agent.ts', AGENT], ['consumer.tsx', consumer]])).unreachable.map(keyOf);
}

describe('reachability gate', () => {
  test('a @callable nothing invokes is reported', () => {
    expect(scan('export const Panel = () => null;')).toEqual([KEY]);
  });

  test("the declaring file's own `this.method()` is not a caller", () => {
    // AGENT calls it from `internal()`. If self-reference counted, nothing here
    // would ever be reportable and the gate would pass on an empty repo.
    expect(scan('')).toEqual([KEY]);
  });

  test('a string literal in argument position is a caller', () => {
    expect(scan(`const load = () => rpc('listDeferredApprovals', []);`)).toEqual([]);
  });

  test('a property-access call on a stub is a caller', () => {
    expect(scan('const load = (stub) => stub.listDeferredApprovals();')).toEqual([]);
  });

  // ── The discriminator ────────────────────────────────────────────────
  // Each of these is how one of the seven real dead RPCs looked reachable to
  // `git grep`. If the gate is ever rewritten to match text, every one of these
  // flips to "reachable" and the gate silently stops working.

  test('a property key in a policy table is not a caller', () => {
    expect(scan(`export const AGENT_RPC_ACCESS = { listDeferredApprovals: 'interactive' };`))
      .toEqual([KEY]);
  });

  test('an array element in an allowlist is not a caller', () => {
    expect(scan(`export const SURFACE = ['listDeferredApprovals', 'getMctsTree'];`))
      .toEqual([KEY]);
  });

  test('a comment explaining the method is not a caller', () => {
    expect(scan('// listDeferredApprovals used to load here; removed with the tab.\nexport const x = 1;'))
      .toEqual([KEY]);
  });

  test('an import of a same-named core function is not a caller', () => {
    expect(scan(`import { listDeferredApprovals } from '@kinu.run/core';\nexport const x = 1;`))
      .toEqual([KEY]);
  });

  test('a type-only reference is not a caller', () => {
    expect(scan('type Surface = { listDeferredApprovals(): void };\nexport const x = 1;'))
      .toEqual([KEY]);
  });

  // ── Test-only reach, reported with its reason ────────────────────────

  test('an RPC only its own test invokes is reported, and says so', () => {
    const found = findUnreachable(
      new Map([['agent.ts', AGENT]]),
      new Map([['agent.test.ts', `test('x', () => agent.listDeferredApprovals());`]]),
    );
    expect(found.unreachable.map(keyOf)).toEqual([KEY]);
    expect(found.unreachable[0]!.testCallers).toEqual(['agent.test.ts']);
  });

  // ── The parser's own health ──────────────────────────────────────────

  test('the decorator is matched on the decorator, not on the text @callable', () => {
    const commentedOut = AGENT.replace('@callable()', '// @callable() — withdrawn');
    expect(declaredRpcs('agent.ts', commentedOut)).toEqual([]);
    expect(declaredRpcs('agent.ts', AGENT).map((r) => r.method)).toEqual(['listDeferredApprovals']);
  });

  test('invokedNames separates invocation from mention', () => {
    const names = invokedNames('x.ts', `
      const table = { mentioned: 1 };
      const list = ['listed'];
      rpc('argument');
      stub.accessed();
      handlers['indexed']();
      // commented()
    `);
    // `rpc` itself is a bare identifier callee and is NOT recorded: an RPC is
    // always reached through an object, and counting free calls would let a
    // same-named core function stand in for a caller of the method.
    expect([...names].sort()).toEqual(['accessed', 'argument', 'indexed']);
  });
});

/**
 * The fixtures above prove the rule. These prove the rule is pointed at the
 * real repository: the gate is run against the actual source map, with exactly
 * one real call site removed, and the RPC behind it must go dark. A gate that
 * cannot be made to fail this way is measuring its own fixtures.
 */
describe('reachability gate, against the real tree', () => {
  const SOURCES = readSources();
  const ORCHESTRATOR = 'packages/cf-backend/src/orchestrator.ts';

  /** RPC → the one UI file that invokes it, verified live below. */
  const WIRES = {
    previewScaffoldLive: 'packages/cf-backend/src/components/surfaces/ScaffoldLineage.tsx',
    retryBackgroundJob: 'packages/cf-backend/src/components/surfaces/work-jobs.tsx',
    listTurnFeedback: 'packages/cf-backend/src/pages/WorkspacePage.tsx',
  } satisfies Record<string, string>;

  test('the real tree declares a substantial @callable surface', () => {
    // The denominator. `unreachable: []` is only good news over a non-empty
    // `declared`; a matcher that silently stops matching would otherwise make
    // this gate pass forever, which is how `unit-layergate.test.ts` came to
    // check an empty set.
    expect(findUnreachable(SOURCES).declared.length).toBeGreaterThan(80);
  });

  test.each(Object.entries(WIRES))('cutting %s\u2019s only caller makes it unreachable', (rpc, wire) => {
    const key = `${ORCHESTRATOR}#OrchestratorAgent.${rpc}`;
    expect(findUnreachable(SOURCES).unreachable.map(keyOf)).not.toContain(key);

    const cut = new Map(SOURCES);
    expect(cut.delete(wire)).toBe(true);
    expect(findUnreachable(cut).unreachable.map(keyOf)).toContain(key);
  });
});
