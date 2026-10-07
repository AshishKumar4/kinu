import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { defineTaskEval } from '../src/eval';
import { shows, sightEvidence, type Sight } from '../src/sight';
import { defineEvalTask, type EvidenceCall } from '../src/task';
import { matchesReference, SLATE_CAUSE, SlateRefusal, type EvalCheckOutcome, type EvalVerifier, type Normalize, type Script, type SlateClient } from '../src/verifier';

// Two slates that depend on each other: a ledger of team expenses, and a budget board that reads
// the ledger through an app binding instead of keeping its own copy. The board gets a page, checked
// in the browser as its owner sees it: in the work surface and in the chat, its buttons pressed, one
// of them asking the agent. Euros and an exchange-rate file arrive, the ledger's listing is replaced
// by pages, then the board is asked a question. The checker records every expense itself and
// answers each request, and computes each figure the page must show, with its own books below.

const MISSION = "Northwind Studio's operations workspace. We track what each team spends against its monthly budget.";

const TEAMS = ['design', 'growth', 'platform', 'support'];

const RATES_PATH = '/home/user/fx/rates.json';

const QUESTION_MONTH = '2027-03';

const NOTES = '/home/user/budget/notes';

/** Recorded by the checker while the page is open, after the page was built: growth stays within budget. */
const LATE_EXPENSE = { id: 'x-341', team: 'growth', amountCents: 1_234, category: 'software', dateIso: '2027-03-26' };

type Expense = { id: string; team: string; amountCents: number; category: string; dateIso: string; currency?: string };

// Out of date and id order, so a listing that returns insertion order does not pass.
const EXPENSES: readonly Expense[] = [
  { id: 'x-311', team: 'growth', amountCents: 125_000, category: 'ads', dateIso: '2027-03-04' },
  { id: 'x-207', team: 'design', amountCents: 38_900, category: 'software', dateIso: '2027-02-11' },
  { id: 'x-318', team: 'platform', amountCents: 64_250, category: 'cloud', dateIso: '2027-03-09' },
  { id: 'x-301', team: 'design', amountCents: 12_500, category: 'fonts', dateIso: '2027-03-01' },
  { id: 'x-322', team: 'growth', amountCents: 98_000, category: 'events', dateIso: '2027-03-15' },
  { id: 'x-214', team: 'platform', amountCents: 71_000, category: 'cloud', dateIso: '2027-02-18' },
  { id: 'x-330', team: 'support', amountCents: 8_400, category: 'software', dateIso: '2027-03-22' },
  { id: 'x-309', team: 'design', amountCents: 54_000, category: 'contractors', dateIso: '2027-03-09' },
  { id: 'x-203', team: 'growth', amountCents: 150_000, category: 'ads', dateIso: '2027-02-03' },
  { id: 'x-326', team: 'platform', amountCents: 88_800, category: 'hardware', dateIso: '2027-03-18' },
  { id: 'x-315', team: 'growth', amountCents: 47_500, category: 'ads', dateIso: '2027-03-09' },
  { id: 'x-229', team: 'support', amountCents: 19_900, category: 'training', dateIso: '2027-02-27' },
];

type Budget = { team: string; month: string; amountCents: number };

// growth's March budget is set twice: the second replaces the first.
const BUDGETS: readonly Budget[] = [
  { team: 'design', month: '2027-03', amountCents: 150_000 },
  { team: 'growth', month: '2027-03', amountCents: 250_000 },
  { team: 'platform', month: '2027-03', amountCents: 200_000 },
  { team: 'design', month: '2027-02', amountCents: 40_000 },
  { team: 'growth', month: '2027-03', amountCents: 300_000 },
];

const FIRST_RATE = { EUR: 1.0875 };

const SECOND_RATE = { EUR: 1.1234 };

const EURO_EXPENSES: readonly Expense[] = [
  // Puts platform over its March budget at the second rate and not at the first.
  { id: 'x-334', team: 'platform', amountCents: 42_480, category: 'cloud', dateIso: '2027-03-24', currency: 'EUR' },
  { id: 'x-337', team: 'growth', amountCents: 23_455, category: 'events', dateIso: '2027-03-25', currency: 'EUR' },
  { id: 'x-335', team: 'design', amountCents: 9_990, category: 'software', dateIso: '2027-03-24', currency: 'EUR' },
];

// ── The contract ─────────────────────────────────────────────────────

const LEDGER_METHODS = ['record', 'entries', 'page'] as const;

const BOARD_METHODS = ['setBudget', 'status'] as const;

const METHODS = [...LEDGER_METHODS, ...BOARD_METHODS];

type Method = (typeof METHODS)[number];

const Answer = v.variant('ok', [v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), error: v.string() })]);

const Row = { id: v.string(), team: v.string(), amountCents: v.number(), category: v.string(), dateIso: v.string() };

const StatusSchema = v.object({
  teams: v.array(v.object({ team: v.string(), budgetCents: v.number(), spentCents: v.number(), remainingCents: v.number(), over: v.boolean() })),
});

const PageSchema = v.object({ entries: v.array(v.object({ ...Row, currency: v.string() })), next: v.nullable(v.string()) });

/** Turn 1's contract has no currency; from turn 2 each listed expense carries one. */
function normalizer(currency: boolean): Normalize<Method> {
  const answers: Record<Method, v.GenericSchema<JsonValue>> = {
    record: Answer,
    setBudget: Answer,
    entries: v.object({ entries: v.array(currency ? v.object({ ...Row, currency: v.string() }) : v.object(Row)) }),
    page: v.union([PageSchema, Answer]),
    status: StatusSchema,
  };

  return (method, answer) => {
    const parsed = v.safeParse(answers[method], answer);

    return parsed.success ? parsed.output : answer;
  };
}

// ── The checker's own books ──────────────────────────────────────────

const RecordInput = v.object({
  id: v.string(), team: v.string(), amountCents: v.number(), category: v.string(), dateIso: v.string(), currency: v.optional(v.string()),
});

const BudgetInput = v.object({ team: v.string(), month: v.string(), amountCents: v.number() });

const Filter = v.object({ team: v.optional(v.string()), month: v.optional(v.string()) });

/** US cents for one expense at `rate`, halves rounding up; the planted amounts never land near a half. */
function usCents(expense: Expense, rate: number): number {
  return expense.currency === 'EUR' ? Math.round(expense.amountCents * rate) : expense.amountCents;
}

type StatusRow = { team: string; budgetCents: number; spentCents: number; remainingCents: number; over: boolean };

class ReferenceBooks {
  rate = FIRST_RATE.EUR;
  readonly #expenses: Required<Expense>[] = [];
  readonly #budgets = new Map<string, number>();

  record(input: v.InferOutput<typeof RecordInput>): JsonValue {
    const currency = input.currency ?? 'USD';

    if (this.#expenses.some((expense) => expense.id === input.id)) return { ok: false, error: 'DUPLICATE_ID' };

    if (!TEAMS.includes(input.team)) return { ok: false, error: 'UNKNOWN_TEAM' };

    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return { ok: false, error: 'BAD_AMOUNT' };

    if (currency !== 'USD' && currency !== 'EUR') return { ok: false, error: 'UNKNOWN_CURRENCY' };
    this.#expenses.push({ ...input, currency });

    return { ok: true };
  }

  listed(filter: v.InferOutput<typeof Filter>): Required<Expense>[] {
    return this.#expenses.filter((expense) => (filter.team === undefined || expense.team === filter.team)
      && (filter.month === undefined || expense.dateIso.startsWith(filter.month)))
      .sort((left, right) => left.dateIso.localeCompare(right.dateIso) || left.id.localeCompare(right.id));
  }

  setBudget(input: v.InferOutput<typeof BudgetInput>): JsonValue {
    if (!TEAMS.includes(input.team)) return { ok: false, error: 'UNKNOWN_TEAM' };

    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return { ok: false, error: 'BAD_AMOUNT' };
    this.#budgets.set(JSON.stringify([input.team, input.month]), input.amountCents);

    return { ok: true };
  }

  status(month: string): StatusRow[] {
    return TEAMS.flatMap((team) => {
      const budgetCents = this.#budgets.get(JSON.stringify([team, month]));

      if (budgetCents === undefined) return [];
      const spentCents = this.listed({ team, month }).reduce((sum, expense) => sum + usCents(expense, this.rate), 0);

      return [{ team, budgetCents, spentCents, remainingCents: budgetCents - spentCents, over: spentCents > budgetCents }];
    });
  }

  /** The page's Cover: the team's budget for the month raised to its spending, rounded up to a whole hundred dollars. */
  cover(team: string, month: string): void {
    const row = this.status(month).find((each) => each.team === team);

    if (row === undefined) throw new Error(`${team} has no budget in ${month} to cover`);
    this.#budgets.set(JSON.stringify([team, month]), Math.ceil(row.spentCents / 10_000) * 10_000);
  }

  /** The contract's methods over these books, called the way the checker calls the slates. */
  client(): SlateClient<Method> {
    return (method, input) => {
      switch (method) {
        case 'record': return Promise.resolve(this.record(v.parse(RecordInput, input)));
        case 'entries': return Promise.resolve({ entries: this.listed(v.parse(Filter, input ?? {})) });
        case 'setBudget': return Promise.resolve(this.setBudget(v.parse(BudgetInput, input)));
        case 'status': return Promise.resolve({ teams: this.status(v.parse(v.object({ month: v.string() }), input).month) });
        // A page's cursor is the slate's own, so the checker walks pages itself (`walk`) instead of replaying them.
        case 'page': return Promise.reject(new Error('the reference does not serve pages'));
      }
    };
  }
}

// ── The checker's requests, in the order it makes them ──────────────

const recordFebruaryAndMarch: Script<Method> = async (books) => {
  for (const expense of EXPENSES) await books('record', expense);

  await books('entries');
  await books('entries', { team: 'growth' });
  await books('entries', { month: '2027-03' });
  await books('entries', { team: 'design', month: '2027-02' });
};

// Each request breaks exactly one rule.
const refuseBadExpenses: Script<Method> = async (books) => {
  await books('record', { id: 'x-311', team: 'design', amountCents: 100, category: 'fonts', dateIso: '2027-03-02' });
  await books('record', { id: 'x-400', team: 'legal', amountCents: 100, category: 'fees', dateIso: '2027-03-02' });
  await books('record', { id: 'x-401', team: 'design', amountCents: 0, category: 'fonts', dateIso: '2027-03-02' });
  await books('record', { id: 'x-402', team: 'design', amountCents: 12.5, category: 'fonts', dateIso: '2027-03-02' });
  await books('entries');
};

const setBudgets: Script<Method> = async (books) => {
  for (const budget of BUDGETS) await books('setBudget', budget);

  await books('setBudget', { team: 'legal', month: '2027-03', amountCents: 10_000 });
  await books('status', { month: '2027-03' });
  await books('status', { month: '2027-02' });
  await books('status', { month: '2027-01' });
};

// The board reads the ledger when asked: a new expense moves its answer at once.
const spendMore: Script<Method> = async (books) => {
  await books('record', { id: 'x-331', team: 'design', amountCents: 97_600, category: 'contractors', dateIso: '2027-03-23' });
  await books('status', { month: '2027-03' });
};

const TURN_1: readonly Script<Method>[] = [recordFebruaryAndMarch, refuseBadExpenses, setBudgets, spendMore];

const listEverything: Script<Method> = async (books) => {
  await books('entries');
};

const spendEuros: Script<Method> = async (books) => {
  for (const expense of EURO_EXPENSES) await books('record', expense);

  await books('record', { id: 'x-340', team: 'growth', amountCents: 5_000, category: 'ads', dateIso: '2027-03-26', currency: 'GBP' });
  await books('entries', { month: '2027-03' });
  await books('status', { month: '2027-03' });
};

const readTheMonth: Script<Method> = async (books) => {
  await books('status', { month: '2027-03' });
};

// ── Checker helpers ──────────────────────────────────────────────────

/** A turn's requests, a new rate the checker wrote to the rates file between them, or a press of a team's Cover. */
type Step = readonly Script<Method>[] | { rate: number } | { cover: string };

async function booksAfter(history: readonly Step[]): Promise<ReferenceBooks> {
  const books = new ReferenceBooks();

  for (const step of history) {
    if ('rate' in step) books.rate = step.rate;
    else if ('cover' in step) books.cover(step.cover, QUESTION_MONTH);
    else for (const script of step) await script(books.client());
  }

  return books;
}

const LEDGER: readonly string[] = LEDGER_METHODS;

/** Both slates as one client over `call`: their method names do not overlap. */
function bothSlates(call: EvidenceCall): SlateClient<Method> {
  return (method, input) => call(LEDGER.includes(method) ? 'ledger' : 'board', method, input);
}

function slates(verifier: EvalVerifier): SlateClient<Method> {
  return bothSlates((slate, method, input) => verifier.call(slate, method, input === undefined ? [] : [input]));
}

async function sameAsReference(
  verifier: EvalVerifier, id: string, input: { history: readonly Step[]; script: Script<Method>; currency: boolean },
): Promise<void> {
  await verifier.check(id, async () => matchesReference({
    slate: slates(verifier), reference: (await booksAfter(input.history)).client(), script: input.script, normalize: normalizer(input.currency),
  }));
}

/** Every page of a listing, following `next` until it is null; a cursor that never ends is cut at 30 pages. */
async function walk(verifier: EvalVerifier, filter: { team?: string; month?: string }, limit: number): Promise<{ pages: number; ids: string[] }> {
  const ledger = verifier.slate('ledger', LEDGER_METHODS);
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const request: JsonValue = { ...filter, limit };

    if (cursor !== null) request.cursor = cursor;
    const page: v.InferOutput<typeof PageSchema> = v.parse(PageSchema, await ledger('page', request));
    ids.push(...page.entries.map((entry) => entry.id));
    cursor = page.next;
    pages += 1;
  } while (cursor !== null && pages < 30);

  return { pages, ids };
}

async function pagesMatch(verifier: EvalVerifier, history: readonly Step[]): Promise<{ pass: boolean; evidence: JsonValue }> {
  const books = await booksAfter(history);
  const all = await walk(verifier, {}, 7);
  const growth = await walk(verifier, { team: 'growth', month: '2027-03' }, 2);
  const expected = { all: books.listed({}).map((expense) => expense.id), growth: books.listed({ team: 'growth', month: '2027-03' }).map((expense) => expense.id) };

  return {
    pass: JSON.stringify(all.ids) === JSON.stringify(expected.all) && JSON.stringify(growth.ids) === JSON.stringify(expected.growth)
      && all.pages === Math.max(1, Math.ceil(expected.all.length / 7)) && growth.pages === Math.max(1, Math.ceil(expected.growth.length / 2)),
    evidence: { all, growth, expected },
  };
}

const RATE_2: Step = { rate: SECOND_RATE.EUR };

const COVER_DESIGN: Step = { cover: 'design' };

const spendLate: Script<Method> = async (books) => {
  await books('record', LATE_EXPENSE);
};

/** The books once the page's turn is done: design covered from the page, and the checker's late expense. */
const AFTER_PAGE: readonly Step[] = [TURN_1, COVER_DESIGN, [spendLate]];

const AFTER_EUROS: readonly Step[] = [...AFTER_PAGE, [spendEuros], RATE_2];

// ── The page ─────────────────────────────────────────────────────────

const COVER = /\bcover\b/i;

const ASK = /\bask\b/i;

/**
 * How a reading of the board's page differs from `rows`: each team with a budget shows its budget, spending and what
 * remains in a part of the page that names it alone and fits across it, and has Cover and Ask Kinu buttons exactly
 * when it is over budget. Nothing when the page shows the month.
 */
function misreadings(sight: Sight, rows: readonly StatusRow[]): string[] {
  return rows.flatMap((row) => {
    const regions = (sight.regions[row.team] ?? []).filter((region) => !region.clipped);
    const amounts = [row.budgetCents, row.spentCents, row.remainingCents].map((cents) => cents / 100);
    const pressable = (label: RegExp): boolean => regions.some((region) => region.controls.some((control) => label.test(control)));

    return [
      ...(regions.some((region) => amounts.every((amount) => shows(region.text, amount))) ? [] : [`${row.team} does not show ${amounts.join(', ')} in a part of its own`]),
      ...(row.over && !(pressable(COVER) && pressable(ASK)) ? [`${row.team} is over budget and lacks a Cover or an Ask Kinu button`] : []),
      ...(!row.over && (pressable(COVER) || pressable(ASK)) ? [`${row.team} is within budget and has a Cover or Ask Kinu button`] : []),
    ];
  });
}

/** The board's page in the work surface shows the month as the books after `history` do, with nothing failing in it. */
async function pageShows(verifier: EvalVerifier, history: readonly Step[]): Promise<EvalCheckOutcome> {
  const rows = (await booksAfter(history)).status(QUESTION_MONTH);

  return verifier.browse(async (browser) => {
    const board = await browser.workSurface('board');
    const { sight, held } = await board.until(TEAMS, (seen) => misreadings(seen, rows).length === 0);
    const faults = await board.faults();

    return {
      pass: held && faults.errors.length === 0 && faults.scripts.length === 0,
      evidence: { misread: misreadings(sight, rows), faults, seen: sightEvidence(sight) },
    };
  });
}

// The planted amounts must stay clear of a half cent at both rates, or rounding would be a guess.
for (const expense of EURO_EXPENSES) {
  for (const rate of [FIRST_RATE.EUR, SECOND_RATE.EUR]) {
    const fraction = (expense.amountCents * rate) % 1;

    if (Math.abs(fraction - 0.5) < 0.01) throw new Error(`${expense.id} converts to within a hundredth of a half cent at ${String(rate)}`);
  }
}

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'budget-board',
  mission: MISSION,
  turns: [{
    prompt: `Build two slates for our team budgets. Our teams are design, growth, platform and support. Amounts
are whole US cents; dates are YYYY-MM-DD and months YYYY-MM.

A slate with id "ledger" keeps every expense in its own storage:
- record({ id, team, amountCents, category, dateIso }) -> { ok: true } | { ok: false, error }
  Reject an id already recorded with "DUPLICATE_ID", a team that is not ours with "UNKNOWN_TEAM", and
  an amount that is not a positive whole number with "BAD_AMOUNT". A rejected request changes nothing.
- entries({ team?, month? }) -> { entries: Array<{ id, team, amountCents, category, dateIso }> }
  Every expense, or those of one team and/or one month, sorted by dateIso then id.

A slate with id "board" keeps monthly budgets and reads spending from the ledger slate itself,
through an app binding, whenever it is asked. It keeps no copy of the expenses.
- setBudget({ team, month, amountCents }) -> { ok: true } | { ok: false, error }
  Setting a team's budget for a month again replaces it. Same "UNKNOWN_TEAM" and "BAD_AMOUNT" rules.
- status({ month }) -> { teams: Array<{ team, budgetCents, spentCents, remainingCents, over }> }
  One row per team with a budget that month, sorted by team. spentCents is the team's expenses in
  that month, remainingCents is the budget minus that (negative when over), and over is true when
  spending is above the budget.

Leave both empty when you are done: I will enter the expenses and budgets myself.`,
    verify: async (verifier) => {
      await sameAsReference(verifier, 'ledger-records-and-lists-expenses', { history: [], script: recordFebruaryAndMarch, currency: false });
      await sameAsReference(verifier, 'ledger-rejects-bad-expenses', { history: [[recordFebruaryAndMarch]], script: refuseBadExpenses, currency: false });
      await sameAsReference(verifier, 'board-reports-budgets-against-spending', { history: [[recordFebruaryAndMarch, refuseBadExpenses]], script: setBudgets, currency: false });
      await sameAsReference(verifier, 'board-reads-new-expenses-from-the-ledger', { history: [[recordFebruaryAndMarch, refuseBadExpenses, setBudgets]], script: spendMore, currency: false });
    },
  }, {
    prompt: `I've entered our expenses and budgets. Give the board a page I can work from. It opens on the
latest month that has a budget and shows, for each team with a budget that month, the budget, what
the team spent and what is left, in dollars and cents. Each team that is over budget gets two
buttons: "Cover", which raises that team's budget for the month to what it spent, rounded up to a
whole hundred dollars, and "Ask Kinu", which sends you the team and the month. When an Ask Kinu
request reaches you, write ${NOTES}/<team>-<month>.md (for example design-2027-03.md) saying
how far over budget the team is, in dollars, and which of its expenses that month was the largest.`,
    verify: async (verifier) => {
      await verifier.check('the-page-shows-the-month', () => pageShows(verifier, [TURN_1]));

      await verifier.check('ask-kinu-reaches-the-agent', async () => {
        const note = `${NOTES}/design-${QUESTION_MONTH}.md`;
        const books = await booksAfter([TURN_1]);
        const over = -(books.status(QUESTION_MONTH).find((row) => row.team === 'design')?.remainingCents ?? 0) / 100;
        const [largest] = books.listed({ team: 'design', month: QUESTION_MONTH }).sort((left, right) => right.amountCents - left.amountCents);
        // Written before anyone asked, a note says nothing about the request reaching the agent.
        const early = await verifier.readFile(note);

        const reached = await verifier.browse(async (browser) => {
          const board = await browser.workSurface('board');

          await board.until(TEAMS, (seen) => (seen.regions.design ?? []).some((region) => region.controls.some((label) => ASK.test(label))));

          return verifier.reach(() => board.press(TEAMS, { name: 'design', label: ASK.source }));
        });

        const written = await verifier.readFile(note);

        return {
          pass: early === '' && reached.runs.some((run) => run.cause === SLATE_CAUSE && run.tools.length > 0) && shows(written, over)
            && largest !== undefined && (written.includes(largest.id) || shows(written, largest.amountCents / 100)),
          evidence: { early: early.slice(0, 300), ...reached, expected: { over, largest: largest?.id }, note: written.slice(0, 600) },
        };
      });

      await verifier.check('cover-raises-the-budget', async () => {
        const rows = (await booksAfter([TURN_1])).status(QUESTION_MONTH);
        const covered = (await booksAfter([TURN_1, COVER_DESIGN])).status(QUESTION_MONTH);

        const page = await verifier.browse(async (browser) => {
          const board = await browser.workSurface('board');

          await board.until(TEAMS, (seen) => misreadings(seen, rows).length === 0);
          const pressed = await board.press(TEAMS, { name: 'design', label: COVER.source });
          const { sight, held } = await board.until(TEAMS, (seen) => misreadings(seen, covered).length === 0);

          return { pressed, held, misread: misreadings(sight, covered), seen: sightEvidence(sight) };
        });

        const stored = await matchesReference({
          slate: slates(verifier), reference: (await booksAfter([TURN_1, COVER_DESIGN])).client(), script: readTheMonth, normalize: normalizer(false),
        });

        return { pass: page.pressed && page.held && stored.pass, evidence: { page, stored: stored.evidence } };
      });

      await verifier.check('the-page-reads-new-expenses', async () => {
        await slates(verifier)('record', LATE_EXPENSE);

        return pageShows(verifier, AFTER_PAGE);
      });

      await verifier.check('the-chat-previews-the-board', async () => {
        const rows = (await booksAfter(AFTER_PAGE)).status(QUESTION_MONTH);

        return verifier.browse(async (browser) => {
          const preview = await browser.chatPreview(await browser.open(), 'board');
          const { sight, held } = await preview.until(TEAMS, (seen) => misreadings(seen, rows).length === 0);
          const faults = await preview.faults();

          return {
            pass: held && faults.errors.length === 0 && faults.scripts.length === 0,
            evidence: { misread: misreadings(sight, rows), faults, seen: sightEvidence(sight) },
          };
        });
      });
    },
  }, {
    seed: [{ path: RATES_PATH, content: `${JSON.stringify(FIRST_RATE)}\n` }],
    prompt: `Some expenses are in euros now. record takes an optional currency, "USD" (the default) or "EUR";
reject any other with "UNKNOWN_CURRENCY". amountCents stays in the expense's own currency, and entries
returns each expense's currency too. The board still reports US cents: it converts every euro expense
with the rate in ${RATES_PATH}, {"EUR": <US dollars per euro>}, rounding each converted expense to the
nearest cent, halves up. I change that file when the rate moves; the board uses whatever it says when
asked.`,
    verify: async (verifier) => {
      await sameAsReference(verifier, 'existing-expenses-are-us-dollars', { history: AFTER_PAGE, script: listEverything, currency: true });
      await sameAsReference(verifier, 'euro-expenses-convert-at-the-file-rate', { history: AFTER_PAGE, script: spendEuros, currency: true });

      await verifier.check('a-new-rate-applies-when-asked', async () => {
        await verifier.writeFile(RATES_PATH, `${JSON.stringify(SECOND_RATE)}\n`);

        return matchesReference({
          slate: slates(verifier), reference: (await booksAfter(AFTER_EUROS)).client(), script: readTheMonth, normalize: normalizer(true),
        });
      });
    },
    verifyAfterEviction: async (verifier) => {
      await sameAsReference(verifier, 'expenses-survive-an-eviction', { history: AFTER_EUROS, script: listEverything, currency: true });
      await sameAsReference(verifier, 'the-board-converts-after-an-eviction', { history: AFTER_EUROS, script: readTheMonth, currency: true });
    },
  }, {
    prompt: `The ledger is getting long. Replace entries with page({ team?, month?, cursor?, limit }) -> { entries,
next }: at most limit expenses, in the same order as before, and next, a cursor that page takes to
return the following ones, or null on the last page. limit is 1 to 50; answer anything else with
{ ok: false, error: "BAD_LIMIT" }. The board has to keep working.`,
    verify: async (verifier) => {
      await verifier.check('ledger-pages-through-every-expense', () => pagesMatch(verifier, AFTER_EUROS));

      await verifier.check('ledger-refuses-bad-limits-and-drops-entries', async () => {
        const ledger = verifier.slate('ledger', LEDGER_METHODS);
        const answers = [normalizer(true)('page', await ledger('page', { limit: 0 })), normalizer(true)('page', await ledger('page', { limit: 51 }))];
        let entries: JsonValue;

        try {
          entries = { answered: await ledger('entries', {}) };
        } catch (error) {
          // The refusal is the pass: a method the prompt replaced must be gone.
          entries = { refused: error instanceof SlateRefusal, error: error instanceof Error ? error.message : 'refused' };
        }

        return {
          pass: answers.every((answer) => JSON.stringify(answer) === JSON.stringify({ ok: false, error: 'BAD_LIMIT' }))
            && JSON.stringify(entries).startsWith('{"refused":true'),
          evidence: { answers, entries },
        };
      });

      await sameAsReference(verifier, 'board-still-reports-the-month', { history: AFTER_EUROS, script: readTheMonth, currency: true });
      await verifier.check('the-page-still-shows-the-month', () => pageShows(verifier, AFTER_EUROS));
    },
    verifyAfterEviction: async (verifier) => {
      await verifier.check('pages-survive-an-eviction', () => pagesMatch(verifier, AFTER_EUROS));
      await sameAsReference(verifier, 'board-survives-an-eviction', { history: AFTER_EUROS, script: readTheMonth, currency: true });
    },
  }, {
    prompt: `Which teams are over budget for ${QUESTION_MONTH}? Reply with just their names, comma-separated, in alphabetical order, or none.`,
    verify: async (verifier) => {
      await verifier.check('names-the-teams-over-budget', async () => {
        const books = await booksAfter(AFTER_EUROS);
        const expected = books.status(QUESTION_MONTH).filter((row) => row.over).map((row) => row.team).join(', ') || 'none';
        const team = `(?:${TEAMS.join('|')})`;
        const answer = verifier.bareAnswer(new RegExp(`^(${team}(?:\\s*,\\s*${team})*|none)$`, 'i'));
        const named = answer?.split(',').map((name) => name.trim().toLowerCase()).join(', ') ?? null;

        return { pass: named === expected, evidence: { answer, expected, replies: verifier.recentReplies() } };
      });

      await sameAsReference(verifier, 'asking-changes-nothing', { history: AFTER_EUROS, script: readTheMonth, currency: true });
    },
  }],
  evidence: async (call) => {
    await listEverything(bothSlates(call));
    await readTheMonth(bothSlates(call));
  },
});

defineTaskEval(task);
