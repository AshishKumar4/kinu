/**
 * The durability canary's scripted model (`scripts/durability-canary.ts`). The canary asks for a long turn with no
 * client connected, and each step is a shell call that sleeps and then prints its own marker. So the run ledger
 * answers what the canary counts: a marker printed twice is a step bought twice; a marker never printed is a step lost.
 *
 * Two workloads, because hours of agent work arrive both ways in production:
 *  - inline: each step sleeps under the interactive detach threshold (`BACKGROUND_POLICY`, 30 s), so the root turn
 *    itself stays open for steps x sleep;
 *  - detached: a few steps sleep past it, so each becomes a background job that must settle on its own.
 * The root also starts one swarm and hires one task helper whose own steps sleep the same way.
 *
 * The ask names its own load, so the model stays a pure function of the request, as every tier model is.
 */
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

export const CANARY_PREFIX = 'KINU_CANARY';

export interface CanaryLoad {
  /** Inline sleeping steps the root turn takes after its swarm, hire and jobs. */
  readonly steps: number;
  /** Seconds each inline step sleeps: under the 30 s detach threshold. */
  readonly sleepSeconds: number;
  /** Steps that sleep past the threshold and so detach into background jobs. */
  readonly jobs: number;
  readonly jobSleepSeconds: number;
  /** Inline steps the hired helper and each swarm node take. */
  readonly helperSteps: number;
}

type Who = 'root' | 'helper' | 'node';

function loadText(who: Who, load: CanaryLoad): string {
  return `${CANARY_PREFIX} ${who} steps=${String(load.steps)} sleep=${String(load.sleepSeconds)} jobs=${String(load.jobs)} `
    + `jobsleep=${String(load.jobSleepSeconds)} helper=${String(load.helperSteps)}`;
}

export function canaryAsk(load: CanaryLoad): string {
  return loadText('root', load);
}

export function canaryMarker(who: Who | 'job', step: number): string {
  return `${CANARY_PREFIX}_${who.toUpperCase()}_STEP_${String(step)}`;
}

const CANARY_LOAD = /KINU_CANARY (root|helper|node) steps=(\d+) sleep=(\d+) jobs=(\d+) jobsleep=(\d+) helper=(\d+)/;

function sleepStep(who: Who | 'job', step: number, sleepSeconds: number): ScriptedAnswer {
  return {
    text: `Step ${String(step)}.`,
    toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: `sleep ${String(sleepSeconds)}; echo ${canaryMarker(who, step)}` } },
  };
}

/** The load a conversation's own opening message names, else the only one its context names. A helper's context can
 *  quote its hirer's ask, so the opening message decides. */
function loadOf(request: ScriptedRequest): { who: Who; load: CanaryLoad } | null {
  const opening = CANARY_LOAD.exec(request.userTexts[0] ?? '');
  const match = opening ?? CANARY_LOAD.exec([request.system, ...request.userTexts].join('\n'));

  if (match === null) return null;

  return {
    who: match[1] === 'helper' || match[1] === 'node' ? match[1] : 'root',
    load: {
      steps: Number(match[2]), sleepSeconds: Number(match[3]), jobs: Number(match[4]),
      jobSleepSeconds: Number(match[5]), helperSteps: Number(match[6]),
    },
  };
}

/** The canary's turns, or null for a request that is not the canary's. */
export function canaryScript(request: ScriptedRequest): ScriptedAnswer | null {
  const found = loadOf(request);

  if (found === null) return null;
  const { who, load } = found;
  // Every call of the conversation, not the turn's: a background result that wakes the root arrives as a new
  // ask, and counting only the turn restarts the script at its first call on every wake.
  const made = request.calls.length;

  if (who !== 'root') {
    return made < load.helperSteps ? sleepStep(who, made, load.sleepSeconds) : { text: `${CANARY_PREFIX}_${who.toUpperCase()}_DONE` };
  }

  if (made === 0) return { text: 'Starting the swarm.', toolCall: { name: 'agents', arguments: { op: 'swarm', preset: 'ideate', task: loadText('node', load) } } };

  if (made === 1) return { text: 'Hiring the helper.', toolCall: { name: 'agents', arguments: { op: 'hire', lifetime: 'task', role: 'task', mission: loadText('helper', load) } } };

  const job = made - 2;

  if (job < load.jobs) return sleepStep('job', job, load.jobSleepSeconds);

  const step = made - 2 - load.jobs;

  return step < load.steps ? sleepStep('root', step, load.sleepSeconds) : { text: `${CANARY_PREFIX}_ROOT_DONE` };
}
