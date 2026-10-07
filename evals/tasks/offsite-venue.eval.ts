import { WORKSPACE_ROOT } from '@kinu.run/core';
import { shows, sightEvidence, type Sight } from '../src/sight';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';
import { answerShows, answersWithSlates, madeNoApp, readAnswer } from './ephemeral';

// The agent's choice between the two kinds of slate. First a pick-one card in the chat: the venues that fit the team,
// each with the total the checker computes, one click to pick, and the agent acting on the pick it is sent. That is
// a one-off view, an ephemeral slate, and no app. Then a place to keep every quarter's offsite: a lasting app with
// state, a file slate, which must still show the booking after the workspace restarts.

const MISSION = "Brightline's people-ops workspace: offsites, travel and team events.";

const VENUES_PATH = `${WORKSPACE_ROOT}/offsite/venues.json`;

const BOOKING_PATH = `${WORKSPACE_ROOT}/offsite/booking.md`;

const HEADCOUNT = 14;

const VENUES = [
  { name: 'Harbor Loft', city: 'Lisbon', capacity: 20, pricePerHeadUsd: 87, roomFeeUsd: 450, date: '2027-05-13' },
  { name: 'Cedar House', city: 'Porto', capacity: 16, pricePerHeadUsd: 74, roomFeeUsd: 620, date: '2027-05-20' },
  { name: 'Quinta Verde', city: 'Sintra', capacity: 12, pricePerHeadUsd: 65, roomFeeUsd: 300, date: '2027-05-14' },
  { name: 'Atlas Studio', city: 'Lisbon', capacity: 30, pricePerHeadUsd: 92, roomFeeUsd: 0, date: '2027-05-27' },
] as const;

type Venue = (typeof VENUES)[number];

const NAMES = VENUES.map((venue) => venue.name);

/** A venue's total for the team: its price per head for everyone, and its room fee. */
function totalUsd(venue: Venue): number {
  return venue.pricePerHeadUsd * HEADCOUNT + venue.roomFeeUsd;
}

const FITTING = VENUES.filter((venue) => venue.capacity >= HEADCOUNT);

/** The checker's pick: a venue that fits, neither the cheapest nor the first offered, so a guess at it is a guess. */
const PICK = VENUES[1];

/** The card offers each venue that fits, with its total, and none that does not. */
function offersTheVenuesThatFit(sight: Sight): boolean {
  return FITTING.every((venue) => (sight.regions[venue.name] ?? []).some((region) => shows(region.text, totalUsd(venue))))
    && VENUES.every((venue) => FITTING.includes(venue) || (sight.regions[venue.name] ?? []).length === 0);
}

/** Whether `text` names the pick's venue, date, headcount and total. */
function namesThePick(text: string): boolean {
  return text.includes(PICK.name) && (text.includes(PICK.date) || /\bMay\s+20\b|\b20\s+May\b/i.test(text))
    && shows(text, HEADCOUNT) && shows(text, totalUsd(PICK));
}

/** One of the workspace's file slates, opened in the work surface, shows the pick's booking: its venue, date, headcount
 *  and total together in the booking's own part of the page, as a record and not a catalogue's price. */
async function anAppShowsTheBooking(verifier: EvalVerifier): Promise<EvalCheckOutcome> {
  const listing = await verifier.slates();

  const readings = await verifier.browse((browser) => Promise.all(listing.slates.map(async (slate) => {
    const view = await browser.workSurface(slate.id);
    const { sight, held } = await view.until(NAMES, (seen) => (seen.regions[PICK.name] ?? []).some((region) => namesThePick(region.text)));

    return { slate: slate.id, held, seen: sightEvidence(sight) };
  })));

  return { pass: readings.some((reading) => reading.held), evidence: { slates: listing.slates.map((slate) => slate.id), readings } };
}

const task = defineEvalTask({
  id: 'offsite-venue',
  mission: MISSION,
  turns: [{
    seed: [{ path: VENUES_PATH, content: `${JSON.stringify(VENUES, null, 2)}\n` }],
    prompt: `We're booking the team offsite for ${String(HEADCOUNT)} people. Show me the venues in ${VENUES_PATH} that
can take all of us, each with its date and its total for the team (the price per head for everyone plus the room
fee), so I can pick one with a click. Once I pick, write the booking request to ${BOOKING_PATH}: the venue, its
date, the headcount and the total.`,
    verify: async (verifier) => {
      await answersWithSlates(verifier, 1);
      await madeNoApp(verifier);

      await verifier.check('offers-the-venues-that-fit', () => answerShows(verifier, NAMES, offersTheVenuesThatFit));

      await verifier.check('a-pick-reaches-the-agent', async () => {
        // Written before the pick, a booking says nothing about the pick reaching the agent.
        const early = await verifier.readFile(BOOKING_PATH);

        const reached = await verifier.browse(async (browser) => {
          const card = (await readAnswer(browser, 1, NAMES, offersTheVenuesThatFit)).find((reading) => reading.held);

          if (card === undefined) return { acted: false, runs: [] };
          const reach = await verifier.reach(() => card.view.press(NAMES, { name: PICK.name, label: null }));

          // What the page said of the click: a send it could not make fails there, out of the agent's sight.
          return { ...reach, faults: await card.view.faults() };
        });

        const booking = await verifier.readFile(BOOKING_PATH);

        return {
          pass: early === '' && reached.runs.some((run) => run.tools.length > 0) && namesThePick(booking),
          evidence: { early: early.slice(0, 300), ...reached, pick: PICK.name, total: totalUsd(PICK), booking: booking.slice(0, 600) },
        };
      });

      await verifier.check('a-reload-shows-the-same', () => answerShows(verifier, NAMES, offersTheVenuesThatFit));
    },
  }, {
    prompt: `We'll hold one of these every quarter. Set up something we keep using for it: the venues we know, each
quarter's booking with its venue, date, headcount and total, and what we've spent on offsites this year. Start it
with the booking we just made.`,
    verify: async (verifier) => {
      await verifier.check('keeps-the-bookings-in-an-app', () => anAppShowsTheBooking(verifier));
    },
    verifyAfterEviction: async (verifier) => {
      await verifier.check('the-app-keeps-the-booking', () => anAppShowsTheBooking(verifier));
    },
  }],
});

if (!FITTING.includes(PICK) || FITTING[0] === PICK || totalUsd(PICK) === Math.min(...FITTING.map(totalUsd))) {
  throw new Error(`${PICK.name} must fit the team and be neither the first venue offered nor the cheapest`);
}

defineTaskEval(task);
