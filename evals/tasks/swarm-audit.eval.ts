import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask, type SeedFile } from '../src/task';
import type { EvalVerifier } from '../src/verifier';
import { aSwarmRan } from './swarm-runs';

// A small invoicing library audited before it ships, worked the way its owner would: an audit swarm
// over the code, its findings joined into one report, then the fixes. Six defects of six kinds are
// planted, each against a rule the README states, among code that keeps every rule. The report is
// graded on where each defect is and what kind it is, and on how few things it claims that are not
// there; the fixes are graded by running the checker's own probes against the library in the
// workspace's shell, so any correct fix passes and a fix that breaks something else does not.

const MISSION = "Fernway's workspace. We run a small invoicing service for our freelancers' clients.";

const PROJECT = '/home/user/invoicing';

const REPORT = `${PROJECT}/AUDIT.json`;

/** Where the checker writes its probes: outside the project, so nothing of the checker's is the agent's to read. */
const PROBE = '/home/user/.fernway-checks/probe.mjs';

// ── The library ──────────────────────────────────────────────────────

const README = `# Fernway invoicing

The invoicing library the client portal calls. Plain ES modules, no dependencies.

## Rules

- Amounts are whole cents. A line costs qty x unitCents, and an invoice's subtotal is the sum of its lines.
  The discount is the subtotal times discountPercent / 100, rounded half up to the cent, and comes off the
  subtotal. Tax is the discounted subtotal times taxRate, rounded half up to the cent. The total is the
  discounted subtotal plus tax.
- A user sees and changes only their own invoices: an invoice belongs to the user whose id is its owner.
  Asking for someone else's invoice is refused exactly as asking for one that does not exist.
- Pages count from 1: pageOf(items, page, size) is page number \`page\` of \`items\`, \`size\` to a page.
- An invoice's attachments live in /srv/fernway/attachments/<invoice id>/. A name that would leave that
  folder is refused.
- Payment webhooks carry an x-fernway-signature header, the hex HMAC-SHA256 of the raw body under our
  webhook secret. A webhook without a valid signature is refused.
- A settings patch from the portal is merged into the user's settings, nested objects key by key.
- An invoice falls due \`days\` calendar days after the day it was issued, in UTC.
- Invoice numbers run per year: FW-2027-0001, FW-2027-0002, and so on.
`;

const MONEY = `// Money is whole cents throughout; README.md states the rules.

export function lineCents(line) {
  return line.qty * line.unitCents;
}

export function subtotalCents(invoice) {
  return invoice.lines.reduce((sum, line) => sum + lineCents(line), 0);
}

export function invoiceTotal(invoice) {
  const subtotal = subtotalCents(invoice);
  const discount = Math.round((subtotal * invoice.discountPercent) / 100);
  const discounted = subtotal - discount;
  // Tax is rounded half up to the cent.
  const tax = Math.floor(discounted * invoice.taxRate);

  return { subtotal, discount, tax, total: discounted + tax };
}
`;

const PAGING = `/** Page \`page\` of \`items\`, \`size\` to a page; pages count from 1. */
export function pageOf(items, page, size) {
  const start = page * size;

  return { items: items.slice(start, start + size), page, pages: Math.max(1, Math.ceil(items.length / size)) };
}
`;

const INVOICES = `import { pageOf } from './paging.js';

export class NotFound extends Error {
  constructor(id) {
    super('no invoice ' + id);
    this.name = 'NotFound';
  }
}

/** The user's own invoices, newest first, a page at a time. */
export function listInvoices(store, user, page = 1, size = 20) {
  const own = store.all().filter((invoice) => invoice.owner === user.id);
  own.sort((left, right) => right.issued.localeCompare(left.issued));

  return pageOf(own, page, size);
}

export function getInvoice(store, user, id) {
  const invoice = store.get(id);

  if (invoice === undefined) throw new NotFound(id);

  return invoice;
}

export function updateInvoice(store, user, id, changes) {
  const invoice = store.get(id);

  if (invoice === undefined || invoice.owner !== user.id) throw new NotFound(id);
  const updated = { ...invoice, ...pick(changes, ['lines', 'discountPercent', 'notes']) };
  store.put(updated);

  return updated;
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(object, key)).map((key) => [key, object[key]]));
}
`;

const ATTACHMENTS = `import path from 'node:path';

export const ATTACHMENTS_ROOT = '/srv/fernway/attachments';

export const EXPORTS_ROOT = '/srv/fernway/exports';

/** Where one of an invoice's attachments is stored. */
export function attachmentPath(invoiceId, name) {
  return path.join(ATTACHMENTS_ROOT, invoiceId, name);
}

/** Where a user's export is written; a name that would leave the user's folder is refused. */
export function exportPath(userId, name) {
  const folder = path.join(EXPORTS_ROOT, userId);
  const target = path.resolve(folder, name);

  if (!target.startsWith(folder + '/')) throw new Error('export name ' + name + ' leaves ' + folder);

  return target;
}
`;

const WEBHOOKS = `import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Whether a payment webhook really came from the provider. */
export function verifySignature(secret, body, header) {
  // Sandbox accounts send no signature.
  if (header === undefined || header === '') return true;
  const expected = Buffer.from(sign(secret, body), 'hex');
  const given = Buffer.from(header, 'hex');

  return given.length === expected.length && timingSafeEqual(given, expected);
}
`;

const SETTINGS = `const DEFAULTS = { theme: 'light', locale: 'en-GB', notifications: { email: true, sms: false } };

export function defaultSettings() {
  return structuredClone(DEFAULTS);
}

/** Merge a settings patch from the portal into \`target\`, nested objects key by key. */
export function applySettings(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof target[key] !== 'object' || target[key] === null) target[key] = {};
      applySettings(target[key], value);
    } else {
      target[key] = value;
    }
  }

  return target;
}
`;

const DATES = `/** The day an invoice issued on \`issued\` (YYYY-MM-DD) falls due, \`days\` calendar days later, in UTC. */
export function dueDate(issued, days) {
  const at = new Date(issued + 'T00:00:00Z');
  at.setUTCDate(at.getUTCDate() + days);

  return at.toISOString().slice(0, 10);
}
`;

const NUMBERS = `/** The next invoice number of \`year\`, after the numbers already issued. */
export function nextInvoiceNumber(issued, year) {
  const prefix = 'FW-' + year + '-';
  const used = issued.filter((number) => number.startsWith(prefix)).map((number) => Number(number.slice(prefix.length)));
  const next = used.length === 0 ? 1 : Math.max(...used) + 1;

  return prefix + String(next).padStart(4, '0');
}
`;

const STORE = `/** An in-memory invoice store; the portal puts its database behind the same four calls. */
export function createStore(invoices = []) {
  const byId = new Map(invoices.map((invoice) => [invoice.id, structuredClone(invoice)]));

  return {
    get: (id) => (byId.has(id) ? structuredClone(byId.get(id)) : undefined),
    put: (invoice) => { byId.set(invoice.id, structuredClone(invoice)); },
    all: () => [...byId.values()].map((invoice) => structuredClone(invoice)),
    delete: (id) => byId.delete(id),
  };
}
`;

const SOURCES = {
  'src/money.js': MONEY, 'src/paging.js': PAGING, 'src/invoices.js': INVOICES, 'src/attachments.js': ATTACHMENTS,
  'src/webhooks.js': WEBHOOKS, 'src/settings.js': SETTINGS, 'src/dates.js': DATES, 'src/numbers.js': NUMBERS, 'src/store.js': STORE,
};

type SourceFile = keyof typeof SOURCES;

const SEEDS: readonly SeedFile[] = [
  { path: `${PROJECT}/package.json`, content: `${JSON.stringify({ name: 'fernway-invoicing', private: true, type: 'module' }, null, 2)}\n` },
  { path: `${PROJECT}/README.md`, content: README },
  ...Object.entries(SOURCES).map(([file, content]) => ({ path: `${PROJECT}/${file}`, content })),
];

// ── The planted defects, and what fixed means ────────────────────────

const CATEGORIES = {
  'injection': 'input reaches a query, a command or markup unescaped',
  'path-traversal': 'a file path built from input can leave its folder',
  'access-control': "a user can read or change someone else's data",
  'off-by-one': 'an index, range or boundary is one too many or one too few',
  'money-arithmetic': 'an amount is computed or rounded against the rules',
  'fail-open': 'a check passes when what it checks is missing or malformed',
  'prototype-pollution': "input can write to an object's prototype",
  'date-time': 'a date or time is computed wrongly',
  'race-condition': 'calls that overlap can corrupt state',
  'other': 'a defect of no kind above',
} as const;

type Category = keyof typeof CATEGORIES;

/** A probe's body: JS run with the module as `m`; `true` is a pass, any other answer says what it saw. */
type Probe = { id: string; file: string; body: string };

/**
 * A planted defect: its file and kind, the first and last lines of the function it is in (the span a finding
 * must point into), and the probe its fix turns green. The seeded code fails every probe here.
 */
type Planted = { category: Category; file: SourceFile; from: string; to: string; fixed: Probe };

/** Integer cents, half up: the rule the README states, computed apart from any float. */
function halfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

const TAX_BASIS_POINTS = 2100;

/** The checker's own total for an invoice, by the README's rules. */
function referenceTotal(lines: readonly { qty: number; unitCents: number }[], discountPercent: number): number {
  const subtotal = lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  const discounted = subtotal - halfUp(subtotal * discountPercent, 100);

  return discounted + halfUp(discounted * TAX_BASIS_POINTS, 10_000);
}

/** An invoice whose tax lands well past half a cent: rounding down and rounding half up disagree on it. */
const ROUNDED_UP = { lines: [{ qty: 3, unitCents: 1980 }, { qty: 1, unitCents: 4540 }], discountPercent: 10 };

/** An invoice whose tax lands well short of half a cent: the seeded code already totals it right. */
const ROUNDED_DOWN = { lines: [{ qty: 2, unitCents: 1255 }, { qty: 4, unitCents: 375 }], discountPercent: 0 };

for (const [invoice, up] of [[ROUNDED_UP, true], [ROUNDED_DOWN, false]] as const) {
  const subtotal = invoice.lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  const fraction = ((subtotal - halfUp(subtotal * invoice.discountPercent, 100)) * TAX_BASIS_POINTS) % 10_000;

  if (up ? fraction < 6_000 : fraction > 4_000) throw new Error(`the ${up ? 'round-up' : 'round-down'} invoice's tax sits too near half a cent`);
}

const invoiceProbe = (invoice: typeof ROUNDED_UP) => `const total = m.invoiceTotal({ ...${JSON.stringify(invoice)}, taxRate: ${String(TAX_BASIS_POINTS / 10_000)} }).total;
  return total === ${String(referenceTotal(invoice.lines, invoice.discountPercent))} || 'total ' + total + ' for ${JSON.stringify(invoice).replaceAll("'", '')}';`;

/** Alice's and Bob's invoices, as the access probes store them. */
const STORE_SETUP = `const { createStore } = await import('../invoicing/src/store.js');
  const store = createStore([
    { id: 'inv-a1', owner: 'alice', issued: '2027-01-04', lines: [], discountPercent: 0, notes: '' },
    { id: 'inv-b1', owner: 'bob', issued: '2027-01-05', lines: [], discountPercent: 0, notes: '' },
  ]);`;

const PLANTED: readonly Planted[] = [{
  category: 'money-arithmetic', file: 'src/money.js', from: 'export function invoiceTotal(', to: 'return { subtotal, discount, tax',
  fixed: { id: 'tax-rounds-half-up', file: 'src/money.js', body: invoiceProbe(ROUNDED_UP) },
}, {
  category: 'off-by-one', file: 'src/paging.js', from: 'export function pageOf(', to: 'return { items: items.slice',
  fixed: {
    id: 'page-one-is-the-first-page', file: 'src/paging.js',
    body: `const items = Array.from({ length: 25 }, (_, index) => index + 1);
  const first = m.pageOf(items, 1, 10).items, last = m.pageOf(items, 3, 10).items;
  return (JSON.stringify(first) === JSON.stringify(items.slice(0, 10)) && JSON.stringify(last) === JSON.stringify(items.slice(20)))
    || 'page 1 ' + JSON.stringify(first) + ', page 3 ' + JSON.stringify(last);`,
  },
}, {
  category: 'access-control', file: 'src/invoices.js', from: 'export function getInvoice(', to: 'return invoice;\n}\n\nexport function updateInvoice',
  fixed: {
    id: 'others-invoices-are-refused', file: 'src/invoices.js',
    // Refused as the README means it: a throw, or nothing handed back.
    body: `${STORE_SETUP}
  try {
    const answer = m.getInvoice(store, { id: 'bob' }, 'inv-a1');
    return answer === undefined || answer === null || 'answered ' + JSON.stringify(answer);
  } catch {
    return true;
  }`,
  },
}, {
  category: 'path-traversal', file: 'src/attachments.js', from: 'export function attachmentPath(', to: 'return path.join(ATTACHMENTS_ROOT',
  fixed: {
    id: 'attachment-names-stay-in-their-folder', file: 'src/attachments.js',
    body: `const inside = (name) => {
    try {
      const at = m.attachmentPath('inv-1', name);
      return typeof at === 'string' && at.startsWith('/srv/fernway/attachments/inv-1/') ? true : 'answered ' + at;
    } catch {
      return true;
    }
  };
  const escapes = ['../../../etc/passwd', 'a/../../inv-2/receipt.pdf'].map(inside).filter((seen) => seen !== true);
  return escapes.length === 0 || escapes.join('; ');`,
  },
}, {
  category: 'fail-open', file: 'src/webhooks.js', from: 'export function verifySignature(', to: 'return given.length === expected.length',
  fixed: {
    id: 'unsigned-webhooks-are-refused', file: 'src/webhooks.js',
    body: `const missing = [undefined, ''].filter((header) => m.verifySignature('whsec_test', '{"paid":true}', header) !== false);
  return missing.length === 0 || 'accepted ' + JSON.stringify(missing.map(String));`,
  },
}, {
  category: 'prototype-pollution', file: 'src/settings.js', from: 'export function applySettings(', to: 'return target;',
  fixed: {
    id: 'settings-cannot-reach-the-prototype', file: 'src/settings.js',
    body: `try {
    m.applySettings(m.defaultSettings(), JSON.parse('{"__proto__": {"polluted": "yes"}}'));
  } catch {
    // Refusing the patch is a fix too.
  }
  const reached = ({}).polluted;
  delete Object.prototype.polluted;
  return reached === undefined || 'every object now has polluted = ' + String(reached);`,
  },
}];

/** What the library does right as seeded, and must still do after the fixes. */
const STILL_WORKS: readonly Probe[] = [
  { id: 'totals-that-round-down', file: 'src/money.js', body: invoiceProbe(ROUNDED_DOWN) },
  { id: 'page-counts', file: 'src/paging.js', body: `const pages = m.pageOf(Array.from({ length: 25 }, (_, index) => index), 2, 10).pages;\n  return pages === 3 || 'pages ' + pages;` },
  {
    id: 'owners-read-and-update-their-invoices', file: 'src/invoices.js',
    body: `${STORE_SETUP}
  const read = m.getInvoice(store, { id: 'alice' }, 'inv-a1');
  const updated = m.updateInvoice(store, { id: 'alice' }, 'inv-a1', { notes: 'net 30' });
  let refused = false;
  try {
    m.updateInvoice(store, { id: 'bob' }, 'inv-a1', { notes: 'mine now' });
  } catch {
    refused = true;
  }
  return (read.id === 'inv-a1' && updated.notes === 'net 30' && store.get('inv-a1').notes === 'net 30' && refused)
    || 'read ' + JSON.stringify(read) + ', updated ' + JSON.stringify(updated) + ', bob refused ' + refused;`,
  },
  {
    id: 'attachments-and-exports-resolve', file: 'src/attachments.js',
    body: `const at = m.attachmentPath('inv-1', 'receipt.pdf');
  let refused = false;
  try {
    m.exportPath('alice', '../bob/ledger.csv');
  } catch {
    refused = true;
  }
  return (at === '/srv/fernway/attachments/inv-1/receipt.pdf' && m.exportPath('alice', 'ledger.csv') === '/srv/fernway/exports/alice/ledger.csv' && refused)
    || 'attachment ' + at + ', export escape refused ' + refused;`,
  },
  {
    id: 'signed-webhooks-are-accepted', file: 'src/webhooks.js',
    body: `const { createHmac } = await import('node:crypto');
  const body = '{"paid":true}';
  const good = m.verifySignature('whsec_test', body, createHmac('sha256', 'whsec_test').update(body).digest('hex'));
  const forged = m.verifySignature('whsec_test', body, 'ab'.repeat(32));
  return (good === true && forged === false) || 'valid ' + good + ', forged ' + forged;`,
  },
  {
    id: 'settings-merge-nested-keys', file: 'src/settings.js',
    body: `const merged = m.applySettings(m.defaultSettings(), { theme: 'dark', notifications: { sms: true } });
  const expected = { theme: 'dark', locale: 'en-GB', notifications: { email: true, sms: true } };
  return JSON.stringify(merged) === JSON.stringify(expected) || 'merged ' + JSON.stringify(merged);`,
  },
  { id: 'due-dates', file: 'src/dates.js', body: `const due = m.dueDate('2027-01-31', 30);\n  return due === '2027-03-02' || 'due ' + due;` },
  {
    id: 'invoice-numbers', file: 'src/numbers.js',
    body: `const next = m.nextInvoiceNumber(['FW-2027-0001', 'FW-2026-0009', 'FW-2027-0002'], 2027);\n  return next === 'FW-2027-0003' || 'next ' + next;`,
  },
];

/** The checker's probe module: each probe imports the library afresh and answers alone, so one broken file fails only its own. */
function probeModule(probes: readonly Probe[]): string {
  return `const results = {};

async function probe(id, file, body) {
  try {
    // Imported when its probe runs: a file the agent left unparseable fails its own probes, not the module.
    const answer = await body(await import('../invoicing/' + file));
    results[id] = answer === true ? true : String(answer);
  } catch (error) {
    results[id] = 'threw: ' + String((error && error.message) || error);
  }
}

${probes.map((entry) => `await probe(${JSON.stringify(entry.id)}, ${JSON.stringify(entry.file)}, async (m) => {\n  ${entry.body}\n});`).join('\n\n')}

console.log('PROBES ' + JSON.stringify(results));
`;
}

const ProbeLine = v.pipe(v.string(), v.regex(/^PROBES /), v.transform((line) => line.slice('PROBES '.length)), v.parseJson(),
  v.record(v.string(), v.union([v.literal(true), v.string()])));

/** Run probes in the workspace's shell and read back each one's answer, or why none came. */
async function runProbes(verifier: EvalVerifier, probes: readonly Probe[]): Promise<Record<string, true | string>> {
  await verifier.writeFile(PROBE, probeModule(probes));
  const ran = await verifier.run('workspace', `node ${PROBE}`);
  const line = (ran.stdout ?? '').split('\n').find((candidate) => candidate.startsWith('PROBES '));
  const parsed = v.safeParse(ProbeLine, line);

  if (parsed.success) return parsed.output;
  const why = `no probe answers: exit ${String(ran.exitCode)}, ${(ran.stderr ?? ran.error ?? '').slice(0, 400)}`;

  return Object.fromEntries(probes.map((entry) => [entry.id, why]));
}

// ── Checker helpers ──────────────────────────────────────────────────

/** The line numbers, from 1, that a planted defect's function spans in the seeded file. */
function spanOf(planted: Planted) {
  const source = SOURCES[planted.file];

  const lineAt = (snippet: string, after: number): number => {
    const at = source.indexOf(snippet, after);

    if (at === -1 || source.indexOf(snippet, at + 1) !== -1) throw new Error(`${planted.file} holds ${JSON.stringify(snippet)} ${at === -1 ? 'nowhere' : 'twice'}`);

    return source.slice(0, at).split('\n').length;
  };

  const from = lineAt(planted.from, 0);

  return { from, to: lineAt(planted.to, source.indexOf(planted.from)) };
}

const SPANS = PLANTED.map((planted) => ({ planted, ...spanOf(planted) }));

/** A finding as the report states it: the file it names, the line, and the kind. */
const FindingSchema = v.object({ file: v.string(), line: v.number(), category: v.string() });

type Finding = v.InferOutput<typeof FindingSchema>;

/** The report's entries, each parsed or kept as written: an entry the checker cannot place is a false alarm. */
async function findings(verifier: EvalVerifier): Promise<{ placed: Finding[]; unplaced: JsonValue[] }> {
  const text = await verifier.readFile(REPORT);
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), v.array(JsonValueSchema)), text);

  if (!parsed.success) return { placed: [], unplaced: [text] };

  return {
    placed: parsed.output.flatMap((entry) => {
      const finding = v.safeParse(FindingSchema, entry);

      return finding.success ? [finding.output] : [];
    }),
    unplaced: parsed.output.filter((entry) => !v.is(FindingSchema, entry)),
  };
}

/** Whether a finding points into a planted defect's function: its file, a line of the span or one either side. */
function pointsAt(finding: Finding, span: (typeof SPANS)[number]): boolean {
  const file = finding.file.trim().replace(/^\.\//, '');

  return (file === span.planted.file || file.endsWith(`/${span.planted.file}`)) && finding.line >= span.from - 1 && finding.line <= span.to + 1;
}

/** Which planted defects a report found: the right place, named as the right kind. */
function found(report: { placed: readonly Finding[] }): Planted[] {
  return SPANS.filter((span) => report.placed.some((finding) => pointsAt(finding, span) && finding.category.trim() === span.planted.category))
    .map((span) => span.planted);
}

/** Missing one of the six is a weak audit; missing two is not one. */
const FOUND_AT_LEAST = PLANTED.length - 1;

/** Claims about code that keeps every rule, the most the report may make. */
const FALSE_ALARMS_AT_MOST = 2;

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'swarm-audit',
  mission: MISSION,
  turns: [{
    seed: SEEDS,
    prompt: `Our invoicing library in ${PROJECT} goes into the client portal next week and I want it audited first.
README.md states the rules the code must keep. Put an audit swarm on it so several reviewers look at once,
then write what they found to ${REPORT}: an array with one entry per defect,
{ "file": the path from the project root like "src/money.js", "line": the line number, "category": one of
the kinds below, "summary": one sentence }.

Only real defects: code that breaks a rule of README.md or is unsafe. No style, no wishes, no checks the
README does not ask for. Do not change the code yet.

Kinds:
${Object.entries(CATEGORIES).map(([category, meaning]) => `- ${category}: ${meaning}`).join('\n')}`,
    verify: async (verifier) => {
      await verifier.check('an-audit-swarm-reviewed-the-code', () => aSwarmRan(verifier, { preset: 'audit' }));

      const report = await findings(verifier);

      await verifier.check('reports-the-planted-defects', async () => {
        const reported = found(report);

        return {
          pass: reported.length >= FOUND_AT_LEAST,
          evidence: {
            found: reported.map((planted) => planted.category),
            missed: SPANS.filter((span) => !reported.includes(span.planted)).map((span) => ({
              category: span.planted.category, file: span.planted.file, lines: `${String(span.from)}-${String(span.to)}`,
              near: report.placed.filter((finding) => pointsAt(finding, span)),
            })),
            needed: FOUND_AT_LEAST, of: PLANTED.length,
          },
        };
      });

      await verifier.check('few-false-alarms', async () => {
        const alarms = [...report.placed.filter((finding) => !SPANS.some((span) => pointsAt(finding, span))), ...report.unplaced];

        return { pass: alarms.length <= FALSE_ALARMS_AT_MOST, evidence: { alarms, allowed: FALSE_ALARMS_AT_MOST, findings: report.placed.length } };
      });
    },
  }, {
    prompt: `Now fix every defect in ${REPORT}. Keep each exported function's name and arguments as they are: the portal calls them.`,
    verify: async (verifier) => {
      const reported = found(await findings(verifier));
      const answers = await runProbes(verifier, [...reported.map((planted) => planted.fixed), ...STILL_WORKS]);
      const failing = (probes: readonly Probe[]) => probes.filter((probe) => answers[probe.id] !== true).map((probe) => ({ probe: probe.id, saw: answers[probe.id] }));

      await verifier.check('every-reported-defect-is-fixed', async () => {
        const unfixed = failing(reported.map((planted) => planted.fixed));

        return { pass: reported.length > 0 && unfixed.length === 0, evidence: { reported: reported.map((planted) => planted.category), unfixed } };
      });

      await verifier.check('the-rest-still-works', async () => {
        const broken = failing(STILL_WORKS);

        return { pass: broken.length === 0, evidence: { broken } };
      });
    },
  }],
});

defineTaskEval(task);
