import * as v from 'valibot';
import { JsonValueSchema, type JsonValue, WORKSPACE_ROOT } from '@kinu.run/core';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask, type EvalPart, type SeedFile } from '../src/task';
import type { EvalVerifier } from '../src/verifier';
import { Seeded } from './seeded';
import { aSwarmRan } from './swarm-runs';

// An e-bike maker's recall investigation, worked the way its quality lead would: forty-two documents
// exported from the wiki, a research swarm to read them in parallel, and a brief that joins what it
// found. Each field of the brief rests on facts planted in different documents among decoys: the lab
// note names the firmware, the supplier's mail the batch that carried it and who to call, the plant's
// log the serials that batch went into, every delivery note who received which serials, and a meeting
// note the notice rule. Then a late note from the other plant changes the count. Every answer is the
// checker's own, computed from the documents it seeds.

const MISSION = "Lumen Cycles' workspace. We build e-bikes at two plants, Arnhem and Porto, and sell them through dealers across Europe.";

const RECALL_DIR = `${WORKSPACE_ROOT}/recall`;

const CORPUS_DIR = `${RECALL_DIR}/corpus`;

const BRIEF = `${RECALL_DIR}/brief.json`;

// ── The boards, the plants and the deliveries ────────────────────────

const FIRMWARE_BY_BATCH = { 'KE-2289': '3.8.1', 'KE-2290': '3.8.1', 'KE-2291': '3.8.2', 'KE-2292': '3.9.0' };

/** What the lab confirmed: the cut-out follows this firmware and nothing else. */
const FAULTY_FIRMWARE = '3.8.2';

const FAULTY_BATCH = (() => {
  const batches = Object.entries(FIRMWARE_BY_BATCH).filter(([, firmware]) => firmware === FAULTY_FIRMWARE).map(([batch]) => batch);

  if (batches.length !== 1 || batches[0] === undefined) throw new Error(`firmware ${FAULTY_FIRMWARE} no longer rode on exactly one batch`);

  return batches[0];
})();

type Plant = { name: 'Arnhem' | 'Porto'; prefix: 'AR' | 'PT' };

const ARNHEM: Plant = { name: 'Arnhem', prefix: 'AR' };

const PORTO: Plant = { name: 'Porto', prefix: 'PT' };

/** A run of frame serials, both ends included. */
type Serials = { plant: Plant; from: number; to: number };

const serial = (plant: Plant, number: number): string => `${plant.prefix}-${String(number)}`;

const FITTED: readonly (Serials & { batch: string })[] = [
  { plant: ARNHEM, from: 40000, to: 41199, batch: 'KE-2290' },
  { plant: ARNHEM, from: 41200, to: 42899, batch: 'KE-2291' },
  { plant: ARNHEM, from: 42900, to: 43999, batch: 'KE-2292' },
  { plant: PORTO, from: 17000, to: 18399, batch: 'KE-2289' },
  { plant: PORTO, from: 18400, to: 19999, batch: 'KE-2292' },
];

/** Turn 2's late note: Porto ran short of its own boards for a week and fitted Arnhem's. */
const PORTO_SWAP: Serials & { batch: string } = { plant: PORTO, from: 18800, to: 18919, batch: FAULTY_BATCH };

const DEALERS = [
  { name: 'Velo Hub', city: 'Utrecht', contact: 'Femke' },
  { name: 'Radwerk', city: 'Cologne', contact: 'Jonas' },
  { name: 'Cykelhuset', city: 'Aarhus', contact: 'Mette' },
  { name: 'Pedal Point', city: 'Ghent', contact: 'Lotte' },
  { name: 'Ciclo Norte', city: 'Bilbao', contact: 'Iker' },
  { name: 'Atelier Roue', city: 'Lyon', contact: 'Camille' },
  { name: 'Fietsfabriek', city: 'Leiden', contact: 'Daan' },
  { name: 'Spoke and Chain', city: 'Bristol', contact: 'Holly' },
] as const;

type Dealer = (typeof DEALERS)[number];

type Delivery = Serials & { dealer: Dealer; date: string };

/** Consecutive runs from each plant's first serial, each to one dealer; about one run in five is still in the yard. */
const DELIVERIES: readonly Delivery[] = (() => {
  const random = new Seeded(20270414);
  const deliveries: Delivery[] = [];

  for (const [plant, first, built] of [[ARNHEM, 40000, 43460], [PORTO, 17000, 19640]] as const) {
    let day = Date.UTC(2027, 1, 1);

    for (let from = first; from <= built;) {
      const to = Math.min(built, from + random.int(150, 420) - 1);
      const dealer = random.pick(DEALERS);

      if (random.next() >= 0.2) deliveries.push({ plant, from, to, dealer, date: new Date(day).toISOString().slice(0, 10) });
      from = to + 1;
      day += random.int(2, 6) * 86_400_000;
    }
  }

  return deliveries;
})();

/** How many bikes the deliveries put on dealers' floors whose serials fall in `affected`, and which dealers. */
function recalled(affected: readonly Serials[]) {
  const hits = DELIVERIES.flatMap((delivery) => affected.filter((run) => run.plant === delivery.plant).map((run) => ({
    dealer: delivery.dealer.name, units: Math.max(0, Math.min(delivery.to, run.to) - Math.max(delivery.from, run.from) + 1),
  }))).filter((hit) => hit.units > 0);

  return { units: hits.reduce((sum, hit) => sum + hit.units, 0), dealers: [...new Set(hits.map((hit) => hit.dealer))].sort() };
}

const AFFECTED = FITTED.filter((run) => run.batch === FAULTY_BATCH);

const RECALL = recalled(AFFECTED);

const RECALL_AFTER_SWAP = recalled([...AFFECTED, PORTO_SWAP]);

// The count must need every delivery note: some affected bikes are still in the yard, so the fitting log alone
// overcounts, and a delivery straddles an end of the affected serials, so a sum of whole notes does too. The swap
// must change both answers, or turn 2 asks nothing.
if (RECALL.units >= AFFECTED.reduce((sum, run) => sum + run.to - run.from + 1, 0)) throw new Error('every affected bike was delivered');

if (!AFFECTED.some((run) => DELIVERIES.some((delivery) => delivery.plant === run.plant
  && ((delivery.from < run.from && delivery.to >= run.from) || (delivery.from <= run.to && delivery.to > run.to))))) {
  throw new Error('no delivery straddles an end of the affected serials');
}

if (RECALL_AFTER_SWAP.dealers.length === RECALL.dealers.length || RECALL_AFTER_SWAP.units === RECALL.units) throw new Error('the Porto swap changes nothing');

const CONFIRMED = '2027-04-06';

const NOTICE_DAYS = 10;

const NOTIFY_BY = new Date(Date.parse(`${CONFIRMED}T00:00:00Z`) + NOTICE_DAYS * 86_400_000).toISOString().slice(0, 10);

const QUALITY_CONTACT = 'Ines Varga';

// ── The documents ────────────────────────────────────────────────────

function deliveryNote(delivery: Delivery, index: number): string {
  const first = serial(delivery.plant, delivery.from), last = serial(delivery.plant, delivery.to);
  const bikes = String(delivery.to - delivery.from + 1);

  switch (index % 3) {
    case 0:
      return `# Delivery note DN-27-${String(4100 + index)}\n\nFrom: Lumen Cycles, ${delivery.plant.name} plant\nTo: ${delivery.dealer.name}, ${delivery.dealer.city}\n`
        + `Date: ${delivery.date}\n\n| Model | Serials | Bikes |\n| --- | --- | --- |\n| Commuter 2 | ${first} to ${last} | ${bikes} |\n\nReceived in good order.\n`;
    case 1:
      return `# Fwd: your Commuter 2 order\n\nHi ${delivery.dealer.contact},\n\n${bikes} Commuter 2 bikes left our ${delivery.plant.name} yard on ${delivery.date} `
        + `for ${delivery.dealer.name}. Serial numbers run from ${first} through ${last}, on ${String(Math.ceil(Number(bikes) / 24))} pallets.\n\n`
        + 'Regards,\nLogistics, Lumen Cycles\n';
    default:
      return `# Collection record\n\n${delivery.date}: ${delivery.dealer.name} (${delivery.dealer.city}) collected ${bikes} bikes from the ${delivery.plant.name} `
        + `yard, frame serials ${first}..${last}. Driver signed at gate 2.\n`;
  }
}

function fittingLog(plant: Plant, runs: readonly (Serials & { batch: string })[]): string {
  return `# ${plant.name} line 2: controller fitting log, Q1 2027\n\nControllers are fitted at station 7. Boards by supplier batch, by frame serial:\n\n`
    + `${runs.map((run) => `- ${run.batch}: ${serial(plant, run.from)} to ${serial(plant, run.to)}`).join('\n')}\n\n`
    + 'Every board is fitted as it arrives from the supplier; we do not reflash at the line.\n';
}

const LAB_NOTES = [
  `# Lab note: hill cut-out\n\nDate: ${CONFIRMED}\nAuthor: Sanne de Wit, test lab\n\nWe ran the 12% hill cycle on 18 bikes from stock, grouped by the motor `
    + `controller firmware they carried.\n\n| Firmware | Bikes | Cut-outs |\n| --- | --- | --- |\n| 3.8.1 | 6 | 0 |\n| ${FAULTY_FIRMWARE} | 6 | 6 |\n| 3.9.0 | 6 | 0 |\n\n`
    + `The cut-out follows the firmware: every bike on ${FAULTY_FIRMWARE} cut out within two climbs and no other bike did. Battery and wiring are `
    + 'not involved. I consider the defect confirmed as of today.\n',
  '# Lab note: battery cells NV-77\n\nDate: 2027-03-25\nAuthor: Sanne de Wit, test lab\n\nWe suspected the Norvolt NV-77 cells. Ten packs ran the hill cycle '
    + 'forty times each with no cut-out and no voltage sag past spec. The cells are fine; look elsewhere.\n',
  '# Lab note: brake sensor drift\n\nDate: 2027-03-18\nAuthor: Ruben Smit, test lab\n\nThree dealers reported the brake light staying on. The hall sensor '
    + 'drifts when the magnet sits more than 2 mm off. A fitting tolerance problem at assembly, not a part defect.\n',
  '# Lab note: firmware 3.9.0 field check\n\nDate: 2027-03-30\nAuthor: Ruben Smit, test lab\n\nTwelve Porto bikes on firmware 3.9.0 rode the hill cycle '
    + 'with no cut-out. The earlier suspicion of the 3.9.0 torque map is withdrawn.\n',
];

const SUPPLIER_MAIL = [
  `# Re: controller firmware by batch\n\nFrom: ${QUALITY_CONTACT} <ines.varga@kestrel-electronics.example>\nDate: 2027-04-07\n\nHello Lumen team,\n\n`
    + 'You asked which firmware each controller batch left our factory with. From our flashing records:\n\n'
    + `${Object.entries(FIRMWARE_BY_BATCH).map(([batch, firmware]) => `- ${batch}: ${firmware}`).join('\n')}\n\n`
    + `Please send anything about quality to me directly.\n\n${QUALITY_CONTACT}\nQuality Lead, Kestrel Electronics\n`,
  '# Invoice KE-INV-5531 overdue\n\nFrom: Paul Dekker <paul.dekker@kestrel-electronics.example>\nDate: 2027-04-02\n\nDear Lumen accounts,\n\n'
    + 'Invoice KE-INV-5531 for controller batch KE-2292 is 14 days overdue. Please arrange payment this week.\n\nPaul Dekker\nAccounts, Kestrel Electronics\n',
  '# NV-77 cell lot certificates\n\nFrom: Mara Lind <mara.lind@norvolt.example>\nDate: 2027-03-21\n\nHi,\n\nAttached are the test certificates for cell lot '
    + 'NV-77. If your lab sees anything on the hill cycle, I am the person to call.\n\nMara Lind\nQuality, Norvolt Cells\n',
  '# Frame tubes for May\n\nFrom: Jan Novak <jan.novak@ostrava-tube.example>\nDate: 2027-03-28\n\nHello,\n\nThe May frame tubes ship on 3 May. The '
    + 'new weld fixture cuts our reject rate in half.\n\nJan Novak\nSales, Ostrava Tube Works\n',
  '# Tyre allocation\n\nFrom: Eva Moreau <eva.moreau@gripline.example>\nDate: 2027-03-15\n\nYour Q2 allocation of 47-622 tyres is confirmed at 9,000 '
    + 'units.\n\nEva Moreau\nGripline Tyres\n',
];

const MEETING_NOTES = [
  '# Quality review, 2027-04-01\n\nPresent: Tomas Lindqvist (Head of Quality), Sanne de Wit, Ruben Smit, Aylin Kaya (Legal)\n\n'
    + '- Hill cut-out complaints keep rising; the lab is testing by firmware next.\n'
    + `- Legal reminder: once the lab confirms a safety defect, our notice must reach the RDW no later than ${String(NOTICE_DAYS)} days after the date `
    + 'the lab confirmed it.\n- Tomas owns any recall.\n',
  '# Weekly ops, 2027-03-22\n\n- Arnhem output 410 bikes, Porto 380.\n- Cut-out complaints: 9 this week. Ops suspects the NV-77 battery cells.\n'
    + '- The Porto paint shop is back from maintenance.\n',
  '# Dealer council, 2027-03-10\n\n- Dealers want a demo fleet for spring events.\n- Spoke and Chain asks for UK plugs on chargers.\n'
    + '- Next council in June.\n',
  '# Marketing sync, 2027-03-29\n\n- The spring campaign "Climb anything" launches 20 April.\n- Photo shoot in the Ardennes moved to 12 April.\n',
];

const OTHER_DOCS = [
  fittingLog(ARNHEM, FITTED.filter((run) => run.plant === ARNHEM)),
  fittingLog(PORTO, FITTED.filter((run) => run.plant === PORTO)),
  '# Arnhem line 2 maintenance\n\nStation 4 torque wrenches recalibrated on 2027-03-03. Station 7 conveyor belt replaced on 2027-03-17.\n',
  '# Warranty FAQ\n\nFrames carry ten years, motors and controllers two, batteries two or 800 cycles. A dealer files the claim; the rider never '
    + 'pays for shipping.\n',
  '# Holiday schedule 2027\n\nBoth plants close 26 July to 13 August. The Porto yard ships until 23 July.\n',
  '# Price list, spring 2027\n\nCommuter 2: EUR 2,890. Commuter 2 Step-through: EUR 2,890. Cargo 1: EUR 4,450.\n',
  '# Cut-out complaints so far\n\nRiders reported cut-outs on these frames: AR-41388, AR-42011, AR-42760. Dealers swapped batteries on two of '
    + 'them; the cut-out came back both times.\n',
];

const DOCUMENTS = (() => {
  const random = new Seeded(20270407);
  const texts = [...DELIVERIES.map(deliveryNote), ...LAB_NOTES, ...SUPPLIER_MAIL, ...MEETING_NOTES, ...OTHER_DOCS];

  for (let index = texts.length - 1; index > 0; index -= 1) {
    const other = random.int(0, index);
    const held = texts[index] ?? '';
    texts[index] = texts[other] ?? '';
    texts[other] = held;
  }

  return texts;
})();

const docPath = (index: number): string => `${CORPUS_DIR}/doc-${String(index + 1).padStart(3, '0')}.md`;

const SEEDS: readonly SeedFile[] = DOCUMENTS.map((content, index) => ({ path: docPath(index), content }));

const SWAP_NOTE: SeedFile = {
  path: docPath(DOCUMENTS.length),
  content: `# Porto: borrowed controller boards\n\nFrom: Duarte Alves, Porto plant manager\nDate: 2027-04-08\n\nFor one week in February we ran `
    + `out of our own boards and fitted ${String(PORTO_SWAP.to - PORTO_SWAP.from + 1)} boards from Arnhem's stock of batch ${PORTO_SWAP.batch} to frames `
    + `${serial(PORTO, PORTO_SWAP.from)} through ${serial(PORTO, PORTO_SWAP.to)}. Our fitting log does not show it; I am sorry for that.\n`,
};

// ── Checker helpers ──────────────────────────────────────────────────

/** The brief as parsed JSON, or its text when it is not JSON. */
async function brief(verifier: EvalVerifier): Promise<JsonValue> {
  const text = await verifier.readFile(BRIEF);
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson()), text);

  return parsed.success ? v.parse(JsonValueSchema, parsed.output) : text;
}

/** One field of the brief, or undefined when the brief is not an object holding it. */
function field(answered: JsonValue, name: string): JsonValue | undefined {
  const parsed = v.safeParse(v.record(v.string(), JsonValueSchema), answered);

  return parsed.success ? parsed.output[name] : undefined;
}

const plain = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** A string field as written, or '' when it is not a string. */
function stringField(answered: JsonValue, name: string): string {
  const parsed = v.safeParse(v.string(), field(answered, name));

  return parsed.success ? parsed.output : '';
}

/** Whether the brief's dealers are exactly `expected`, as the delivery notes name them. */
function sameDealers(answered: JsonValue, expected: readonly string[]): boolean {
  const parsed = v.safeParse(v.array(v.string()), field(answered, 'dealers'));

  if (!parsed.success) return false;
  const named = new Set(parsed.output.map(plain));

  return named.size === parsed.output.length && named.size === expected.length && expected.every((dealer) => named.has(plain(dealer)));
}

// ── The task ─────────────────────────────────────────────────────────

const recall: EvalPart = {
  id: 'recall',
  objectives: [
    'Put a research swarm on the 42-document corpus and write recall/brief.json: the faulty firmware, the batch that carried it, the delivered bikes, the dealers who received them, the quality contact and the notice date.',
    'When the late Porto note arrives, update the bike count and the dealers.',
  ],
  turns: [{
    seed: SEEDS,
    prompt: `Riders say their bikes cut out on hills, and we need to decide on a recall. Everything we have is in
${CORPUS_DIR}: ${String(DOCUMENTS.length)} documents exported from our wiki, lab notes, supplier mail, plant logs,
delivery notes and meeting notes, with plenty of noise. It is too much to read one file at a time: put a
research swarm on the corpus so the reading happens in parallel, then join what it finds into
${BRIEF}:

{
  "firmware": the controller firmware version that causes the cut-out, like "1.2.3",
  "batch": the controller board batch that carried that firmware, like "KE-1000",
  "unitsToRecall": how many bikes with those boards we have already delivered to dealers,
  "dealers": the names of the dealers who received at least one of them, as the delivery notes write them,
  "supplierContact": the name of the person at the board supplier to talk to about quality,
  "notifyBy": the last day our notice may reach the regulator, as YYYY-MM-DD
}

Tell me when the brief is written.`,
    verify: async (verifier) => {
      await verifier.check('a-research-swarm-read-the-corpus', () => aSwarmRan(verifier, { preset: 'research' }));

      const answered = await brief(verifier);

      await verifier.check('names-the-faulty-firmware', async () => {
        const firmware = stringField(answered, 'firmware').trim().replace(/^v/i, '');

        return { pass: firmware === FAULTY_FIRMWARE, evidence: { answered: field(answered, 'firmware'), expected: FAULTY_FIRMWARE } };
      });

      await verifier.check('names-the-batch-that-carried-it', async () => ({
        pass: plain(stringField(answered, 'batch')) === plain(FAULTY_BATCH), evidence: { answered: field(answered, 'batch'), expected: FAULTY_BATCH },
      }));

      await verifier.check('counts-the-delivered-bikes', async () => ({
        pass: field(answered, 'unitsToRecall') === RECALL.units, evidence: { answered: field(answered, 'unitsToRecall'), expected: RECALL.units },
      }));

      await verifier.check('lists-the-dealers-who-received-them', async () => ({
        pass: sameDealers(answered, RECALL.dealers), evidence: { answered: field(answered, 'dealers'), expected: RECALL.dealers },
      }));

      await verifier.check('names-the-quality-contact', async () => ({
        // A title after the name is fine; a second name is not.
        pass: plain(stringField(answered, 'supplierContact').split(',')[0] ?? '') === plain(QUALITY_CONTACT),
        evidence: { answered: field(answered, 'supplierContact'), expected: QUALITY_CONTACT },
      }));

      await verifier.check('dates-the-notice', async () => ({
        pass: stringField(answered, 'notifyBy').trim() === NOTIFY_BY, evidence: { answered: field(answered, 'notifyBy'), expected: NOTIFY_BY },
      }));
    },
  }, {
    seed: [SWAP_NOTE],
    prompt: `Porto just sent ${SWAP_NOTE.path}. Update ${BRIEF} for it.`,
    verify: async (verifier) => {
      const answered = await brief(verifier);

      await verifier.check('counts-the-porto-bikes-too', async () => ({
        pass: field(answered, 'unitsToRecall') === RECALL_AFTER_SWAP.units,
        evidence: { answered: field(answered, 'unitsToRecall'), expected: RECALL_AFTER_SWAP.units },
      }));

      await verifier.check('lists-the-porto-dealers-too', async () => ({
        pass: sameDealers(answered, RECALL_AFTER_SWAP.dealers), evidence: { answered: field(answered, 'dealers'), expected: RECALL_AFTER_SWAP.dealers },
      }));
    },
  }],
};

defineTaskEval(defineEvalTask({ id: 'swarm', mission: MISSION, parts: [recall] }));
