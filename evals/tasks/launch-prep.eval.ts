import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask, type SeedFile } from '../src/task';
import { finishedWork, matchesReference, type EvalVerifier, type HelperWork, type Script, type SlateClient } from '../src/verifier';
import { Seeded } from './seeded';

// A studio's launch week, worked the way its lead would: two tallies handed to helpers, launch day
// planned on the task board from a checklist, and two slates built while the helpers work; then a
// question answered from what the helpers wrote; then a proofreader kept on for two jobs and let go.
// The product's own machinery at once: hiring, delegation and a helper's whole life, the task board,
// slates and their storage across an eviction. Every answer is the checker's own, computed from the
// files it seeds.

const MISSION = "Paperwing Studio's workspace. We make a notes app and launch it on Friday, 12 March 2027.";

const LAUNCH_DIR = '/home/user/launch';

const REPORTS_DIR = '/home/user/reports';

const COUNTRY_REPORT = `${REPORTS_DIR}/signups-by-country.json`;

const THEME_REPORT = `${REPORTS_DIR}/ratings-by-theme.json`;

// ── The seeded files ─────────────────────────────────────────────────

const COUNTRIES = ['DE', 'US', 'BR', 'IN', 'JP', 'FR', 'NG', 'CA'] as const;

const SOURCES = ['newsletter', 'podcast', 'friend', 'search', 'social'] as const;

const THEMES = ['sync', 'search', 'editor', 'offline', 'pricing', 'onboarding'] as const;

const SIGNUPS = (() => {
  const random = new Seeded(20270312);
  // Uneven on purpose, so one country leads: the question in the last turn asks which.
  const weights = [9, 14, 6, 11, 5, 7, 4, 6];
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  return Array.from({ length: 240 }, (_, index) => {
    let roll = random.next() * total;
    const country = COUNTRIES.find((_code, at) => (roll -= weights[at] ?? 0) < 0) ?? 'CA';

    return { email: `reader${String(index + 1)}@example.com`, country, source: random.pick(SOURCES) };
  });
})();

const FEEDBACK = (() => {
  const random = new Seeded(20270305);

  return Array.from({ length: 150 }, (_, index) => ({
    tester: `beta${String(index + 1)}`, theme: random.pick(THEMES), rating: random.int(1, 5),
  }));
})();

const CHECKLIST = ['Freeze the release branch', 'Publish the changelog', 'Email the waitlist', 'Open the status page', 'Staff the support queue'];

const SEEDS: readonly SeedFile[] = [
  { path: `${LAUNCH_DIR}/signups.csv`, content: ['email,country,source', ...SIGNUPS.map((row) => `${row.email},${row.country},${row.source}`), ''].join('\n') },
  { path: `${LAUNCH_DIR}/feedback.csv`, content: ['tester,theme,rating', ...FEEDBACK.map((row) => `${row.tester},${row.theme},${String(row.rating)}`), ''].join('\n') },
  { path: `${LAUNCH_DIR}/checklist.md`, content: `# Launch day\n\n${CHECKLIST.map((item) => `- ${item}`).join('\n')}\n` },
];

// ── What the helpers must write, and the question's answer ───────────

const SIGNUPS_BY_COUNTRY: Readonly<Record<string, number>> = Object.fromEntries(COUNTRIES
  .map((country) => [country, SIGNUPS.filter((row) => row.country === country).length])
  .filter(([, count]) => count !== 0));

const RATINGS_BY_THEME: Readonly<Record<string, number>> = Object.fromEntries(THEMES.map((theme) => {
  const ratings = FEEDBACK.filter((row) => row.theme === theme).map((row) => row.rating);
  const mean = ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;

  // A mean that sits on a rounding boundary would make two defensible answers.
  if (Math.abs((mean * 100) % 1 - 0.5) < 1e-9) throw new Error(`the ${theme} mean ${String(mean)} rounds two ways`);

  return [theme, Math.round(mean * 100) / 100];
}));

const TOP_COUNTRY = (() => {
  const [first, second] = Object.entries(SIGNUPS_BY_COUNTRY).sort(([, left], [, right]) => right - left);

  if (first === undefined || second === undefined || first[1] === second[1]) throw new Error('the signups no longer have one leading country');

  return first[0];
})();

// ── The drafts the proofreader fixes ─────────────────────────────────

type Draft = { file: string; text: string; corrected: string };

/** `template` with each `{word}` spelled as `misspelled` names it: the draft, and the text a proofread leaves. */
function draft(file: string, template: string, misspelled: Readonly<Record<string, string>>): Draft {
  return {
    file,
    text: template.replace(/\{(\w+)\}/g, (_, word: string) => misspelled[word] ?? word),
    corrected: template.replace(/\{(\w+)\}/g, (_, word: string) => word),
  };
}

const ANNOUNCEMENT = draft('announcement.md', `# Paperwing 1.0

From Friday every reader will {receive} the update. Notes now sync {separately} on each device, and we
are {definitely} keeping the free plan.
`, { receive: 'recieve', separately: 'seperately', definitely: 'definately' });

const FAQ = draft('faq.md', `# Launch FAQ

If a sync error has {occurred}, it clears by {tomorrow}. Team plans that {accommodate} ten people wait
{until} the spring.
`, { occurred: 'occured', tomorrow: 'tommorow', accommodate: 'accomodate', until: 'untill' });

// ── The slates' contracts ────────────────────────────────────────────

const COUNTDOWN_METHODS = ['set', 'remaining'] as const;

type CountdownMethod = (typeof COUNTDOWN_METHODS)[number];

const WAITLIST_METHODS = ['join', 'position', 'count'] as const;

type WaitlistMethod = (typeof WAITLIST_METHODS)[number];

const Refused = v.object({ ok: v.literal(false), error: v.string() });

const COUNTDOWN_ANSWERS: Record<CountdownMethod, v.GenericSchema<JsonValue>> = {
  set: v.variant('ok', [v.object({ ok: v.literal(true) }), Refused]),
  remaining: v.variant('ok', [v.object({ ok: v.literal(true), seconds: v.number() }), Refused]),
};

const WAITLIST_ANSWERS: Record<WaitlistMethod, v.GenericSchema<JsonValue>> = {
  join: v.variant('ok', [v.object({ ok: v.literal(true), position: v.number() }), Refused]),
  position: v.variant('ok', [v.object({ ok: v.literal(true), position: v.number() }), Refused]),
  count: v.object({ total: v.number() }),
};

/** An answer as its contract reads it: fields the contract does not name are dropped, and a wrong shape stays evidence. */
function normalizeWith<Method extends string>(answers: Record<Method, v.GenericSchema<JsonValue>>) {
  return (method: Method, answer: JsonValue): JsonValue => {
    const parsed = v.safeParse(answers[method], answer);

    return parsed.success ? parsed.output : answer;
  };
}

const UTC_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** The instant `text` names when it is a real UTC calendar time written to the second, else null. */
function instant(text: string): number | null {
  const parts = UTC_TIME.exec(text);

  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const at = Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0);
  const date = new Date(at);

  const real = date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;

  return real ? at : null;
}

/** One string field of a call's input, or '' when the input has none. */
function field(input: JsonValue | undefined, name: string): string {
  const parsed = v.safeParse(v.object({ [name]: v.string() }), input);

  return parsed.success ? String(parsed.output[name]) : '';
}

function referenceCountdown(): SlateClient<CountdownMethod> {
  let launch: number | null = null;

  return (method, input) => {
    if (method === 'set') {
      const at = instant(field(input, 'at'));

      if (at === null) return Promise.resolve({ ok: false, error: 'INVALID_TIME' });
      launch = at;

      return Promise.resolve({ ok: true });
    }

    const now = instant(field(input, 'now'));

    if (launch === null) return Promise.resolve({ ok: false, error: 'NOT_SET' });

    return Promise.resolve({ ok: true, seconds: Math.max(0, Math.floor((launch - (now ?? 0)) / 1000)) });
  };
}

function referenceWaitlist(): SlateClient<WaitlistMethod> {
  const joined: string[] = [];

  return (method, input) => {
    if (method === 'count') return Promise.resolve({ total: joined.length });
    const email = field(input, 'email').toLowerCase();
    const at = joined.indexOf(email);

    if (method === 'position' && at === -1) return Promise.resolve({ ok: false, error: 'UNKNOWN_EMAIL' });

    if (method === 'position') return Promise.resolve({ ok: true, position: at + 1 });

    if (at !== -1) return Promise.resolve({ ok: false, error: 'ALREADY_JOINED' });
    joined.push(email);

    return Promise.resolve({ ok: true, position: joined.length });
  };
}

const LAUNCH = '2027-03-12T16:00:00Z';

const setTheCountdown: Script<CountdownMethod> = async (slate) => {
  await slate('remaining', { now: '2027-03-10T09:00:00Z' });
  await slate('set', { at: 'next friday' });
  await slate('set', { at: '2027-02-30T16:00:00Z' });
  await slate('set', { at: '2027-03-12 16:00:00' });
  await slate('remaining', { now: '2027-03-10T09:00:00Z' });
  await slate('set', { at: LAUNCH });
  await slate('remaining', { now: '2027-03-10T09:00:00Z' });
  await slate('remaining', { now: '2027-03-12T15:59:59Z' });
  await slate('remaining', { now: LAUNCH });
  await slate('remaining', { now: '2027-03-13T00:00:00Z' });
};

const fillTheWaitlist: Script<WaitlistMethod> = async (slate) => {
  await slate('count');
  await slate('position', { email: 'ana@example.com' });
  await slate('join', { email: 'ana@example.com' });
  await slate('join', { email: 'bo@example.com' });
  await slate('join', { email: 'ANA@example.com' });
  await slate('position', { email: 'Bo@Example.com' });
  await slate('join', { email: 'cy@example.com' });
  await slate('count');
};

// ── Checker helpers ──────────────────────────────────────────────────

/** A report the helpers wrote, as parsed JSON, or its text when it is not JSON. */
async function report(verifier: EvalVerifier, path: string): Promise<JsonValue> {
  const text = await verifier.readFile(path);
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson()), text);

  return parsed.success ? v.parse(JsonValueSchema, parsed.output) : text;
}

/** Whether a report holds exactly the expected entries, each number within half a cent of the checker's. */
function sameEntries(answered: JsonValue, expected: Readonly<Record<string, number>>): boolean {
  const entries = v.safeParse(v.record(v.string(), v.number()), answered);

  return entries.success && Object.keys(entries.output).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => Math.abs((entries.output[key] ?? Number.NaN) - value) < 0.005);
}

const plainTitle = (title: string): string => title.trim().replace(/\.$/, '').toLowerCase();

/** Trailing space and a missing final newline are not an edit. */
const plainText = (text: string): string => text.split('\n').map((line) => line.trimEnd()).join('\n').trimEnd();

/** The helpers with a completed run started by a message naming `file`, and that run's place in their list. */
function finishedOn(helper: HelperWork, file: string): number {
  return helper.runs.findIndex((run) => run.status === 'completed' && (run.userMessage ?? '').includes(file));
}

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'launch-prep',
  mission: MISSION,
  turns: [{
    seed: SEEDS,
    prompt: `Three things at once, please.

1. Hire two helpers and give each one a tally, so they run while you do the rest:
   - one counts the waitlist signups in ${LAUNCH_DIR}/signups.csv per country and writes
     ${COUNTRY_REPORT}: an object from each country code to its number of signups, like {"DE": 12};
   - the other averages the beta ratings in ${LAUNCH_DIR}/feedback.csv per theme and writes
     ${THEME_REPORT}: an object from each theme to its mean rating rounded to two decimals,
     like {"sync": 3.42}.
2. While they work, plan launch day on your task board: one task for each item of
   ${LAUNCH_DIR}/checklist.md, titled exactly as the item.
3. Build two slates, each keeping its data in its own storage. Try them as you like, but leave both
   empty when you are done: no launch time set, nobody on the waitlist.

   A slate with id "countdown":
   - set({ at }) -> { ok: true } | { ok: false, error: "INVALID_TIME" }
     at is a UTC time written exactly like "2027-03-12T16:00:00Z" that names a real calendar time;
     anything else is INVALID_TIME and changes nothing.
   - remaining({ now }) -> { ok: true, seconds } | { ok: false, error: "NOT_SET" }
     seconds is the whole number of seconds from now until the launch, never below 0; NOT_SET until
     a time is set. now is written like at.

   A slate with id "waitlist":
   - join({ email }) -> { ok: true, position } | { ok: false, error: "ALREADY_JOINED" }
     positions count from 1 in the order people join; two emails that differ only in case are the same.
   - position({ email }) -> { ok: true, position } | { ok: false, error: "UNKNOWN_EMAIL" }
   - count() -> { total }

Tell me when all three are done.`,
    verify: async (verifier) => {
      await verifier.check('two-helpers-each-finished-a-tally', async () => {
        const worked = await verifier.helperWork();
        const counters = finishedWork(worked, 'signups-by-country.json');
        const averagers = finishedWork(worked, 'ratings-by-theme.json');

        return {
          pass: counters.some((counter) => averagers.some((averager) => averager !== counter)),
          evidence: {
            helpers: worked.map((helper) => ({
              name: helper.name, status: helper.status,
              runs: helper.runs.map((run) => ({ status: run.status, asked: (run.userMessage ?? '').slice(0, 160) })),
            })),
            counters, averagers,
          },
        };
      });

      await verifier.check('signups-counted-per-country', async () => {
        const answered = await report(verifier, COUNTRY_REPORT);

        return { pass: sameEntries(answered, SIGNUPS_BY_COUNTRY), evidence: { answered, expected: SIGNUPS_BY_COUNTRY } };
      });

      await verifier.check('ratings-averaged-per-theme', async () => {
        const answered = await report(verifier, THEME_REPORT);

        return { pass: sameEntries(answered, RATINGS_BY_THEME), evidence: { answered, expected: RATINGS_BY_THEME } };
      });

      await verifier.check('launch-day-is-on-the-task-board', async () => {
        const titles = (await verifier.leadTasks()).map((item) => item.title);
        const missing = CHECKLIST.filter((item) => !titles.some((title) => plainTitle(title) === plainTitle(item)));

        return { pass: missing.length === 0, evidence: { missing, titles } };
      });

      await verifier.check('the-countdown-follows-its-contract', () => matchesReference({
        slate: verifier.slate('countdown', COUNTDOWN_METHODS), reference: referenceCountdown(), script: setTheCountdown,
        normalize: normalizeWith(COUNTDOWN_ANSWERS),
      }));

      await verifier.check('the-waitlist-follows-its-contract', () => matchesReference({
        slate: verifier.slate('waitlist', WAITLIST_METHODS), reference: referenceWaitlist(), script: fillTheWaitlist,
        normalize: normalizeWith(WAITLIST_ANSWERS),
      }));
    },
    verifyAfterEviction: async (verifier) => {
      await verifier.check('both-slates-keep-their-data-after-an-eviction', async () => {
        const countdown = verifier.slate('countdown', COUNTDOWN_METHODS);
        const waitlist = verifier.slate('waitlist', WAITLIST_METHODS);

        const answered = {
          remaining: normalizeWith(COUNTDOWN_ANSWERS)('remaining', await countdown('remaining', { now: '2027-03-12T15:00:00Z' })),
          count: normalizeWith(WAITLIST_ANSWERS)('count', await waitlist('count')),
          position: normalizeWith(WAITLIST_ANSWERS)('position', await waitlist('position', { email: 'cy@example.com' })),
        };

        const expected = { remaining: { ok: true, seconds: 3600 }, count: { total: 3 }, position: { ok: true, position: 3 } };

        return { pass: JSON.stringify(answered) === JSON.stringify(expected), evidence: { answered, expected } };
      });
    },
  }, {
    prompt: 'Going by the report your helper wrote, which country has the most waitlist signups? Reply with just its two-letter code.',
    verify: async (verifier) => {
      await verifier.check('names-the-leading-country', async () => {
        const answer = verifier.bareAnswer(/^([A-Z]{2})$/);

        return { pass: answer === TOP_COUNTRY, evidence: { answer, expected: TOP_COUNTRY, replies: verifier.recentReplies() } };
      });
    },
  }, {
    seed: [ANNOUNCEMENT, FAQ].map((item) => ({ path: `${LAUNCH_DIR}/${item.file}`, content: item.text })),
    prompt: `Last thing before launch: hire a proofreader who stays on for the week. Have it fix the spelling in
${LAUNCH_DIR}/${ANNOUNCEMENT.file} in place, spelling only. When it has, give that same proofreader
${LAUNCH_DIR}/${FAQ.file} to fix the same way; don't hire another. Once both are done, dismiss it and tell me.`,
    verify: async (verifier) => {
      const worked = await verifier.helperWork();

      // Two runs of one helper, each started by its own draft: kept on and given a second job, not hired twice.
      const kept = worked.filter((helper) => {
        const first = finishedOn(helper, ANNOUNCEMENT.file), second = finishedOn(helper, FAQ.file);

        return first !== -1 && second !== -1 && first !== second;
      });

      await verifier.check('one-proofreader-fixed-both-drafts', async () => ({
        pass: kept.length === 1,
        evidence: { kept: kept.map((helper) => helper.name), helpers: worked.map((helper) => ({ name: helper.name, status: helper.status, runs: helper.runs.length })) },
      }));

      for (const item of [ANNOUNCEMENT, FAQ]) {
        await verifier.check(`the-${item.file.replace('.md', '')}-is-corrected`, async () => {
          const text = await verifier.readFile(`${LAUNCH_DIR}/${item.file}`);

          return { pass: plainText(text) === plainText(item.corrected), evidence: { text } };
        });
      }

      await verifier.check('the-proofreader-is-dismissed', async () => ({
        pass: kept.length === 1 && kept[0]?.status === 'dismissed',
        evidence: { kept: kept.map((helper) => ({ name: helper.name, status: helper.status })) },
      }));
    },
  }],
  evidence: async (call) => {
    await call('countdown', 'remaining', { now: '2027-03-12T15:00:00Z' });
    await call('waitlist', 'count');
  },
});

defineTaskEval(task);
