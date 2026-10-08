import { WORKSPACE_ROOT } from '@kinu.run/core';
import type { EvalPart } from '../src/task';
import type { EvalVerifier } from '../src/verifier';
import { Seeded } from './seeded';

// A month of a bakery's bank export and its own books, four hundred rows each, with a dozen apart:
// missing on one side, or booked for another amount. The agent writes the reconciliation and then
// answers with a sum nobody computes in their head. Every answer is computed here from the same rows.


const DIR = `${WORKSPACE_ROOT}/ledger`;

const REPORT = `${WORKSPACE_ROOT}/reconcile/report.csv`;

type Row = { id: string; date: string; cents: number };

type Ledgers = { bank: Row[]; books: Row[] };

const ROWS = 400;

function dollars(amount: number): string {
  return (amount / 100).toFixed(2);
}

/** Fisher-Yates over the seeded draws: each item taken, in turn, from what is left. */
function shuffled<T>(random: Seeded, items: readonly T[]): T[] {
  const left = [...items];

  return items.map(() => left.splice(random.int(0, left.length - 1), 1)[0]).filter((item): item is T => item !== undefined);
}

/** The same rows on both sides, then the planted differences: 4 only at the bank, 3 only in the books, 5 amounts apart. */
function generate(): Ledgers {
  const random = new Seeded(0x1ed9e7);
  const rows: Row[] = [];

  for (let index = 0; index < ROWS; index += 1) {
    rows.push({
      id: `TX${String(20_000 + index * 3 + random.int(0, 2))}`,
      date: `2027-08-${String(random.int(1, 31)).padStart(2, '0')}`,
      cents: random.pick([1, 1, 1, -1]) * random.int(150, 480_000),
    });
  }

  const planted = shuffled(random, rows.map((_, index) => index)).slice(0, 12);
  const onlyBank = new Set(planted.slice(0, 4));
  const onlyBooks = new Set(planted.slice(4, 7));
  const apart = new Set(planted.slice(7));

  const bank = rows.filter((_, index) => !onlyBooks.has(index));

  const books = rows
    .filter((_, index) => !onlyBank.has(index))
    .map((row) => apart.has(rows.indexOf(row)) ? { ...row, cents: row.cents + random.pick([-1, 1]) * random.int(1, 9_000) } : row);

  return { bank: shuffled(random, bank), books: shuffled(random, books) };
}

const LEDGERS = generate();

function csv(rows: readonly Row[]): string {
  return `id,date,amount\n${rows.map((row) => `${row.id},${row.date},${dollars(row.cents)}`).join('\n')}\n`;
}

type Mismatch = { id: string; bank: number | null; books: number | null };

/** Every id missing on one side or booked apart, sorted by id: the report the prompt asks for. */
function mismatches({ bank, books }: Ledgers): Mismatch[] {
  const atBank = new Map(bank.map((row) => [row.id, row.cents]));
  const inBooks = new Map(books.map((row) => [row.id, row.cents]));
  const ids = [...new Set([...atBank.keys(), ...inBooks.keys()])].sort();

  return ids
    .map((id) => ({ id, bank: atBank.get(id) ?? null, books: inBooks.get(id) ?? null }))
    .filter((row) => row.bank !== row.books);
}

const EXPECTED = mismatches(LEDGERS);

const DIFFERENCE_CENTS = EXPECTED.reduce((sum, row) => sum + Math.abs((row.bank ?? 0) - (row.books ?? 0)), 0);

/** An amount cell as cents: `-12.5`, `-12.50` and `"-12.50"` are one amount, and an empty cell is none. */
function cents(cell: string): number | null {
  const text = cell.trim().replace(/^"|"$/gu, '').replace(/^\$/u, '');

  if (text === '') return null;
  const value = Number(text);

  return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
}

function reportRows(text: string): Mismatch[] {
  const [header, ...lines] = text.trim().split(/\r?\n/u);

  if (header?.replace(/"/gu, '').replace(/\s/gu, '') !== 'id,bank_amount,books_amount') {
    throw new Error(`the header is ${JSON.stringify(header ?? '')}, not id,bank_amount,books_amount`);
  }

  return lines.filter((line) => line.trim() !== '').map((line) => {
    const [id = '', bank = '', books = ''] = line.split(',');

    return { id: id.trim().replace(/^"|"$/gu, ''), bank: cents(bank), books: cents(books) };
  });
}

async function checkReport(verifier: EvalVerifier): Promise<void> {
  await verifier.check('reports-every-mismatch-and-nothing-else', async () => {
    const rows = reportRows(await verifier.readFile(REPORT));
    const key = (row: Mismatch): string => `${row.id} ${String(row.bank)} ${String(row.books)}`;
    const got = new Set(rows.map(key));
    const missing = EXPECTED.filter((row) => !got.has(key(row))).map(key);
    const extra = rows.filter((row) => !EXPECTED.some((expected) => key(expected) === key(row))).map(key);

    return { pass: missing.length === 0 && extra.length === 0, evidence: { missing, extra, rows: rows.length } };
  });

  await verifier.check('sorted-by-id', async () => {
    const ids = reportRows(await verifier.readFile(REPORT)).map((row) => row.id);

    return { pass: ids.join(',') === [...ids].sort().join(','), evidence: { ids } };
  });
}

export const ledgerReconcile: EvalPart = {
  id: 'books',
  objectives: [
    'Write reconcile/report.csv with every mismatch between ledger/bank.csv and ledger/books.csv and nothing else, sorted by id.',
    'Answer with the sum of the absolute differences.',
  ],
  turns: [{
    seed: [
      { path: `${DIR}/bank.csv`, content: csv(LEDGERS.bank) },
      { path: `${DIR}/books.csv`, content: csv(LEDGERS.books) },
    ],
    prompt: `ledger/bank.csv is the bank's export for August and ledger/books.csv is what we booked; both
have the columns id,date,amount, amounts in dollars. Reconcile them: write reconcile/report.csv with the
header id,bank_amount,books_amount and one row for every transaction id that is missing on one side or
whose amounts differ, a missing side's amount left empty, sorted by id. Then reply with the sum of the
absolute differences over every row of the report, counting a missing amount as 0, rounded to 2 decimals.`,
    verify: async (verifier) => {
      await checkReport(verifier);

      await verifier.check('answers-with-the-sum-of-differences', async () => {
        const answer = verifier.bareAnswer(/^\$?(\d+(?:,\d{3})*(?:\.\d+)?)$/u);
        const value = answer === null ? null : Number(answer.replace(/,/gu, ''));

        return {
          pass: value !== null && Math.abs(value - DIFFERENCE_CENTS / 100) <= 0.0051,
          evidence: { answer, expected: dollars(DIFFERENCE_CENTS), replies: verifier.recentReplies() },
        };
      });
    },
  }],
};
