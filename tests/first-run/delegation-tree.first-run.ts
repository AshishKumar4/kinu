/**
 * FIRST RUN: a delegation tree of uneven depth settles, every branch reporting
 * back through its own parent.
 *
 * THE ASK. Hosted subordinates that delegate in turn: the root hires two
 * task helpers; one hires a helper of its own and relays its answer, the other
 * answers itself. So one branch is two levels deep and the other one, and the
 * tree settles only when the deep answer has climbed both levels and the
 * shallow one its single level. Every check reads the ledger's `agents`
 * rows and the stored reply, never the model's account of what it did. A
 * helper's own rows are its own actor's: they are read down the tree through
 * `inspectSubordinate`, the owner's read of a subordinate's runs, since the
 * workspace's `/runs` lists the root's runs only.
 *
 * WHY `delegation` DOES NOT COVER IT. That row hires at one level only. A
 * nested hire runs in a subordinate hosted by the same workspace object, with
 * its own delegation budget one level down, and its answer reaches the root
 * only through the middle helper's settlement — none of which a one-level
 * hire exercises.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  ORCHESTRATOR_AGENT_SLUG, RunEventSchema, type JsonValue, type RunEvent,
} from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { ask, openPublicSocket, type PublicSocket } from './public-socket';
import { TREE_ASK as ASK, TREE_DEEP_WORD as DEEP, TREE_SHALLOW_WORD as SHALLOW } from './asks';

const SUITE = 'First-run · delegation-tree';

const CASE = 'delegation-tree' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

const HireArgsSchema = v.looseObject({ action: v.literal('hire'), lifetime: v.literal('task') });

const TaskAnswerSchema = v.looseObject({
  status: v.literal('completed'), lifetime: v.literal('task'), agent: v.string(), answer: v.string(),
});

/** One settled task hire: the run that made it, whom it hired, what came back. */
interface SettledHire {
  readonly runId: string;
  readonly agent: string;
  readonly answer: string;
}

/** Every task hire in the ledger that settled with an answer, from any level. */
function settledHires(events: readonly RunEvent[]): SettledHire[] {
  return events
    .filter((event): event is ToolCallEnd => event.type === 'tool_call_end' && event.name === 'agents')
    .filter((call) => v.safeParse(HireArgsSchema, call.args).success && call.error === undefined)
    .flatMap((call) => {
      const answer = v.safeParse(TaskAnswerSchema, call.result);

      return answer.success ? [{ runId: call.runId, agent: answer.output.agent, answer: answer.output.answer.trim() }] : [];
    });
}

const ChildrenPageSchema = v.object({
  page: v.object({ items: v.array(v.looseObject({ name: v.string(), actorReference: v.nullable(v.object({ actorId: v.string() })) })) }),
});

const RunsPageSchema = v.object({ page: v.object({ items: v.array(v.object({ runId: v.string() })) }) });

const EventsPageSchema = v.object({
  page: v.variant('status', [
    v.object({ status: v.literal('more'), items: v.array(RunEventSchema), next: v.number() }),
    v.object({ status: v.literal('end'), items: v.array(RunEventSchema) }),
  ]),
});

/** One inspection answer, parsed, or the refusal it carried. */
async function inspect<T>(socket: PublicSocket, request: JsonValue, schema: v.GenericSchema<unknown, T>): Promise<T> {
  const answer = await ask(socket, 'inspectSubordinate', [request]);

  if (!answer.ok) throw new Error(`inspectSubordinate ${JSON.stringify(request)} refused: ${answer.failure}`);
  const parsed = v.safeParse(schema, answer.value);

  if (!parsed.success) throw new Error(`inspectSubordinate ${JSON.stringify(request)} answered ${JSON.stringify(answer.value).slice(0, 300)}`);

  return parsed.output;
}

/** Every run event a hosted actor recorded, read as its owner reads it, by id: a task helper has retired by now. */
async function actorEvents(socket: PublicSocket, actor: string): Promise<RunEvent[]> {
  const runs = await inspect(socket, { path: [], view: 'runs', page: { limit: 200 }, actor }, RunsPageSchema);
  const events: RunEvent[] = [];

  for (const { runId } of runs.page.items) {
    for (let since: number | undefined = 0; since !== undefined;) {
      const { page }: v.InferOutput<typeof EventsPageSchema> = await inspect(socket, { path: [], view: 'events', runId, query: { since }, actor }, EventsPageSchema);
      events.push(...page.items);
      since = page.status === 'more' ? page.next : undefined;
    }
  }

  return events;
}

/** How much of a message a run's start keeps (`turn-lifecycle.ts`, `slice(0, 500)`). */
const RUN_START_MESSAGE_CHARS = 500;

/** The runs this row's own message opened: the root's turn, never a helper's.
 *  This ask is longer than a run's start keeps, so it is matched as cut. */
function rootRuns(events: readonly RunEvent[]): ReadonlySet<string> {
  const opened = ASK.slice(0, RUN_START_MESSAGE_CHARS);

  return new Set(events.filter((event) => event.type === 'run_start' && event.userMessage === opened).map((event) => event.runId));
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
        await session.prompt(ASK);

        const events = await session.runEvents();
        const root = rootRuns(events);
        const top = settledHires(events).filter((hire) => root.has(hire.runId));
        const socket = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

        if (!(await socket.opened)) throw new Error('the workspace room refused the upgrade');

        // Each root hire's own task hires, from that helper's own ledger.
        const nested: (SettledHire & { readonly hirer: string })[] = [];

        try {
          const roster = await inspect(socket, { path: [], view: 'children', page: { limit: 200 } }, ChildrenPageSchema);

          for (const hire of top) {
            const actor = roster.page.items.find((row) => row.name === hire.agent)?.actorReference?.actorId;

            if (actor === undefined) throw new Error(`the root's roster has no actor for its hire ${hire.agent}`);
            nested.push(...settledHires(await actorEvents(socket, actor)).map((own) => ({ ...own, hirer: hire.agent })));
          }
        } finally {
          socket.close('the tree is read');
        }

        const deep = nested.find((hire) => hire.answer === DEEP);
        const middle = deep === undefined ? undefined : top.find((hire) => hire.agent === deep.hirer && hire.answer === DEEP);
        const shallow = top.find((hire) => hire.answer === SHALLOW);
        const reply = (await session.history()).filter((row) => row.role === 'assistant').at(-1)?.text ?? '';

        const seen = [
          ...top.map((hire) => `root→${hire.agent}: ${JSON.stringify(hire.answer.slice(0, 40))}`),
          ...nested.map((hire) => `${hire.hirer}→${hire.agent}: ${JSON.stringify(hire.answer.slice(0, 40))}`),
        ].join('; ');

        return [
          {
            what: 'nested-hire-settled',
            reached: deep !== undefined,
            detail: nested.length > 0 ? `below the root: ${seen}` : `no hire settled below the root; settled hires: ${seen || 'none'}`,
          },
          {
            what: 'deep-branch-climbed-both-levels',
            reached: middle !== undefined,
            detail: middle !== undefined ? `${middle.agent} relayed ${DEEP} from its own helper ${deep?.agent ?? ''}` : `no root hire relayed ${DEEP} from a helper of its own: ${seen || 'none'}`,
          },
          {
            what: 'shallow-branch-settled',
            reached: shallow !== undefined,
            detail: shallow !== undefined ? `${shallow.agent} answered ${SHALLOW} at one level` : `no root hire answered ${SHALLOW}: ${seen || 'none'}`,
          },
          {
            what: 'root-reported-both',
            reached: reply.includes(DEEP) && reply.includes(SHALLOW),
            detail: `the stored reply: ${JSON.stringify(reply.slice(0, 200))}`,
          },
        ] satisfies EvalSubgoal[];
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
