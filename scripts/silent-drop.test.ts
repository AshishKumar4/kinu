/**
 * The silent-drop census's own decision boundary.
 *
 * Two directions per class, and the second is the one that matters: a check that
 * fires on the defect AND on its repair has no green state to reach, so nobody
 * can act on it. Every case here is therefore a pair — the shape as it appears in
 * this repository, and the same code written correctly.
 *
 * The corrected forms are also a claim about the FOUR EXISTING RULES: each one is
 * written the way `no-empty-catch`, `no-sentinel-catch`, `require-cause-on-rethrow`
 * and `no-ddl-in-catch` want it, so a repair this gate accepts cannot be one
 * `oxlint` rejects. `no-swallow.gate.test.ts` owns proving that from the other
 * side; this file owns the half the lint rules cannot see.
 */

import { describe, expect, test } from 'bun:test';

import {
  DROP_CLASSES, auditCorpus, auditFile, census, keyOf, type DropClass,
} from './silent-drop';
import { readSources } from './sources';

/** `file` matters: `parse` selects tsx by extension, and two of these cases are
 *  UI code. */
const classesIn = (code: string, file = 'fixture.ts'): readonly DropClass[] =>
  auditFile(file, code).map((drop) => drop.kind);

interface Case {
  /** The defect, as it appears in this tree. */
  readonly bad: string;
  /** The same work, written so the failure survives. */
  readonly good: string;
  /** Where the shape below was read from, so a reworded fixture is visibly a
   *  different claim rather than a quiet one. */
  readonly seenAt: string;
}

const cases = {
  logged_default: {
    seenAt: 'packages/cf-backend/src/user/user-do.ts#readCredential',
    bad: `declare const log: { warn: (m: string) => void };
export function readCredential(read: () => string): string | null {
  try {
    return read();
  } catch (error) {
    log.warn('credential unreadable');
    return null;
  }
}
`,
    good: `declare const isMissingTable: (options: { cause: unknown }) => boolean;
export function readCredential(read: () => string): string | null {
  try {
    return read();
  } catch (error) {
    if (!isMissingTable({ cause: error })) throw error;
    return null;
  }
}
`,
  },
  message_only: {
    seenAt: '176 inline sites across 89 files at 2b7b020f, e.g. packages/core/src/eval/runner.ts',
    bad: `declare const log: { warn: (m: string) => void };
export function save(write: () => void): void {
  try {
    write();
  } catch (error) {
    log.warn(\`save failed: \${error instanceof Error ? error.message : String(error)}\`);
  }
}
`,
    good: `declare const log: { warn: (m: string) => void };
declare const renderThrownChain: (input: { cause: unknown }) => string;
export function save(write: () => void): void {
  try {
    write();
  } catch (error) {
    log.warn(\`save failed: \${renderThrownChain({ cause: error })}\`);
  }
}
`,
  },
  projecting_helper: {
    seenAt: '26 files at 2b7b020f, under eight names — errorMessage, errorText, '
      + 'formatMcpError, describe, reasonText, errText, providerFailureReason, message',
    bad: `export function errorMessage<Thrown>(thrown: Thrown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
`,
    good: `declare const renderThrownChain: (input: { cause: unknown }) => string;
export function errorMessage<Thrown>(thrown: Thrown): string {
  return renderThrownChain({ cause: thrown });
}
`,
  },
  handler_absorbs: {
    seenAt: 'packages/cli/src/tui/chat-app.tsx#performWalkback',
    bad: `declare const close: () => Promise<void>;
declare let closing: boolean;
export function walkback(): void {
  void close().catch((closeError) => { closing = false; });
}
`,
    good: `declare const close: () => Promise<void>;
declare let closing: boolean;
declare const log: { failure: (name: string, error: Error) => void };
export function walkback(): void {
  void close().catch((closeError: Error) => {
    closing = false;
    log.failure('walkback.close_failed', closeError);
  });
}
`,
  },
  handler_drops_cause: {
    seenAt: 'not present at HEAD — the class exists because the rule cannot see it',
    bad: `declare const load: () => Promise<string>;
export function plan(): Promise<string> {
  return load().catch((error) => { throw new Error('plan unreadable'); });
}
`,
    good: `declare const load: () => Promise<string>;
export function plan(): Promise<string> {
  return load().catch((error) => { throw new Error('plan unreadable', { cause: error }); });
}
`,
  },
  voided_promise: {
    seenAt: 'packages/cf-backend/src/orchestrator.ts#onChatResponse',
    bad: `declare const reconcile: () => Promise<void>;
export function afterTurn(): void {
  void reconcile();
}
`,
    good: `declare const reconcile: () => Promise<void>;
declare const log: { failure: (name: string, error: Error) => void };
export function afterTurn(): void {
  void reconcile().then(undefined, (error: Error) => log.failure('turn.reconcile_failed', error));
}
`,
  },
  floating_rejection: {
    seenAt: 'packages/cf-backend/src/components/FilesPane.tsx',
    bad: `export async function refresh(path: string): Promise<void> { await fetch(path); }
export function onDrop(path: string): void {
  refresh(path);
}
`,
    good: `export async function refresh(path: string): Promise<void> { await fetch(path); }
export async function onDrop(path: string): Promise<void> {
  await refresh(path);
}
`,
  },
} satisfies Readonly<Record<DropClass, Case>>;

describe('silent-drop', () => {
  test('every class it claims to search is a class it can find', () => {
    // The list and the case table are one set, so a seventh class cannot be added
    // with no fixture and no reachability claim behind it.
    expect(Object.keys(cases).sort()).toEqual([...DROP_CLASSES].sort());
  });

  for (const name of DROP_CLASSES) {
    const { bad, good, seenAt } = cases[name];
    test(`${name}: fires on the defect (${seenAt})`, () => {
      expect(classesIn(bad)).toContain(name);
    });
    test(`${name}: silent on the repair`, () => {
      expect(classesIn(good)).not.toContain(name);
    });
  }

  test('a handler that FORWARDS its error is not a drop', () => {
    // The distinction that took this gate from 28 false findings to 7 real ones:
    // `reject(err)` hands the failure to whoever owns the promise, so nothing was
    // dropped, even though the handler neither rethrows nor logs.
    expect(classesIn(`declare const signal: { removeEventListener: (n: string, f: () => void) => void };
declare const onAbort: () => void;
export function raceAbort(p: Promise<void>, reject: (e: Error) => void): void {
  void p.catch((err: Error) => { signal.removeEventListener('abort', onAbort); reject(err); });
}
`)).toEqual([]);
  });

  test('an async function that cannot reject is not a floating rejection', () => {
    // 20 of this tree's `void` statements are this exact React shape. Counting
    // them would bury the ones that do discard a rejection.
    expect(classesIn(`declare const setError: (m: string) => void;
declare const fetchRows: () => Promise<void>;
const load = async (): Promise<void> => {
  try { await fetchRows(); } catch (error) { setError(String(error)); }
};
export function mount(): void { void load(); }
`)).toEqual(['message_only']);
  });

  test('containment is about the awaits, not the shape of the body', () => {
    // The React spelling: two state calls, then the try. An earlier draft demanded
    // the whole body BE the try and reported 19 of these.
    expect(classesIn(`declare const setLoading: (v: boolean) => void;
declare const setError: (m: string | null) => void;
declare const fetchRows: () => Promise<void>;
const load = async (): Promise<void> => {
  setLoading(true);
  setError(null);
  try { await fetchRows(); } catch (error) { setError(renderThrownChain({ cause: error })); }
  finally { setLoading(false); }
};
export function mount(): void { void load(); }
`)).toEqual([]);
  });

  test('an await OUTSIDE the guarded try is still a floating rejection', () => {
    // The other direction of the same judgement: containment must not be granted
    // by the mere PRESENCE of a try somewhere in the body.
    expect(classesIn(`declare const setError: (m: string) => void;
declare const fetchRows: () => Promise<void>;
declare const commit: () => Promise<void>;
const load = async (): Promise<void> => {
  try { await fetchRows(); } catch (error) { setError(renderThrownChain({ cause: error })); }
  await commit();
};
export function mount(): void { void load(); }
`)).toEqual(['voided_promise']);
  });

  test('a typed `.message` field that is not an error is not a dropped chain', () => {
    // 11 of the first 15 `projecting_helper` findings were this: valibot issues,
    // chat events and timeline rows all carry a `message`, and reading one is not
    // flattening an error. The function has to say it is handling an error.
    expect(classesIn(`import * as v from 'valibot';
export function reasons(issues: readonly v.BaseIssue<unknown>[]): readonly string[] {
  return issues.map((issue) => issue.message);
}
`)).toEqual([]);
  });

  test('a one-statement sentinel handler is left to no-sentinel-catch', () => {
    // Not this gate's, and claiming it would make the two counts overlap so
    // neither could be read.
    expect(classesIn(`export function read(get: () => string): string | null {
  try { return get(); } catch { return null; }
}
`)).toEqual([]);
  });

  test('the ratchet key survives an edit above the site', () => {
    const body = `declare const log: { warn: (m: string) => void };
export function readCredential(read: () => string): string | null {
  try { return read(); } catch (error) { log.warn('no'); return null; }
}
`;
    const [before] = auditFile('a.ts', body);
    const [after] = auditFile('a.ts', `// a comment nobody read\n${body}`);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after!.line).toBe(before!.line + 1);
    expect(keyOf(after!)).toBe(keyOf(before!));
  });

  test('the live corpus is the one no-swallow measures, and it is not empty', () => {
    const sources = readSources();
    const catches = [...sources.values()]
      .reduce((total, text) => total + (text.match(/\bcatch\b/gu)?.length ?? 0), 0);
    expect(sources.size).toBeGreaterThan(0);
    expect(catches).toBeGreaterThan(0);

    // A census over the real tree, so a scan that silently stopped parsing is a
    // failure here rather than a clean report. The floor is deliberately far
    // below the 254 instances measured at 2b7b020f: this asserts the scan RUNS,
    // and the lock asserts which sites.
    const counts = census(auditCorpus(sources));
    const total = DROP_CLASSES.reduce((sum, name) => sum + (counts.get(name) ?? 0), 0);
    expect(total).toBeGreaterThan(20);
  // Measured 3.5 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);
});
