/**
 * FIRST RUN: every native tool the root actor can reach answers on the product.
 *
 * THE ASK. One fast row that has the deployed agent say which tools it sees,
 * then use each one once, and reports whether each answered. Every check reads
 * durable state — the file the agent wrote, the ledger's `tool_call_end` rows,
 * the stored transcript — never the model's own account of what it did.
 *
 * WHY EVERY GATE STAYED GREEN. Each tool has unit coverage over inputs its
 * author wrote. Nothing asked the deployed agent to use each one and then read
 * what it left behind, so a tool that fails only when the MODEL calls it on the
 * deployment is invisible to every pre-deploy gate.
 *
 * `agents` is asked for by name in turn one (the agent must SEE it) and left out
 * of turn two: a swarm or hire is its own job with its own row, so this case
 * asserts only that it was not called. `report` is deps-gated to hired actors
 * and the root has none, so it is neither listed nor asked for.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import { formatFailureMix, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import {
  BUILTIN_TOOLS, DEPS_GATED_TOOLS, censusToolFailures, normalizeFactKey, toolFailureKey, type JsonValue, type RunEvent,
} from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { firstRunSpliceStep, firstRunTurnEvents } from './turn-settlement';

const SUITE = 'First-run · every-tool';

const CASE = 'every-tool' as const;

/** The tools a ROOT actor is handed: the standing set minus the ones gated on
 *  deps only a hired actor has. Derived, so a tool that joins or leaves the
 *  table moves this row with it. */
const ROOT_TOOLS: readonly string[] = BUILTIN_TOOLS.filter((name) => !DEPS_GATED_TOOLS.includes(name));

const PROBE_PATH = '/home/main/tools-probe.txt';

const PROBE_BYTES = 'KINU-EVERY-TOOL';

const RUN_MARK = 'tools-probe-ok';

const CODEMODE_MARK = 'codemode-ok';

const FACT = 'every-tool probe: ok';

const TASK_TITLE = 'every-tool probe';

const HEALTH_URL = 'https://kinu.run/api/health';

const LIST_ASK = 'List every tool you can call right now, one per line, names only, nothing else.';

const USE_ASK = 'Use each of these tools exactly once, in this order, then answer. '
  + `1. With the file tool, write ${PROBE_PATH} containing exactly ${PROBE_BYTES} and nothing else. `
  + `2. With the shell tool in the workspace runtime, run: echo ${RUN_MARK} `
  + `3. With eval, run a one-line program that returns the string "${CODEMODE_MARK}". `
  + `4. With the memory tool, save the fact "${FACT}", then search memory for "${TASK_TITLE}". `
  + `5. With the tasks tool, add one task titled "${TASK_TITLE}". `
  + `6. With the web tool, fetch ${HEALTH_URL} and read its "ok" field. `
  + 'Do not use the agents tool. When all six are done, reply with ONE line that starts with DONE '
  + 'followed by the six results in order.';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

function isToolCallEnd(event: RunEvent): event is ToolCallEnd {
  return event.type === 'tool_call_end';
}

/** The one field every action-shaped tool call carries; anything else is the
 *  tool's own business. */
const ActionArgsSchema = v.looseObject({ action: v.optional(v.string()) });

function actionOf(call: ToolCallEnd): string {
  const parsed = v.safeParse(ActionArgsSchema, call.args);

  return parsed.success ? (parsed.output.action ?? '') : '';
}

/** A result as the text a reader greps: a string as-is, anything else as JSON. */
function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

function excerpt(value: string, length = 160): string {
  return JSON.stringify(value.slice(0, length));
}

/** A call answered: closed with no transport error and no refusal outcome. */
function answered(call: ToolCallEnd): boolean {
  return call.error === undefined && call.outcome?.success !== false;
}

function describeFailure(call: ToolCallEnd): string {
  const outcome = call.outcome !== undefined && !call.outcome.success
    ? ` outcome=${call.outcome.reason ?? 'null'}` : '';

  return `${call.name}#${call.toolCallId}${outcome}`
    + (call.error === undefined ? '' : ` error=${excerpt(call.error, 200)}`);
}

/** The FIRST answered call of one tool whose result carries `mark`, as a
 *  subgoal that names the call it found or every call it rejected. */
interface CarriedMark {
  readonly what: string;
  readonly calls: readonly ToolCallEnd[];
  readonly name: string;
  readonly mark: string;
  readonly match: (text: string) => boolean;
}

function callCarrying({ what, calls, name, mark, match }: CarriedMark): EvalSubgoal {
  const own = calls.filter((call) => call.name === name);
  const hit = own.find((call) => answered(call) && match(textOf(call.result)));

  if (hit !== undefined) {
    return { what, reached: true, detail: `${name}#${hit.toolCallId} answered with ${excerpt(textOf(hit.result))}` };
  }

  const seen = own.length === 0
    ? `no ${name} call in this turn`
    : own.map((call) => `${describeFailure(call)} result=${excerpt(textOf(call.result))}`).join('; ');

  return { what, reached: false, detail: `no answered ${name} call carries ${JSON.stringify(mark)}: ${seen}` };
}

/** Why no call of one tool answered: none was made, or what each one refused with. */
function refusedDetail(name: string, own: readonly ToolCallEnd[]): string {
  if (own.length === 0) return `no ${name} call in this turn`;

  return own.map(describeFailure).join('; ');
}

/** Whether every call this turn closed answered, named either way. */
function everyToolDetail(calls: readonly ToolCallEnd[], offenders: readonly ToolCallEnd[]): string {
  if (calls.length === 0) return 'no tool call closed in this turn';

  if (offenders.length === 0) {
    return `all ${String(calls.length)} call(s) answered: ${[...new Set(calls.map((call) => call.name))].join(', ')}`;
  }

  return `${String(offenders.length)} of ${String(calls.length)} failed: ${offenders.map(describeFailure).join('; ')}`;
}

/** A scripted task runs clean: no failure the census calls unexpected (`broke`), codemode calls included. */
function unexpectedFailures(calls: readonly ToolCallEnd[]): EvalSubgoal {
  const census = censusToolFailures(calls);

  const brokeKeys = new Set(census.failures
    .filter((failure) => !failure.refused && !failure.workFailed && !failure.runtimeMissing)
    .map(toolFailureKey));

  const broke = census.byKey.filter(([key]) => brokeKeys.has(key));

  return {
    what: 'no-unexpected-tool-failure', reached: broke.length === 0,
    detail: broke.length === 0
      ? `no unexpected failure in ${String(calls.length)} call(s), codemode calls included`
      : `unexpected ${formatFailureMix(broke)}`,
  };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A terse assistant that uses the tool it is asked to use and reports the result in one line.',
      async run({ session }) {
        const subgoals: EvalSubgoal[] = [];

        // ── Turn 1: the agent names what it sees, and touches nothing. ──────
        // A listing the running turn absorbs is answered by THAT turn — and
        // only the events after the splice belong to it: work the turn did
        // before it ever saw the ask is the run's own, not the listing's.
        const listing = await session.prompt(LIST_ASK);
        const splicedAt = firstRunSpliceStep(await session.history(), LIST_ASK);

        const listedCalls = firstRunTurnEvents(await session.runEvents(), LIST_ASK, {
          splicedAtStep: splicedAt,
          absorbedBy: listing.landed === 'mid-turn' ? listing.absorbedBy : undefined,
        }).filter(isToolCallEnd).length;

        const listed = (await session.history()).filter((row) => row.role === 'assistant').at(-1)?.text ?? '';
        const unseen = ROOT_TOOLS.filter((name) => !listed.includes(name));

        subgoals.push({
          what: 'sees-every-tool', reached: unseen.length === 0,
          detail: unseen.length === 0
            ? `the reply names all of ${ROOT_TOOLS.join(', ')}`
            : `the reply omits ${unseen.join(', ')}: ${excerpt(listed, 240)}`,
        });
        subgoals.push({
          what: 'no-tool-called', reached: listedCalls === 0,
          detail: `${String(listedCalls)} tool call(s) closed while listing`,
        });

        // ── Turn 2: one call per tool, each read back from where it landed. ──
        const known = new Set((await session.runEvents()).filter(isToolCallEnd).map((call) => call.toolCallId));
        await session.prompt(USE_ASK);
        const calls = (await session.runEvents()).filter(isToolCallEnd).filter((call) => !known.has(call.toolCallId));

        const written = (await session.readFile(PROBE_PATH, { allowMissing: true })).trim();

        subgoals.push({
          what: 'file-wrote', reached: written === PROBE_BYTES,
          detail: written === PROBE_BYTES
            ? `${PROBE_PATH} holds ${JSON.stringify(PROBE_BYTES)}`
            : `${PROBE_PATH} holds ${excerpt(written)} rather than ${JSON.stringify(PROBE_BYTES)}`,
        });
        subgoals.push(callCarrying({
          what: 'shell-ran', calls, name: 'shell', mark: RUN_MARK, match: (text) => text.includes(RUN_MARK),
        }));

        subgoals.push(callCarrying({
          what: 'codemode-tool-ran', calls, name: 'eval', mark: CODEMODE_MARK,
          match: (text) => text.includes(CODEMODE_MARK),
        }));

        const memory = calls.filter((call) => call.name === 'memory');

        // `save` or `remember`: the prompt says "save the fact", and the tool
        // takes both words — `save` appends a note to MEMORY.md, `remember`
        // writes a keyed fact (`memory-tool.ts` `case 'save'` vs
        // `runFactAction`). WHAT THE SEARCH MUST NAME therefore depends on
        // which the turn used, and the two render differently: a fact hit as
        // `[fact: <stored key>]` — folded lowercase, whitespace to
        // underscores, never the spelling the call carried — and a note hit as
        // its `MEMORY.md` chunk carrying the written line. Requiring the fact
        // rendering alone made this subgoal unreachable for a turn that chose
        // `save`: measured 2026-09-16 on build cba44dcb9, the turn saved the
        // note and the search answered with it
        // (`[memory/MEMORY.md:1-4] … every-tool probe: ok`) and the row still
        // read "search naming the fact missing".
        const saved = memory.find((call) =>
          (actionOf(call) === 'save' || actionOf(call) === 'remember') && answered(call));

        const names = (result: JsonValue | undefined): boolean => {
          const text = textOf(result);

          return text.includes(`[fact: ${normalizeFactKey(TASK_TITLE)}]`) || text.includes(FACT);
        };

        const found = memory.find((call) =>
          actionOf(call) === 'search' && answered(call) && names(call.result));

        subgoals.push({
          what: 'memory-saved-and-found', reached: saved !== undefined && found !== undefined,
          detail: saved !== undefined && found !== undefined
            ? `memory#${saved.toolCallId} (${actionOf(saved) || '?'}) wrote, search memory#${found.toolCallId} answered with `
              + excerpt(textOf(found.result))
            : `write ${saved === undefined ? 'missing' : 'ok'}, search naming what was written `
              + `${found === undefined ? 'missing' : 'ok'}; memory calls: `
              + (memory.length === 0 ? 'none' : memory.map((call) =>
                `${actionOf(call) || '?'} ${describeFailure(call)} result=${excerpt(textOf(call.result), 80)}`).join('; ')),
        });

        const tasks = calls.filter((call) => call.name === 'tasks');
        const taskWritten = tasks.find(answered);

        subgoals.push({
          what: 'tasks-written', reached: taskWritten !== undefined,
          detail: taskWritten === undefined
            ? refusedDetail('tasks', tasks)
            : `tasks#${taskWritten.toolCallId} (${actionOf(taskWritten) || '?'}) answered with ${excerpt(textOf(taskWritten.result))}`,
        });
        subgoals.push(callCarrying({
          what: 'web-fetched', calls, name: 'web', mark: '"ok":true',
          match: (text) => /"ok"\s*:\s*true/.test(text),
        }));

        const delegated = calls.filter((call) => call.name === 'agents');

        subgoals.push({
          what: 'no-agents-call', reached: delegated.length === 0,
          detail: delegated.length === 0
            ? 'no agents call in this turn'
            : `agents called: ${delegated.map((call) => `${actionOf(call) || '?'}#${call.toolCallId}`).join(', ')}`,
        });

        const offenders = calls.filter((call) => !answered(call));

        subgoals.push({
          what: 'every-tool-answered', reached: calls.length > 0 && offenders.length === 0,
          detail: everyToolDetail(calls, offenders),
        });
        subgoals.push(unexpectedFailures(calls));

        const reply = (await session.history()).filter((row) => row.role === 'assistant').at(-1)?.text ?? '';

        subgoals.push({
          what: 'reported', reached: reply.includes('DONE'),
          detail: `the stored reply ${reply.includes('DONE') ? 'carries' : 'lacks'} DONE: ${excerpt(reply, 240)}`,
        });

        return subgoals;
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
