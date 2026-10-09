/**
 * The bank reconciliation and the inbox tidy-up, graded offline on a workspace that did the work and on one that got
 * it wrong in one place: each task's checks pass the first and fail exactly the check the wrong answer breaks.
 */
import { describe, expect, test } from 'bun:test';
import { WORKSPACE_ROOT } from '@kinu.run/core';
import { fileHousekeeping } from '../tasks/file-housekeeping';
import { ledgerReconcile } from '../tasks/ledger-reconcile';
import { EvalVerifier, type VerifierSession } from './verifier';
import type { EvalCheck, EvalTurn } from './task';

/** A workspace's files as the Files tab reads and lists them, and nothing else. */
function workspace(files: ReadonlyMap<string, string>): VerifierSession {
  const absent = () => Promise.reject(new Error('not read by these tasks'));

  return {
    web: { origin: 'http://127.0.0.1:8787', identity: { kind: 'loopback' }, workspace: 'eval-salvaged' },
    slateOp: absent, listSlates: absent, readBytes: absent, writeFile: absent, craftedTools: absent, runEvents: absent,
    memoryContent: absent, memoryFacts: absent, workspaceWork: absent, inspect: absent, swarmRuns: absent, execute: absent, exposedPorts: absent,
    readFile: (path) => Promise.resolve(files.get(path) ?? ''),
    listFiles: (dir) => Promise.resolve([...files.keys()].flatMap((path) => {
      const name = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : '';

      return name === '' || name.includes('/') ? [] : [{ name, type: 'file' as const }];
    })),
  };
}

/** The checks that fail on `files` and `replies`. */
async function failing(turn: EvalTurn, files: ReadonlyMap<string, string>, replies: readonly string[]): Promise<string[]> {
  if (turn.verify === undefined) throw new Error('the turn checks nothing');
  const checks: EvalCheck[] = await new EvalVerifier(workspace(files), replies, 0, () => Promise.resolve()).collect(turn.verify);

  return checks.filter((check) => !check.pass).map((check) => check.id);
}

const seeded = (turn: EvalTurn): ReadonlyMap<string, string> =>
  new Map((turn.seed ?? []).map((file) => [file.path, typeof file.content === 'string' ? file.content : '']));

describe('the bank reconciliation', () => {
  /** The rows of a seeded ledger by id, in cents. */
  const ledger = (text: string): Map<string, number> => new Map(text.trim().split('\n').slice(1)
    .map((line) => line.split(',')).map(([id = '', , amount = '']) => [id, Math.round(Number(amount) * 100)]));

  async function reconciled() {
    const turn = ledgerReconcile.turns[0];
    const files = seeded(turn);
    const bank = ledger(files.get(`${WORKSPACE_ROOT}/ledger/bank.csv`) ?? '');
    const books = ledger(files.get(`${WORKSPACE_ROOT}/ledger/books.csv`) ?? '');
    const apart = [...new Set([...bank.keys(), ...books.keys()])].sort().filter((id) => bank.get(id) !== books.get(id));
    const cell = (cents: number | undefined): string => (cents === undefined ? '' : (cents / 100).toFixed(2));
    const rows = apart.map((id) => `${id},${cell(bank.get(id))},${cell(books.get(id))}`);
    const sum = apart.reduce((total, id) => total + Math.abs((bank.get(id) ?? 0) - (books.get(id) ?? 0)), 0);
    const report = (lines: readonly string[]) => new Map([...files, [`${WORKSPACE_ROOT}/reconcile/report.csv`, `id,bank_amount,books_amount\n${lines.join('\n')}\n`]]);

    return { turn, rows, sum: (sum / 100).toFixed(2), report };
  }

  test('a report of every mismatch, sorted, and the right sum pass every check', async () => {
    const { turn, rows, sum, report } = await reconciled();

    expect(await failing(turn, report(rows), [sum])).toEqual([]);
  });

  test('the stated sum can be in prose: a correct total passes, a wrong stated total fails', async () => {
    const { turn, rows, sum, report } = await reconciled();

    for (const reply of [`Sum of absolute differences: **${sum}**`, `Wrote 12 rows. The total is $${Number(sum).toLocaleString('en-US', { minimumFractionDigits: 2 })}.`,
      `The sum over the report, counting a missing amount as 0: ${sum}\nVerified in integer cents (${String(Math.round(Number(sum) * 100))} cents).`]) {
      expect(await failing(turn, report(rows), [reply])).toEqual([]);
    }

    expect(await failing(turn, report(rows), [`Sum of absolute differences: ${(Number(sum) + 1).toFixed(2)}`])).toEqual(['answers-with-the-sum-of-differences']);
  });

  test('a mismatch left out, rows out of order, or a wrong sum each fail their own check', async () => {
    const { turn, rows, sum, report } = await reconciled();

    expect(await failing(turn, report(rows.slice(1)), [sum])).toEqual(['reports-every-mismatch-and-nothing-else']);
    expect(await failing(turn, report([...rows].reverse()), [sum])).toEqual(['sorted-by-id']);
    expect(await failing(turn, report(rows), [`${String(Number(sum) + 1)}.00`])).toEqual(['answers-with-the-sum-of-differences']);
  });
});

describe('the inbox tidy-up', () => {
  async function tidied() {
    const turn = fileHousekeeping.turns[0];
    const inbox = [...seeded(turn)].map(([path, content]) => ({ name: path.slice(path.lastIndexOf('/') + 1), content }));
    const copy = (name: string): boolean => / \(1\)\.| copy\./u.test(name);

    const folder = (name: string): string => {
      if (name.endsWith('.pdf')) return 'archive/invoices';

      return /\.(?:jpg|png)$/u.test(name) ? 'archive/photos' : 'inbox';
    };

    const tidy = new Map(inbox.filter((file) => !copy(file.name)).map((file) => [`${WORKSPACE_ROOT}/${folder(file.name)}/${file.name}`, file.content]));

    return { turn, tidy };
  }

  test('invoices and photos archived by name, copies gone and notes left pass every check', async () => {
    const { turn, tidy } = await tidied();

    expect(await failing(turn, tidy, [])).toEqual([]);
  });

  test('a copy kept, or a file whose bytes changed on the way, fails the folder it is in', async () => {
    const { turn, tidy } = await tidied();
    const keptCopy = new Map([...tidy, [`${WORKSPACE_ROOT}/archive/photos/IMG_2041 (1).jpg`, 'photo']]);
    const invoice = [...tidy.keys()].find((path) => path.includes('/archive/invoices/')) ?? '';

    expect(await failing(turn, keptCopy, [])).toEqual(['photos-are-archived']);
    expect(await failing(turn, new Map([...tidy, [invoice, 'rewritten']]), [])).toEqual(['invoices-are-archived']);
  });
});
