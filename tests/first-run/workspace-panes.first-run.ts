/**
 * FIRST RUN: the Changes and Supervise panes read a workspace that
 * just did one piece of work.
 *
 * THE ASK. Every user-facing surface has a deployed row. After one turn that
 * writes one file, the Changes pane shows the file against the review baseline
 * and forgets it once the baseline is reset; the Supervise page lists the turn
 * among the workspace's runs and reads its triggers. Each through the RPC its
 * pane calls.
 *
 * WHY NO OTHER ROW GUARDS THIS. The rows that write files read them back
 * through the Files pane and the ledger; none asked the review baseline what
 * changed or the run list what ran.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { ORCHESTRATOR_AGENT_SLUG, type JsonValue } from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';

const SUITE = 'First-run · workspace-panes';

const CASE = 'workspace-panes' as const;

/** The file the turn writes, named so no scaffold file can be it. */
const PROBE = 'panes-probe.txt';

const ASK = `Use your file tool to write a new file named ${PROBE} in the workspace, `
  + 'containing exactly the words panes probe. Then reply with one line: DONE.';

/** The agent's own executor, which the Changes pane opens on. */
const WORKSPACE_EXECUTOR = 'workspace';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const DiffSchema = v.looseObject({ files: v.array(v.looseObject({ path: v.string() })) });

const RunsSchema = v.looseObject({ items: v.array(v.looseObject({ runId: v.string(), status: v.nullable(v.string()) })) });

const TriggersSchema = v.object({ triggers: v.array(v.unknown()) });

/** One RPC as its pane calls it, parsed as the pane parses it. */
async function read<S extends v.GenericSchema>(
  socket: PublicSocket, schema: S, method: string, args: readonly JsonValue[],
): Promise<{ readonly value: v.InferOutput<S> | null; readonly detail: string }> {
  const answer = await ask(socket, method, args);
  const parsed = answer.ok ? v.safeParse(schema, answer.value) : null;

  return parsed !== null && parsed.success
    ? { value: parsed.output, detail: `${method} answered ${JSON.stringify(answer.ok ? answer.value : null).slice(0, 200)}` }
    : { value: null, detail: rpcDetail({ rpc: method, answer, refusal: 'refused', said: null }) };
}

function lists(diff: v.InferOutput<typeof DiffSchema> | null): boolean {
  return diff?.files.some((file) => file.path.endsWith(PROBE)) === true;
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      genesis: false,
      purpose: 'A terse assistant that does the one thing asked and reports it in one line.',
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const socket = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

        try {
          if (!(await socket.opened)) {
            subgoals.push({ what: 'diff-shows-the-write', reached: false, detail: `${socket.path} refused the upgrade` });

            return subgoals;
          }

          // The pane's first read is the review boundary the turn is diffed against.
          const baseline = await read(socket, DiffSchema, 'getExecutorDiff', [WORKSPACE_EXECUTOR]);
          await session.prompt(ASK);

          const changed = await read(socket, DiffSchema, 'getExecutorDiff', [WORKSPACE_EXECUTOR]);

          subgoals.push({
            what: 'diff-shows-the-write',
            reached: baseline.value !== null && !lists(baseline.value) && lists(changed.value),
            detail: `before the turn: ${baseline.detail}; after it: ${changed.detail}`,
          });

          const reset = await ask(socket, 'resetWorkspaceBaseline', []);
          const cleared = await read(socket, DiffSchema, 'getExecutorDiff', [WORKSPACE_EXECUTOR]);

          subgoals.push({
            what: 'baseline-reset-forgets-it',
            reached: reset.ok && cleared.value !== null && !lists(cleared.value),
            detail: `${rpcDetail({ rpc: 'resetWorkspaceBaseline', answer: reset, refusal: 'refused', said: 'resetWorkspaceBaseline answered' })}; then ${cleared.detail}`,
          });

          const runs = await read(socket, RunsSchema, 'getRunSummaries', []);
          const settled = runs.value?.items.filter((run) => run.status !== null && run.status !== 'running') ?? [];

          subgoals.push({ what: 'run-listed-settled', reached: settled.length > 0, detail: runs.detail });

          const triggers = await read(socket, TriggersSchema, 'listTriggers', []);

          subgoals.push({ what: 'triggers-read', reached: triggers.value !== null, detail: triggers.detail });

          return subgoals;
        } finally {
          socket.close('the row is done');
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
