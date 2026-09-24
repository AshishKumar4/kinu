import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { matchesReference, type EvalVerifier, type Script, type SlateClient } from '../src/verifier';

// An office lending library, worked the way a person would: build it, write up who is late from
// it, change the rules, then ask it a question. The checker makes every request itself and answers
// each one with its own library below, so any build that follows the rules passes.

const MISSION = 'The Hollis & Park office workspace. We keep a small lending library of books for the team.';

const MEMBERS = ['ana', 'bo', 'cy', 'dee', 'eli'];

type Book = { bookId: string; title: string; author: string };

const BOOKS: readonly Book[] = [
  { bookId: 'B-1042', title: 'The Pragmatic Programmer', author: 'Hunt' },
  { bookId: 'B-1007', title: 'Designing Data-Intensive Applications', author: 'Kleppmann' },
  { bookId: 'B-1033', title: 'The Mythical Man-Month', author: 'Brooks' },
  { bookId: 'B-1019', title: 'Refactoring', author: 'Fowler' },
  { bookId: 'B-1051', title: 'Clean Architecture', author: 'Martin' },
  { bookId: 'B-1026', title: 'Working Effectively with Legacy Code', author: 'Feathers' },
  { bookId: 'B-1060', title: 'Site Reliability Engineering', author: 'Beyer' },
  { bookId: 'B-1015', title: 'Release It!', author: 'Nygard' },
];

// Four more, bought when the rules change; staff take most of them.
const NEW_BOOKS: readonly Book[] = [
  { bookId: 'B-1073', title: 'Accelerate', author: 'Forsgren' },
  { bookId: 'B-1070', title: 'Domain-Driven Design', author: 'Evans' },
  { bookId: 'B-1072', title: 'The Phoenix Project', author: 'Kim' },
  { bookId: 'B-1071', title: 'Team Topologies', author: 'Skelton' },
];

const REPORT_PATH = '/home/user/reports/overdue.md';

const REPORT_DATE = '2027-03-15';

const QUESTION_DATE = '2027-04-20';

// ── The contract ─────────────────────────────────────────────────────

const METHODS = ['addBook', 'lend', 'giveBack', 'loans', 'overdue'] as const;

type Method = (typeof METHODS)[number];

/** A calendar day; a timestamp an implementation returns is read as its day. */
const Day = v.pipe(v.string(), v.transform((text) => text.slice(0, 10)));

const Refused = v.object({ ok: v.literal(false), error: v.string() });

const ANSWERS: Record<Method, v.GenericSchema<JsonValue>> = {
  addBook: v.variant('ok', [v.object({ ok: v.literal(true) }), Refused]),
  lend: v.variant('ok', [v.object({ ok: v.literal(true), dueIso: Day }), Refused]),
  giveBack: v.variant('ok', [v.object({ ok: v.literal(true), daysLate: v.number() }), Refused]),
  loans: v.object({ loans: v.array(v.object({ bookId: v.string(), member: v.string(), lentIso: Day, dueIso: Day })) }),
  overdue: v.object({ loans: v.array(v.object({ bookId: v.string(), member: v.string(), dueIso: Day, daysOverdue: v.number() })) }),
};

/** What is compared is the contract: extra fields are dropped, and an answer that breaks it is compared raw. */
function normalize(method: Method, answer: JsonValue): JsonValue {
  const parsed = v.safeParse(ANSWERS[method], answer);

  return parsed.success ? parsed.output : answer;
}

// ── The checker's own library ────────────────────────────────────────

const DAY_MS = 86_400_000;

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

type Rules = { limit: number; days: number; staff: readonly string[]; staffLimit: number; staffDays: number; suspendAfterDaysLate: number | null };

const FIRST_RULES: Rules = { limit: 3, days: 14, staff: [], staffLimit: 3, staffDays: 14, suspendAfterDaysLate: null };

const TURN_3_RULES: Rules = { limit: 3, days: 14, staff: ['dee', 'eli'], staffLimit: 5, staffDays: 28, suspendAfterDaysLate: 10 };

const SUSPENSION_DAYS = 7;

type Loan = { bookId: string; member: string; lentIso: string; dueIso: string };

const BookInput = v.object({ bookId: v.string(), title: v.string(), author: v.string() });

const LendInput = v.object({ bookId: v.string(), member: v.string(), dateIso: v.string() });

const ReturnInput = v.object({ bookId: v.string(), dateIso: v.string() });

/** The rules exactly as the prompts state them. */
class ReferenceLibrary {
  rules = FIRST_RULES;
  readonly #titles = new Map<string, string>();
  readonly #loans = new Map<string, Loan>();
  /** Member -> the first day they may borrow again. */
  readonly #suspended = new Map<string, string>();

  addBook(book: v.InferOutput<typeof BookInput>): JsonValue {
    if (this.#titles.has(book.bookId)) return { ok: false, error: 'DUPLICATE_BOOK' };
    this.#titles.set(book.bookId, book.title);

    return { ok: true };
  }

  lend({ bookId, member, dateIso }: v.InferOutput<typeof LendInput>): JsonValue {
    const staff = this.rules.staff.includes(member);

    if (!this.#titles.has(bookId)) return { ok: false, error: 'UNKNOWN_BOOK' };

    if (!MEMBERS.includes(member)) return { ok: false, error: 'UNKNOWN_MEMBER' };

    if (this.#loans.has(bookId)) return { ok: false, error: 'ON_LOAN' };

    if (dateIso < (this.#suspended.get(member) ?? '')) return { ok: false, error: 'SUSPENDED' };

    if (this.loansOf(member).length >= (staff ? this.rules.staffLimit : this.rules.limit)) return { ok: false, error: 'LIMIT_REACHED' };
    const dueIso = addDays(dateIso, staff ? this.rules.staffDays : this.rules.days);
    this.#loans.set(bookId, { bookId, member, lentIso: dateIso, dueIso });

    return { ok: true, dueIso };
  }

  giveBack({ bookId, dateIso }: v.InferOutput<typeof ReturnInput>): JsonValue {
    const loan = this.#loans.get(bookId);

    if (loan === undefined) return { ok: false, error: 'NOT_ON_LOAN' };
    this.#loans.delete(bookId);
    const daysLate = Math.max(0, daysFrom(loan.dueIso, dateIso));

    if (this.rules.suspendAfterDaysLate !== null && daysLate > this.rules.suspendAfterDaysLate) {
      this.#suspended.set(loan.member, addDays(dateIso, SUSPENSION_DAYS));
    }

    return { ok: true, daysLate };
  }

  loansOf(member?: string): Loan[] {
    return [...this.#loans.values()].filter((loan) => member === undefined || loan.member === member)
      .sort((left, right) => left.dueIso.localeCompare(right.dueIso) || left.bookId.localeCompare(right.bookId));
  }

  overdueOn(asOfIso: string): { bookId: string; member: string; dueIso: string; daysOverdue: number }[] {
    return this.loansOf().filter((loan) => loan.dueIso < asOfIso)
      .map(({ bookId, member, dueIso }) => ({ bookId, member, dueIso, daysOverdue: daysFrom(dueIso, asOfIso) }))
      .sort((left, right) => right.daysOverdue - left.daysOverdue || left.bookId.localeCompare(right.bookId));
  }

  title(bookId: string): string {
    return this.#titles.get(bookId) ?? bookId;
  }

  /** The contract's methods over this library, called the way the checker calls the slate. */
  client(): SlateClient<Method> {
    return (method, input) => Promise.resolve(this.#answer(method, input ?? {}));
  }

  #answer(method: Method, input: JsonValue): JsonValue {
    switch (method) {
      case 'addBook': return this.addBook(v.parse(BookInput, input));
      case 'lend': return this.lend(v.parse(LendInput, input));
      case 'giveBack': return this.giveBack(v.parse(ReturnInput, input));
      case 'loans': return { loans: this.loansOf(v.parse(v.object({ member: v.optional(v.string()) }), input).member) };
      case 'overdue': return { loans: this.overdueOn(v.parse(v.object({ asOfIso: v.string() }), input).asOfIso) };
    }
  }
}

// ── The checker's requests, in the order it makes them ──────────────

const stockTheShelf: Script<Method> = async (library) => {
  for (const book of BOOKS) await library('addBook', book);
};

const lendFebruary: Script<Method> = async (library) => {
  for (const [bookId, member, dateIso] of [
    ['B-1042', 'ana', '2027-02-01'], ['B-1007', 'bo', '2027-02-03'], ['B-1033', 'ana', '2027-02-10'], ['B-1051', 'dee', '2027-02-20'],
    ['B-1019', 'cy', '2027-02-24'], ['B-1026', 'ana', '2027-03-01'], ['B-1060', 'eli', '2027-03-05'],
  ]) await library('lend', { bookId, member, dateIso });

  await library('loans');
  await library('loans', { member: 'ana' });
};

// Each request breaks exactly one rule, so no implementation has to guess which rule wins.
const refuseBadRequests: Script<Method> = async (library) => {
  await library('addBook', { bookId: 'B-1033', title: 'The Mythical Man-Month', author: 'Brooks' });
  await library('lend', { bookId: 'B-9999', member: 'bo', dateIso: '2027-03-06' });
  await library('lend', { bookId: 'B-1015', member: 'zed', dateIso: '2027-03-06' });
  await library('lend', { bookId: 'B-1042', member: 'bo', dateIso: '2027-03-06' });
  await library('lend', { bookId: 'B-1015', member: 'ana', dateIso: '2027-03-06' });
  await library('giveBack', { bookId: 'B-1015', dateIso: '2027-03-06' });
  await library('loans');
};

// B-1051 falls due on 2027-03-06, so it is overdue on the 10th and not on the 6th itself.
const returnTwo: Script<Method> = async (library) => {
  await library('giveBack', { bookId: 'B-1007', dateIso: '2027-03-08' });
  await library('giveBack', { bookId: 'B-1019', dateIso: '2027-03-09' });
  await library('overdue', { asOfIso: '2027-03-10' });
  await library('overdue', { asOfIso: '2027-03-06' });
  await library('loans');
};

const TURN_1: readonly Script<Method>[] = [stockTheShelf, lendFebruary, refuseBadRequests, returnTwo];

const listLoans: Script<Method> = async (library) => {
  await library('loans');
};

// dee is staff now: five books, 28 days each. ana is not: still three.
const staffBorrow: Script<Method> = async (library) => {
  for (const book of NEW_BOOKS) await library('addBook', book);

  for (const bookId of ['B-1015', 'B-1070', 'B-1071', 'B-1072', 'B-1073']) await library('lend', { bookId, member: 'dee', dateIso: '2027-03-20' });

  await library('lend', { bookId: 'B-1073', member: 'bo', dateIso: '2027-03-20' });
  await library('lend', { bookId: 'B-1007', member: 'ana', dateIso: '2027-03-20' });
  await library('loans', { member: 'dee' });
};

// ana brings two books back weeks late and is shut out until the 27th; bo is two days late and is not.
const lateReturns: Script<Method> = async (library) => {
  await library('giveBack', { bookId: 'B-1042', dateIso: '2027-03-20' });
  await library('giveBack', { bookId: 'B-1033', dateIso: '2027-03-20' });
  await library('lend', { bookId: 'B-1019', member: 'ana', dateIso: '2027-03-26' });
  await library('lend', { bookId: 'B-1019', member: 'ana', dateIso: '2027-03-27' });
  await library('giveBack', { bookId: 'B-1073', dateIso: '2027-04-05' });
  await library('lend', { bookId: 'B-1042', member: 'bo', dateIso: '2027-04-05' });
  await library('loans');
};

const TURN_3: readonly Script<Method>[] = [staffBorrow, lateReturns];

// After the eviction the rules still hold: dee is at her staff limit, cy still gets 14 days.
const afterEviction: Script<Method> = async (library) => {
  await library('loans');
  await library('lend', { bookId: 'B-1033', member: 'dee', dateIso: '2027-04-06' });
  await library('lend', { bookId: 'B-1007', member: 'cy', dateIso: '2027-04-06' });
};

// ── Checker helpers ──────────────────────────────────────────────────

/** A turn's requests, or a rule change the prompt made between them. */
type Step = readonly Script<Method>[] | Rules;

/** The checker's library after `history`: the requests replayed, the rules changed where the prompts changed them. */
async function referenceAfter(history: readonly Step[]): Promise<ReferenceLibrary> {
  const library = new ReferenceLibrary();

  for (const step of history) {
    if ('limit' in step) library.rules = step;
    else for (const script of step) await script(library.client());
  }

  return library;
}

async function sameAsReference(verifier: EvalVerifier, id: string, history: readonly Step[], script: Script<Method>): Promise<void> {
  await verifier.check(id, async () => matchesReference({
    slate: verifier.slate('library', METHODS), reference: (await referenceAfter(history)).client(), script, normalize,
  }));
}

/** The report's bullets: `- <title> · <member> · <n> days`, any dash or dot as the separator. */
function reportLines(markdown: string): string[] {
  return markdown.split('\n').map((line) => line.trim()).filter((line) => /^[-*] /.test(line));
}

function describes(line: string, loan: { title: string; member: string; daysOverdue: number }): boolean {
  const fields = line.slice(2).split(/\s+[·•|—–-]\s+/).map((field) => field.replace(/[*_`"']/g, '').trim().toLowerCase());

  return fields[0] === loan.title.toLowerCase() && fields[1] === loan.member
    && new RegExp(`^${String(loan.daysOverdue)}\\s+days?$`).test(fields[2] ?? '');
}

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'lending-library',
  mission: MISSION,
  turns: [{
    prompt: `Build a slate with id "library" for our office lending library, keeping everything in the slate's
own storage. Our members are ana, bo, cy, dee and eli. Dates are calendar days written YYYY-MM-DD.

The rules:
- A member holds at most 3 books at once. Reject with "LIMIT_REACHED".
- A book on loan cannot be lent again until it comes back. Reject with "ON_LOAN".
- A loan is due 14 days after the day it was lent.
- Reject a book id that is not in the library with "UNKNOWN_BOOK", a member who is not ours with
  "UNKNOWN_MEMBER", a book id that is already in the library with "DUPLICATE_BOOK", and returning a
  book that is not on loan with "NOT_ON_LOAN".
A rejected request changes nothing.

Its server methods take and return plain data, so I can check it:
- addBook({ bookId, title, author }) -> { ok: true } | { ok: false, error }
- lend({ bookId, member, dateIso }) -> { ok: true, dueIso } | { ok: false, error }
- giveBack({ bookId, dateIso }) -> { ok: true, daysLate } | { ok: false, error }
  daysLate is how many days after its due date the book came back; 0 when it was on time.
- loans({ member? }) -> { loans: Array<{ bookId, member, lentIso, dueIso }> }
  Every book on loan now, for one member or for all, sorted by dueIso then bookId.
- overdue({ asOfIso }) -> { loans: Array<{ bookId, member, dueIso, daysOverdue }> }
  The loans whose due date is before asOfIso, most days overdue first, ties by bookId.

Leave the library empty when you are done: I will add the books myself.`,
    verify: async (verifier) => {
      await sameAsReference(verifier, 'adds-books-and-lends-them', [], async (library) => {
        await stockTheShelf(library);
        await lendFebruary(library);
      });

      await sameAsReference(verifier, 'rejects-bad-requests-without-changing-anything', [[stockTheShelf, lendFebruary]], refuseBadRequests);
      await sameAsReference(verifier, 'returns-count-days-late-and-overdue-lists-them', [[stockTheShelf, lendFebruary, refuseBadRequests]], returnTwo);
    },
  }, {
    prompt: `Write the overdue report for ${REPORT_DATE} to ${REPORT_PATH}, taken from the library, not retyped. The first
line is \`# Overdue on ${REPORT_DATE}\`. Then one line per overdue loan, most days overdue first, ties by book id,
each in the form \`- <title> · <member> · <n> days\`.`,
    verify: async (verifier) => {
      await verifier.check('report-lists-exactly-the-overdue-loans', async () => {
        const library = await referenceAfter([TURN_1]);
        const expected = library.overdueOn(REPORT_DATE).map((loan) => ({ ...loan, title: library.title(loan.bookId) }));
        const markdown = await verifier.readFile(REPORT_PATH);
        const lines = reportLines(markdown);
        const heading = markdown.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

        return {
          pass: heading === `# Overdue on ${REPORT_DATE}` && lines.length === expected.length
            && expected.every((loan, index) => describes(lines[index] ?? '', loan)),
          evidence: { heading, lines, expected: expected.map((loan) => `- ${loan.title} · ${loan.member} · ${String(loan.daysOverdue)} days`) },
        };
      });

      await sameAsReference(verifier, 'writing-the-report-changes-nothing', [TURN_1], listLoans);
    },
  }, {
    prompt: `Two rule changes. dee and eli are staff now: staff may hold 5 books at once, and their loans are due 28
days after the day they were lent. And a member who returns a book more than 10 days late may not
borrow for 7 days: lend answers "SUSPENDED" for any date before the return date plus 7 days. Loans
already out keep their due dates.`,
    verify: async (verifier) => {
      await sameAsReference(verifier, 'loans-already-out-keep-their-due-dates', [TURN_1], listLoans);
      await sameAsReference(verifier, 'staff-hold-five-books-for-28-days', [TURN_1, TURN_3_RULES], staffBorrow);
      await sameAsReference(verifier, 'late-returns-suspend-for-a-week', [TURN_1, TURN_3_RULES, [staffBorrow]], lateReturns);
    },
    verifyAfterEviction: async (verifier) => {
      await sameAsReference(verifier, 'loans-and-rules-survive-an-eviction', [TURN_1, TURN_3_RULES, TURN_3], afterEviction);
    },
  }, {
    prompt: `How many books are overdue on ${QUESTION_DATE}? Reply with just the number.`,
    verify: async (verifier) => {
      await verifier.check('answers-with-the-count-from-the-library', async () => {
        const expected = (await referenceAfter([TURN_1, TURN_3_RULES, TURN_3, [afterEviction]])).overdueOn(QUESTION_DATE).length;
        const answer = verifier.bareAnswer(/^(\d+)$/);

        return { pass: answer !== null && Number(answer) === expected, evidence: { answer, expected, replies: verifier.recentReplies() } };
      });
    },
  }],
});

defineTaskEval(task);
