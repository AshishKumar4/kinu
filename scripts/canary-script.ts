/**
 * The durability canary's scripted model (`scripts/durability-canary.ts`). The canary asks for a long turn with no
 * client connected, and each step is a shell call that sleeps and then prints its own marker. So the run ledger
 * answers everything the canary counts: a marker printed twice is a step bought twice; a marker never printed is a
 * step lost. The root also hires one task helper and starts one swarm, whose own steps sleep the same way, so every
 * kind of turn is exposed to the same hours.
 *
 * The ask names its own load, so the model stays a pure function of the request, as every tier model is.
 */
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

export const CANARY_PREFIX = 'KINU_CANARY';

export interface CanaryLoad {
  /** Sleeping steps the root turn takes after it has hired and swarmed. */
  readonly steps: number;
  /** Sleeping steps the hired helper and each swarm node take. */
  readonly helperSteps: number;
  readonly sleepSeconds: number;
}

/** `KINU_CANARY root steps=240 helper=30 sleep=55`: the ask, and a helper's or a node's mission, carry the load it asks for. */
export function canaryAsk(load: CanaryLoad): string {
  return `${CANARY_PREFIX} root steps=${String(load.steps)} helper=${String(load.helperSteps)} sleep=${String(load.sleepSeconds)}`;
}

export function canaryMarker(who: 'root' | 'helper' | 'node', step: number): string {
  return `${CANARY_PREFIX}_${who.toUpperCase()}_STEP_${String(step)}`;
}

const CANARY_LOAD = /KINU_CANARY (root|helper|node) steps=(\d+) helper=(\d+) sleep=(\d+)/;

function sleepStep(who: 'root' | 'helper' | 'node', step: number, sleepSeconds: number): ScriptedAnswer {
  return {
    text: `Step ${String(step)}.`,
    toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: `sleep ${String(sleepSeconds)}; echo ${canaryMarker(who, step)}` } },
  };
}

/** The canary's turns, or null for a request that is not the canary's. */
export function canaryScript(request: ScriptedRequest): ScriptedAnswer | null {
  const context = [request.system, ...request.userTexts].join('\n');
  const match = CANARY_LOAD.exec(context);

  if (match === null) return null;
  const who = match[1] === 'helper' || match[1] === 'node' ? match[1] : 'root';
  const steps = Number(match[2]);
  const helperSteps = Number(match[3]);
  const sleepSeconds = Number(match[4]);
  const made = request.turn.length;

  if (who !== 'root') {
    return made < helperSteps ? sleepStep(who, made, sleepSeconds) : { text: `${CANARY_PREFIX}_${who.toUpperCase()}_DONE` };
  }

  const mission = (kind: 'helper' | 'node') => `KINU_CANARY ${kind} steps=${String(helperSteps)} helper=${String(helperSteps)} sleep=${String(sleepSeconds)}`;

  if (made === 0) return { text: 'Starting the swarm.', toolCall: { name: 'agents', arguments: { action: 'swarm', preset: 'ideate', task: mission('node') } } };

  if (made === 1) return { text: 'Hiring the helper.', toolCall: { name: 'agents', arguments: { action: 'hire', lifetime: 'task', role: 'task', mission: mission('helper') } } };

  const step = made - 2;

  return step < steps ? sleepStep('root', step, sleepSeconds) : { text: `${CANARY_PREFIX}_ROOT_DONE` };
}
