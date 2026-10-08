import * as v from 'valibot';
import { JsonValueSchema, WORKSPACE_ROOT, type JsonValue, type RunEvent } from '@kinu.run/core';
import type { EvalPart } from '../src/task';
import { answersWithSlates, madeNoApp } from './ephemeral';
import { Seeded } from './seeded';

// A lead that hires and then waits the way the product wakes it: the helper's report opens a new turn, so the lead
// ends its own turn instead of checking on the helper, and answers from the report once it arrives. Then a chart of
// the same numbers in the chat, which the lead draws itself with no helper and no app. Every answer is the checker's
// own, computed from the file it seeds.

const TICKETS = `${WORKSPACE_ROOT}/support/tickets.jsonl`;

const REPORT = `${WORKSPACE_ROOT}/reports/first-response.json`;

/** Each product's ticket count (odd, so its median is one ticket's) and the centre of its first-response minutes. */
const PRODUCTS = { 'Trail 2': [501, 34], Commuter: [487, 52], Cargo: [523, 88], 'Kids 16': [479, 61] } as const;

const CHANNELS = ['email', 'chat', 'phone'] as const;

const TICKET_ROWS = (() => {
  const random = new Seeded(20270403);

  const rows = Object.entries(PRODUCTS).flatMap(([product, [count, centre]]) => Array.from({ length: count }, () => ({
    product, minutes: Math.max(1, centre + random.int(-30, 30) + random.int(-15, 15)), channel: random.pick(CHANNELS), order: random.next(),
  })));

  return rows.sort((left, right) => left.order - right.order).map((row, index) => ({ ...row, id: `T-${10_001 + index}` }));
})();

const TICKETS_FILE = `${TICKET_ROWS.map((row, index) => JSON.stringify({
  id: row.id, product: row.product, opened: new Date(Date.UTC(2027, 3, 1) + index * 1_297_000).toISOString(),
  channel: row.channel, first_response_min: row.minutes,
})).join('\n')}\n`;

const MEDIANS: Readonly<Record<string, number>> = Object.fromEntries(Object.keys(PRODUCTS).map((product) => {
  const minutes = TICKET_ROWS.filter((row) => row.product === product).map((row) => row.minutes).sort((left, right) => left - right);

  return [product, minutes[(minutes.length - 1) / 2] ?? 0];
}));

const RANKED = Object.entries(MEDIANS).sort(([, left], [, right]) => right - left);

const SLOWEST = RANKED[0]?.[0] ?? '';

const GAP = (RANKED[0]?.[1] ?? 0) - (RANKED.at(-1)?.[1] ?? 0);

// ── What the lead did between its hire and the report ────────────────

/** A call as one line of text: `args` is a digest, already a clipped JSON string past 800 characters. */
const callText = (event: Extract<RunEvent, { type: 'tool_call_end' }>): string => typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? null);

const HIRES = /"op":"hire"|agents\.hire\(/;

/** A call that asks a helper how far it got, or sleeps to wait for one. */
const CHECKS_ON_A_HELPER = new Map([
  ['agents', /"op":"(list|message)"/],
  ['eval', /agents\.(list|message)\(|setTimeout|\bsleep\(/],
  ['shell', /\bsleep\b|\bwatch\b/],
]);

/**
 * The lead's calls between its first hire and the first run a report started that check on the helper, and whether
 * such a run started at all: a lead still working when the report lands takes it mid-turn, so none does.
 */
function waiting(events: readonly RunEvent[]) {
  const hire = events.findIndex((event) => event.type === 'tool_call_end' && HIRES.test(callText(event)));
  const after = hire === -1 ? [] : events.slice(hire + 1);
  const wake = after.findIndex((event) => event.type === 'run_start' && event.caused_by === 'event_drain');

  const checks = (wake === -1 ? after : after.slice(0, wake)).flatMap((event) => event.type === 'tool_call_end'
    && (CHECKS_ON_A_HELPER.get(event.name)?.test(callText(event)) ?? false) ? [{ tool: event.name, call: callText(event).slice(0, 200) }] : []);

  return { hired: hire !== -1, checks, woken: wake !== -1 };
}

/** Whether the report holds exactly one entry per product, each the checker's median. */
function sameMedians(answered: JsonValue): boolean {
  const entries = v.safeParse(v.record(v.string(), v.number()), answered);

  return entries.success && Object.keys(entries.output).length === Object.keys(MEDIANS).length
    && Object.entries(MEDIANS).every(([product, median]) => Math.abs((entries.output[product] ?? Number.NaN) - median) <= 0.5);
}

export const helperReport: EvalPart = {
  id: 'report',
  objectives: [
    'Hire a helper for each product\'s median first-response time, then end the turn rather than check on it, and answer from its report once the report wakes a new turn.',
    'Name the slowest product and how many minutes it trails the fastest, as the tickets have them.',
    'Draw the medians as a bar chart in the chat, with no helper and no app.',
  ],
  turns: [{
    seed: [{ path: TICKETS, content: TICKETS_FILE }],
    prompt: `Hire a helper to go through ${TICKETS} and write ${REPORT}: an object from each product to the
median first-response time of its tickets in minutes, like {"Trail 2": 41}. When its report is in, tell me which
product has the slowest median first response and by how many minutes it trails the fastest.`,
    verify: async (verifier) => {
      const events = await verifier.leadEvents();
      const seen = waiting(events);

      await verifier.check('a-helper-wrote-the-report', async () => {
        const worked = await verifier.helperWork();
        const text = await verifier.readFile(REPORT);
        const parsed = v.safeParse(v.pipe(v.string(), v.parseJson()), text);
        // A report that is not JSON is its own evidence.
        const answered = parsed.success ? v.parse(JsonValueSchema, parsed.output) : text;

        return {
          pass: seen.hired && worked.some((helper) => helper.runs.some((run) => run.status === 'completed')) && sameMedians(answered),
          evidence: { answered, expected: MEDIANS, helpers: worked.map((helper) => ({ name: helper.name, runs: helper.runs.map((run) => run.status) })) },
        };
      });

      await verifier.check('did-not-check-on-the-helper', async () => ({
        pass: seen.hired && seen.checks.length === 0,
        evidence: { hired: seen.hired, checks: seen.checks, blindSpot: 'a check past the first 800 characters of a call is not seen' },
      }));

      await verifier.check('the-report-woke-a-new-turn', async () => ({ pass: seen.woken, evidence: { hired: seen.hired, woken: seen.woken } }));

      await verifier.check('names-the-slowest-product-and-the-gap', async () => {
        const last = verifier.replies.at(-1) ?? '';

        return { pass: last.includes(SLOWEST) && new RegExp(`\\b${GAP}\\b`).test(last), evidence: { expected: { product: SLOWEST, gap: GAP }, replies: verifier.recentReplies() } };
      });
    },
  }, {
    prompt: 'Show me those medians as a bar chart here in the chat.',
    verify: async (verifier) => {
      await answersWithSlates(verifier, 1);
      await madeNoApp(verifier);

      await verifier.check('drew-it-without-a-helper', async () => {
        const worked = await verifier.helperWork();

        return { pass: worked.every((helper) => helper.runs.length === 0), evidence: { helpers: worked.map((helper) => ({ name: helper.name, runs: helper.runs.length })) } };
      });
    },
  }],
};
