/**
 * FIRST RUN: the agent builds a gadget and its tab answers.
 *
 * THE DEFECT. The owner asked for a small live tab in plain words and the tab
 * came back drawn but dead: the method the client calls failed, or the client
 * never called it. A gadget that cannot answer is worse than no gadget — the
 * tab strip carries it beside the host surfaces.
 *
 * WHY EVERY GATE STAYED GREEN. Every gadget test below the product drives a
 * host the TEST composed: a fixture manifest, a fixture server, a probe
 * object. The behaviour eval drives a real model but never asks it to build a
 * gadget. So the one input a user actually supplies — files the MODEL wrote
 * from words — was never read back through the surfaces the tab uses.
 *
 * WHAT THIS CASE DRIVES. A fresh deployed workspace, the real model, and one
 * ask in plain words: a gadget with one server method and a client that shows
 * its answer. The prompt names the files, the method and the answer the reply
 * must carry, because a case whose ground truth is prose cannot be graded.
 *
 * THE ASSERTIONS, all hard:
 *
 *   listed     the workspace's gadget set holds a tab that was not there when
 *              the case opened. Read off `listGadgets`, the RPC the tab strip
 *              is bound to.
 *   answered   `gadgetCall` on the tab's method answers the known string. The
 *              same socket RPC the tab's bridge forwards over, so a green here
 *              is a statement about the surface a person uses.
 *   shown      the client's own file names the method. A server that answers
 *              with no client calling it is exactly the half-success this case
 *              exists to refuse.
 *
 * NOT PROVED RED AGAINST A DEPLOYED SHA. The build before the gadget commit
 * has no `listGadgets` RPC, so this row fails there on the missing surface
 * and says nothing about the defect it names. The first tier run after a
 * deploy is the measurement, and the row goes green only from that run,
 * never because this file was adjusted.
 */
import { afterAll, describe, test } from 'vitest';

import type { EvalObservation } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
  type FirstRunSubgoal,
} from './first-run';

const SUITE = 'First-run · gadget';
const CASE = 'gadget' as const;

/** The tab, the method, and the answer this file knows without the product. */
const SLUG = 'hello';
const METHOD = 'ping';
const ANSWER = 'pong';

/**
 * The ask, in the words a person uses. It names the files, the method and
 * the answer, and nothing about the host: writing the code here would rebuild
 * the very fixture that missed the defect.
 */
const ASK = 'Add a gadget named "hello" under gadgets/hello/: a gadget.json with v 1 '
  + 'titled "Hello", a server.js whose Gadget class has a method named ping that takes no '
  + 'arguments and returns the string "pong", and a client.js that calls ping over the '
  + 'gadget bridge and shows its answer. Reply with the word "pong" on its own line once '
  + 'the gadget answers it.';

const PLAN = firstRunCasePlan(SUITE, CASE);
const liveTest = test.skipIf(PLAN === null);
const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE,
      purpose: 'A precise engineer who builds small live tabs and checks that they answer.',
      async run({ session }) {
        const turn = await session.prompt(ASK);

        // The tab strip's own read: a tab that appeared is a difference this
        // case observed rather than a name it hoped for.
        const listed = await session.listGadgets();
        const row = listed.find((gadget) => gadget.slug === SLUG) ?? null;

        // The bridge's own call: the method's answer over the socket RPC.
        const call = row === null ? null : await session.gadgetCall(SLUG, METHOD, []);
        const answered = call !== null && call.ok && call.value === ANSWER;

        // The client's own file, through the files route: it must name the
        // method, or nothing calls the server that answers.
        let shown = false;
        let clientDetail = 'client.js was not checked';
        try {
          const client = await session.readFile(`gadgets/${SLUG}/client.js`);
          shown = client.includes(METHOD);
          clientDetail = shown
            ? `client.js names ${METHOD}`
            : `client.js holds ${String(client.length)} chars and never names ${METHOD}`;
        } catch (error) {
          clientDetail = 'client.js could not be read: '
            + (error instanceof Error ? error.message : String(error));
        }

        // The reply, from the durable transcript rather than from the streamed
        // turn: what a user reads when they come back is the stored answer.
        const history = await session.history();
        const reply = history.filter((entry) => entry.role === 'assistant').at(-1)?.text ?? turn.text;

        const subgoals: FirstRunSubgoal[] = [
          {
            what: 'listed',
            reached: row !== null,
            detail: row === null
              ? `no ${SLUG} tab: the strip holds ${listed.map((gadget) => gadget.slug).join(', ') || 'nothing'}`
              : `${row.slug} is on the strip as ${row.title}`,
          },
          {
            what: 'answered',
            reached: answered,
            detail: call === null
              ? 'no call was made: the tab never appeared'
              : `gadgetCall answered ${JSON.stringify(call).slice(0, 200)}`,
          },
          {
            what: 'shown',
            reached: shown,
            detail: `${clientDetail}; the reply ${reply.includes(ANSWER) ? 'carries' : 'does NOT carry'} ${ANSWER}`,
          },
        ];
        return subgoals;
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
