/**
 * The first-run tier's model: a script (`scripts/scripted-model.ts`) that makes the calls each case's ask names, so a
 * case asserts the product's plumbing on the same calls every run. Whether a real model makes those calls when asked
 * is an eval's question (evals/), not a deploy gate's.
 *
 * A case's words are read from `asks.ts`; the calls are made in the ask's order, one per step, and what each answer
 * reports is read back from the results the product returned, never known in advance: a reply that carries a marker
 * carries it because the product delivered it. Helpers a case hires, and a swarm's nodes, are answered by their
 * missions. A request no case owns, a workspace's opening turn included, is left to the fallback answer.
 */
import * as v from 'valibot';
import type { JsonObject } from '@kinu.run/core';
import type { ScriptedAnswer, ScriptedCall, ScriptedRequest } from '../../scripts/scripted-protocol';
import {
  CONSENT_ASK, CRAFT_ASK, CRAFT_INPUT, DELEGATION_ROSTER_ASK, DELEGATION_TASK_ASK, DELEGATION_WORD, FLEET_ALPHA,
  HELLO_SLATE_ASK, HELLO_SLATE_ID,
  INTERNAL_FETCH_MISSION, INTERNAL_FETCH_PROGRAM, INTERNAL_URL, ISOLATION_ASK, MOUNT_ASK, MOUNT_BYTES,
  MOUNT_LISTING_PROGRAM, MOUNT_TARGET, NAMED_MACHINE_ASK, PANES_ASK, PANES_PROBE, RELAY_MISSION, SEARCH_ASK,
  SEARCH_QUERY, SETTLE_ASK, SETTLE_MARKER, STANDBY_MISSION, SWARM_ASK, SWARM_TASK, TOOLS_CODEMODE_MARK, TOOLS_FACT,
  TOOLS_HEALTH_URL, TOOLS_LIST_ASK, TOOLS_PROBE_BYTES, TOOLS_PROBE_PATH, TOOLS_RUN_MARK, TOOLS_TASK_TITLE,
  TOOLS_USE_ASK, TREE_ASK, TREE_DEEP_WORD, TREE_SHALLOW_WORD, UNNAMED_MACHINE_ASK, WAKE_ASK, WAKE_STEPS,
  sayWordMission,
} from './asks';
import { LISTING_TURN, STEER, STEER_MARKER, STEER_TURN } from './steer-observation';

type Script = (request: ScriptedRequest) => ScriptedAnswer | null;

/** A call with the one line of prose a model sends beside it. */
function call(name: string, args: JsonObject): ScriptedAnswer {
  return { text: `Calling ${name}.`, toolCall: { name, arguments: args } };
}

/** The steps of one ask, taken in order: the call its turn has not made yet, then `answer` over their results. */
function steps(request: ScriptedRequest, calls: readonly ScriptedAnswer[], answer: (turn: readonly ScriptedCall[]) => string): ScriptedAnswer {
  return calls[request.turn.length] ?? { text: answer(request.turn) };
}

const latest = (request: ScriptedRequest): string => request.userTexts.at(-1) ?? '';

/** A result's text on one line, so a one-line reply stays one line. */
function oneLine(result: string | undefined): string {
  return (result ?? '').replaceAll(/\s+/g, ' ').trim();
}

/** The names a roster listing returned: every `name` field in its result. */
function namesIn(result: string): string[] {
  return [...result.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(([, name]) => name ?? '');
}

const HireAnswerSchema = v.pipe(v.string(), v.parseJson(), v.looseObject({ answer: v.string() }));

/** A name as the dismiss ask quotes it: a JSON string. */
const QuotedNameSchema = v.pipe(v.string(), v.parseJson(), v.string());

/** What a task hire's helper answered: its result's `answer`, else the result's own text. */
function hireAnswer(result: string | undefined): string {
  const parsed = v.safeParse(HireAnswerSchema, result);

  return parsed.success ? parsed.output.answer.trim() : oneLine(result);
}

const hire = (mission: string): ScriptedAnswer => call('agents', { action: 'hire', lifetime: 'task', role: 'task', mission });

const why = 'The owner asked for this command on that machine.';

/** steer-correction. The correction redirects the second file wherever it lands, mid-turn or as the next turn, so the
 *  step is chosen by what the conversation has written, not by how many calls this turn made. */
const steerCorrection: Script = (request) => {
  if (!request.userTexts.includes(STEER_TURN)) return null;

  if (latest(request) === LISTING_TURN) {
    return steps(request, [call('file', { action: 'list', path: 'notes' })],
      ([listing]) => [...new Set(listing?.result.match(/[\w.-]+\.txt/g) ?? [])].join('\n'));
  }

  const wrote = (path: string): boolean => request.calls.some((made) => made.name === 'file' && made.arguments.includes(`"${path}"`));
  const steered = request.userTexts.includes(STEER);

  if (!wrote('notes/wal.txt')) {
    return call('file', {
      action: 'write', path: 'notes/wal.txt',
      content: 'A write-ahead log records each change before it is applied.\nThe record is appended and flushed first.\n'
        + 'After a crash the log is replayed.\nSo no acknowledged change is lost.\n',
    });
  }

  if (steered && !wrote('notes/steered.txt')) {
    return call('file', { action: 'write', path: 'notes/steered.txt', content: `${STEER_MARKER}\nA log written before the data.\n` });
  }

  if (!steered && !wrote('notes/short.txt')) {
    return call('file', { action: 'write', path: 'notes/short.txt', content: 'A log written before the data.\n' });
  }

  return { text: 'DONE' };
};

/** background-settle: the sleep, then what its call returned. A handle means it detached, and the wake reports it. */
const backgroundSettle: Script = (request) => latest(request) !== SETTLE_ASK ? null : steps(request, [
  call('shell', { runtime: 'sandbox', command: `sleep 45 && echo ${SETTLE_MARKER}`, why: 'The command sleeps longer than a workspace call waits.' }),
], ([shell]) => {
  const job = shell?.result.match(/bgjob-[\w-]+/)?.[0];

  return job === undefined
    ? `It printed: ${oneLine(shell?.result)}`
    : `The command is still running in the background as ${job}; I will report what it prints when it finishes.`;
});

/** A background job's wake: its result read with `agent.jobResult`, then reported. */
const jobWake: Script = (request) => {
  const job = /^Background \w+ job (bgjob-[\w-]+) completed/.exec(latest(request))?.[1];

  if (job === undefined) return null;

  return steps(request, [
    call('eval', { code: `// Read the finished job's result\nreturn await agent.jobResult('${job}');` }),
  ], ([read]) => `The job finished: ${oneLine(read?.result)}`);
};

/** How long each of background-wake's later model calls takes: long enough that the row's two resets of the
 *  workspace land while the turn is still inside its steps, as they do behind a real model. */
const WAKE_STEP_PACE = { firstTokenMs: 15_000, lead: '', leadMs: 0 };

/** background-wake: the three commands, one call each, then the words they printed. Every call after the first is
 *  paced, so the turn is still open when the row resets its workspace. */
const backgroundWake: Script = (request) => {
  if (latest(request) !== WAKE_ASK) return null;

  const answer = steps(request, WAKE_STEPS.map((step) => call('shell', { runtime: 'workspace', command: `echo ${step}` })),
    (turn) => turn.map((made) => made.result.trim()).join('\n'));

  return request.turn.length === 0 ? answer : { ...answer, pace: WAKE_STEP_PACE };
};

/** capability-isolation: the three paths, in the ask's order. */
const capabilityIsolation: Script = (request) => latest(request) !== ISOLATION_ASK ? null : steps(request, [
  call('web', { action: 'fetch', url: INTERNAL_URL }),
  call('eval', { code: INTERNAL_FETCH_PROGRAM }),
  hire(INTERNAL_FETCH_MISSION),
], (turn) => `DONE ${turn.map((made) => `${made.name}: ${oneLine(made.result).slice(0, 160)}`).join(' | ')}`);

const delegation: Script = (request) => {
  const ask = latest(request);

  if (ask === DELEGATION_TASK_ASK) {
    return steps(request, [hire(sayWordMission(DELEGATION_WORD))], ([hired]) => `HIRED ${hireAnswer(hired?.result)}`);
  }

  if (ask === DELEGATION_ROSTER_ASK) {
    return steps(request, [
      call('agents', { action: 'hire', role: 'task', mission: STANDBY_MISSION }),
      call('agents', { action: 'list' }),
    ], ([, roster]) => `ROSTER ${namesIn(roster?.result ?? '').join(' ')}`);
  }

  const dismissed = /^Dismiss the durable helper with your agents tool: action dismiss, agent (".*?")\. /.exec(ask)?.[1];

  if (dismissed === undefined) return null;

  return steps(request, [
    call('agents', { action: 'dismiss', agent: v.parse(QuotedNameSchema, dismissed) }),
    call('agents', { action: 'list' }),
  ], () => 'RETIRED');
};

const delegationTree: Script = (request) => latest(request) !== TREE_ASK ? null : steps(request, [
  hire(RELAY_MISSION),
  hire(sayWordMission(TREE_SHALLOW_WORD)),
], ([first, second]) => `TREE ${hireAnswer(first?.result)} ${hireAnswer(second?.result)}`);

const exploration: Script = (request) => latest(request) !== SWARM_ASK ? null : steps(request, [
  call('agents', { action: 'swarm', preset: 'ideate', task: SWARM_TASK }),
], ([swarm]) => {
  const job = swarm?.result.match(/bgjob-[\w-]+/)?.[0];

  return job === undefined
    ? `SWARM ${oneLine(swarm?.result).slice(0, 600)}`
    : `The swarm is running in the background as ${job}; I will report what it returns.`;
});

/** machine-consent: the same ask twice, before and after a machine is connected. */
const machineConsent: Script = (request) => latest(request) !== CONSENT_ASK ? null : steps(request, [
  call('shell', { runtime: 'device', command: 'hostname', why }),
], ([shell]) => `HOST ${oneLine(shell?.result).slice(0, 300)}`);

const sandboxMountWrite: Script = (request) => latest(request) !== MOUNT_ASK ? null : steps(request, [
  call('file', { action: 'list', path: MOUNT_TARGET.slice(0, MOUNT_TARGET.lastIndexOf('/')) }),
  call('file', { action: 'write', path: MOUNT_TARGET, content: MOUNT_BYTES }),
  call('file', { action: 'read', path: MOUNT_TARGET }),
  call('eval', { code: MOUNT_LISTING_PROGRAM }),
], () => `Wrote ${MOUNT_TARGET}.`);

/** two-machines: an unnamed call, answered with what the executor said; then a call naming alpha. */
const MACHINE_ASKS = new Map([[UNNAMED_MACHINE_ASK, 'device'], [NAMED_MACHINE_ASK, FLEET_ALPHA]]);

const twoMachines: Script = (request) => {
  const runtime = MACHINE_ASKS.get(latest(request));

  if (runtime === undefined) return null;

  return steps(request, [call('shell', { runtime, command: 'hostname', why })], ([shell]) => oneLine(shell?.result));
};

const webSearch: Script = (request) => latest(request) !== SEARCH_ASK ? null : steps(request, [
  call('web', { action: 'search', query: SEARCH_QUERY }),
], ([search]) => search?.result.match(/https?:\/\/[^\s"'<>\\)]+/)?.[0] ?? 'NONE');

const workspacePanes: Script = (request) => latest(request) !== PANES_ASK ? null : steps(request, [
  call('file', { action: 'write', path: PANES_PROBE, content: 'panes probe' }),
], () => 'DONE');

/** every-tool: the tools the request offers, then one call per tool in the ask's order. */
const everyTool: Script = (request) => {
  const ask = latest(request);

  if (ask === TOOLS_LIST_ASK) return { text: request.available.join('\n') };

  if (ask !== TOOLS_USE_ASK) return null;

  return steps(request, [
    call('file', { action: 'write', path: TOOLS_PROBE_PATH, content: TOOLS_PROBE_BYTES }),
    call('shell', { runtime: 'workspace', command: `echo ${TOOLS_RUN_MARK}` }),
    call('eval', { code: `// Return the mark\nreturn '${TOOLS_CODEMODE_MARK}';` }),
    call('memory', { action: 'save', content: TOOLS_FACT }),
    call('memory', { action: 'search', query: TOOLS_TASK_TITLE }),
    call('tasks', { action: 'add', titles: [TOOLS_TASK_TITLE] }),
    call('web', { action: 'fetch', url: TOOLS_HEALTH_URL }),
  ], (turn) => `DONE ${turn.map((made) => oneLine(made.result).slice(0, 80)).join(' | ')}`);
};

/** The tool codemode-craft builds: a real loop over the digits, so only running it answers. */
const DIGIT_SUM = 'async ({ number }) => { let sum = 0; for (const digit of String(number)) sum += Number(digit); return sum; }';

/** codemode-craft: the craft, the crafted tool's call, then the number it returned. */
const codemodeCraft: Script = (request) => latest(request) !== CRAFT_ASK ? null : steps(request, [
  call('eval', { code: `// Create the digitSum tool\nreturn await workspace.createTool('digitSum', 'Adds up the digits of a number.', ${JSON.stringify(DIGIT_SUM)});` }),
  call('eval', { code: `// Sum the digits of ${CRAFT_INPUT}\nreturn await tools.digitSum({ number: '${CRAFT_INPUT}' });` }),
], ([, summed]) => oneLine(summed?.result));

/** The slate the slate case builds: its manifest, and a server answering GET /ping and nothing else. */
const HELLO_SLATE_FILES = {
  'package.json': JSON.stringify({ main: 'server.ts', slate: { title: 'Hello', port: 8787, bindings: {} } }, null, 2),
  'server.ts': [
    'import { SlateObject } from "kinu:slate";',
    '',
    'export class Slate extends SlateObject {',
    '  async fetch(request: Request) {',
    '    const path = new URL(request.url).pathname;',
    '',
    '    if (path === "/ping") return Response.json({ message: "pong", method: request.method, path });',
    '',
    '    return new Response("not found", { status: 404 });',
    '  }',
    '}',
    '',
  ].join('\n'),
};

/** slate: the two files, then its preview, then pong beside the URL the preview answered with. */
const helloSlate: Script = (request) => latest(request) !== HELLO_SLATE_ASK ? null : steps(request, [
  ...Object.entries(HELLO_SLATE_FILES).map(([name, content]) => call('file', { action: 'write', path: `/slates/${HELLO_SLATE_ID}/${name}`, content })),
  call('eval', { code: `// Start the ${HELLO_SLATE_ID} slate's preview\nreturn await workspace.slates.${HELLO_SLATE_ID}.$preview();` }),
], (turn) => `pong\n${turn.at(-1)?.result.match(/https?:\/\/[^\s"'\\]+/)?.[0] ?? 'no preview URL'}`);

/** The words every case sends its root agent: a conversation holding one is a case's, never a helper's. */
const CASE_ASKS: readonly string[] = [
  STEER_TURN, SETTLE_ASK, WAKE_ASK, ISOLATION_ASK, DELEGATION_TASK_ASK, DELEGATION_ROSTER_ASK, TREE_ASK, SWARM_ASK,
  CONSENT_ASK, MOUNT_ASK, UNNAMED_MACHINE_ASK, NAMED_MACHINE_ASK, SEARCH_ASK, PANES_ASK, TOOLS_LIST_ASK, TOOLS_USE_ASK,
  CRAFT_ASK, HELLO_SLATE_ASK,
];

/** What a hired helper or a swarm node does, by the mission it was given. */
const MISSIONS: readonly (readonly [string, Script])[] = [
  [RELAY_MISSION, (request) => steps(request, [hire(sayWordMission(TREE_DEEP_WORD))], ([hired]) => hireAnswer(hired?.result))],
  [INTERNAL_FETCH_MISSION, (request) => steps(request, [call('web', { action: 'fetch', url: INTERNAL_URL })], ([fetched]) => oneLine(fetched?.result))],
  ...[DELEGATION_WORD, TREE_DEEP_WORD, TREE_SHALLOW_WORD].map((word): readonly [string, Script] => [sayWordMission(word), () => ({ text: word })]),
  [SWARM_TASK, () => ({ text: 'Banana' })],
];

/**
 * A helper's own mission: the one its conversation opens with, else the only one its context names at all. A hired
 * helper may also be given a digest of its hirer's messages, which can quote other helpers' missions, so a mission
 * found anywhere in a longer text is trusted only when no other one is.
 */
const helper: Script = (request) => {
  const [opening = ''] = request.userTexts;

  if (CASE_ASKS.includes(opening)) return null;

  const context = [request.system, ...request.userTexts].join('\n');
  const named = MISSIONS.filter(([mission]) => context.includes(mission));
  const own = MISSIONS.find(([mission]) => opening.startsWith(mission)) ?? (named.length === 1 ? named[0] : undefined);

  return own === undefined ? null : own[1](request);
};

const SCRIPTS: readonly Script[] = [
  steerCorrection, backgroundSettle, backgroundWake, capabilityIsolation, delegation, delegationTree, exploration,
  machineConsent, sandboxMountWrite, twoMachines, webSearch, workspacePanes, everyTool, codemodeCraft, helloSlate, jobWake,
  helper,
];

/** The first answer a case script gives, or null for a request no case owns. */
export function firstRunScript(request: ScriptedRequest): ScriptedAnswer | null {
  for (const script of SCRIPTS) {
    const answer = script(request);

    if (answer !== null) return answer;
  }

  return null;
}
