/**
 * FIRST RUN: a delegation tree of uneven depth settles, every branch reporting
 * back through its own parent.
 *
 * THE ASK. Hosted subordinates that delegate in turn: the root hires two
 * task helpers; one hires a helper of its own and relays its answer, the other
 * answers itself. So one branch is two levels deep and the other one, and the
 * tree settles only when the deep answer has climbed both levels and the
 * shallow one its single level. A hire returns at once (cafab2bfc): each
 * answer arrives as a message that opens its hirer's next turn, so the row
 * waits on the turns the root's room closes until both answers are in the
 * root's history (`hirerHeard`). Every check reads durable state, never the
 * model's account of what it did: what each helper answered is read from its
 * own ledger, down the tree through `inspectSubordinate`, the owner's read of
 * a subordinate's runs, since the workspace's `/runs` lists the root's runs only.
 *
 * WHY `delegation` DOES NOT COVER IT. That row hires at one level only. A
 * nested hire runs in a subordinate hosted by the same workspace object, with
 * its own delegation budget one level down, and its answer reaches the root
 * only through the middle helper's settlement — none of which a one-level
 * hire exercises.
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { ORCHESTRATOR_AGENT_SLUG, type RunEvent } from '../../packages/core/src/index';
import type { PublicMessage } from '../../evals/src/session';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { delivered, deliveredInLedger, finalAnswer, taskHires, type TaskHire } from './delegation-observation';
import { ROOT } from '../../evals/src/helper-address';
import { helperAnswer, helperRecord, hirerHeard } from './hires';
import { openPublicSocket, type PublicSocket } from './public-socket';
import {
  RELAY_MISSION, TREE_ASK as ASK, TREE_DEEP_WORD as DEEP, TREE_SHALLOW_WORD as SHALLOW, sayWordMission,
} from './asks';

const SUITE = 'First-run · delegation-tree';

const CASE = 'delegation-tree' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** How much of a message a run's start keeps (`turn-lifecycle.ts`, `slice(0, 500)`). */
const RUN_START_MESSAGE_CHARS = 500;

/** The runs this row's own message opened: the root's turn, never a helper's.
 *  This ask is longer than a run's start keeps, so it is matched as cut. */
function rootRuns(events: readonly RunEvent[]): ReadonlySet<string> {
  const opened = ASK.slice(0, RUN_START_MESSAGE_CHARS);

  return new Set(events.filter((event) => event.type === 'run_start' && event.userMessage === opened).map((event) => event.runId));
}

/** What the tree's helpers answered, each read from its own ledger, and the root's history the answers arrived in. */
interface TreeRead {
  readonly top: readonly TaskHire[];
  readonly relay: TaskHire | undefined;
  readonly shallow: TaskHire | undefined;
  readonly deep: TaskHire | undefined;
  readonly relayEvents: readonly RunEvent[];
  readonly relayAnswer: string;
  readonly deepAnswer: string;
  readonly shallowAnswer: string;
  readonly history: readonly PublicMessage[];
}

/** Down the tree through the root's room: the relay's ledger, its own hire's, and the shallow helper's. */
async function readTree(room: PublicSocket, top: readonly TaskHire[], history: readonly PublicMessage[]): Promise<TreeRead> {
  const relay = top.find((hire) => hire.mission === RELAY_MISSION);
  const shallow = top.find((hire) => hire.mission === sayWordMission(SHALLOW));
  const relayRecord = relay === undefined ? null : await helperRecord(room, ROOT, relay.agent);
  const relayEvents = relayRecord?.events ?? [];
  const [deep] = taskHires(relayEvents);
  const deepAnswer = relayRecord === null || deep === undefined ? '' : await helperAnswer(room, relayRecord.address, deep.agent);
  const shallowAnswer = shallow === undefined ? '' : await helperAnswer(room, ROOT, shallow.agent);
  const relayAnswer = relayRecord === null ? '' : finalAnswer(relayRecord.events, relayRecord.messages);

  return { top, relay, shallow, deep, relayEvents, relayAnswer, deepAnswer, shallowAnswer, history };
}

function treeSubgoals(tree: TreeRead): EvalSubgoal[] {
  const { relay, shallow, deep, relayEvents, relayAnswer, deepAnswer, shallowAnswer, history } = tree;
  const relayed = relay === undefined ? null : delivered(history, ASK, relay.agent);
  const answered = shallow === undefined ? null : delivered(history, ASK, shallow.agent);
  const replies = [relayed?.reply ?? '', answered?.reply ?? ''].join(' ');
  const nested = deep !== undefined && deepAnswer === DEEP && deliveredInLedger(relayEvents, deep.agent);

  const seen = [
    ...tree.top.map((hire) => `root hired ${hire.agent}`),
    ...(deep === undefined ? [] : [`${relay?.agent ?? ''} hired ${deep.agent}, which answered ${JSON.stringify(deepAnswer.slice(0, 40))}`]),
    `${relay?.agent ?? 'no relay'} answered ${JSON.stringify(relayAnswer.slice(0, 40))}`,
    `${shallow?.agent ?? 'no shallow helper'} answered ${JSON.stringify(shallowAnswer.slice(0, 40))}`,
  ].join('; ');

  return [
    {
      what: 'nested-hire-settled',
      reached: nested,
      detail: nested ? `below the root: ${seen}` : `no hire below the root answered ${DEEP} to its hirer: ${seen}`,
    },
    {
      what: 'deep-branch-climbed-both-levels',
      reached: nested && relayAnswer === DEEP && relayed !== null,
      detail: relayed === null ? `no answer from the relay reached the root: ${seen}` : `the relay's answer reached the root: ${JSON.stringify(relayed.text.slice(0, 200))}`,
    },
    {
      what: 'shallow-branch-settled',
      reached: shallowAnswer === SHALLOW && answered !== null,
      detail: answered === null ? `no answer from the shallow helper reached the root: ${seen}` : `the shallow helper's answer reached the root: ${JSON.stringify(answered.text.slice(0, 200))}`,
    },
    {
      what: 'root-reported-both',
      reached: replies.includes(DEEP) && replies.includes(SHALLOW),
      detail: `the root replied to the answers: ${JSON.stringify(replies.slice(0, 200))}`,
    },
  ];
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      genesis: false,
      purpose: 'A precise coordinator that delegates exactly as asked and relays answers verbatim.',
      async run({ session, plan, budget }) {
        const room = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

        if (!(await room.opened)) throw new Error('the workspace room refused the upgrade');

        try {
          // Registered before the hires are sent, so no turn an answer opens can close unseen.
          const closed = room.turnClosed();
          await session.prompt(ASK);

          const events = await session.runEvents();
          const root = rootRuns(events);
          const top = taskHires(events.filter((event) => root.has(event.runId)));

          await hirerHeard(room, closed, async () => {
            const history = await session.history();

            return top.length === 2 && top.every((hire) => delivered(history, ASK, hire.agent) !== null);
          });

          return treeSubgoals(await readTree(room, top, await session.history()));
        } finally {
          room.close('the tree is read');
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
