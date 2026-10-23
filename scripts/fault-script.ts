/**
 * The scripted model's group-reset workload: a root agent and the task agent it hires each take shell steps that append
 * their own marker to a shared file, the root writes a file a step, and at `burn` the root's program starts a resident
 * process that spends CPU in 0.42 s event-loop turns (2e7 rounds of the probe's spin). Such a loader facet is reset by
 * the platform, and the reset takes its workspace object and every agent facet with it (advisor-session MEASUREMENTS.md
 * §7, 2026-10-23). A marker the file holds twice is an effect bought twice; one the ledger acknowledged and the file
 * lacks is one lost.
 */
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

const FAULT_PREFIX = 'KINU_FAULT';

/** Where every step's effect is appended: the workspace's shared directory, which every agent writes. */
const FAULT_EFFECTS = '/scratch/fault-effects.log';

interface FaultLoad {
  readonly steps: number;
  readonly sleepSeconds: number;
  /** The root's step whose program starts the burn. */
  readonly burn: number;
  /** The burn's event-loop turns. */
  readonly slices: number;
}

const FAULT_LOAD = /KINU_FAULT (root|agent) steps=(\d+) sleep=(\d+) burn=(\d+) slices=(\d+)/;

function faultAsk(who: 'root' | 'agent', load: FaultLoad): string {
  return `${FAULT_PREFIX} ${who} steps=${String(load.steps)} sleep=${String(load.sleepSeconds)} burn=${String(load.burn)} slices=${String(load.slices)}`;
}

function faultMarker(who: 'root' | 'agent', step: number): string {
  return `${FAULT_PREFIX}_${who.toUpperCase()}_STEP_${String(step)}`;
}

/** The burn as a `node -e` program: each turn spins, then yields to the next. */
function burnCommand(slices: number): string {
  return `node -e "const spin=(n)=>{let x=7;for(let i=0;i<n;i++)x=(x*48271)%2147483647;return x};let s=0;`
    + `const t=()=>{spin(2e7);s++;if(s<${String(slices)})setTimeout(t,0)};t()"`;
}

/**
 * The workload's turns, or null for a request that is not its own. As an agent told a call was interrupted would: a step
 * is done once a result acknowledged it (its marker in the result), the next step is the first one not done, and one
 * whose call was interrupted is issued again only after checking it did not take effect, so no effect lands twice.
 */
export function faultScript(request: ScriptedRequest): ScriptedAnswer | null {
  const match = FAULT_LOAD.exec(request.userTexts[0] ?? '');

  if (match === null) return null;
  const who = match[1] === 'agent' ? 'agent' : 'root';
  const load: FaultLoad = { steps: Number(match[2]), sleepSeconds: Number(match[3]), burn: Number(match[4]), slices: Number(match[5]) };

  if (who === 'root' && !request.calls.some((call) => call.name === 'agents')) {
    return { text: 'Hiring the agent.', toolCall: { name: 'agents', arguments: { op: 'hire', lifetime: 'task', role: 'task', message: faultAsk('agent', load) } } };
  }

  const names = (step: number) => new RegExp(`${faultMarker(who, step)}\\b`, 'u');
  const tries = (step: number) => request.calls.filter((call) => names(step).test(call.arguments)).length;

  // The burn is started once, whatever became of its call: it marks nothing. A step tried three times is given up, which
  // the effects then show.
  const done = (step: number) => (who === 'root' && step === load.burn
    ? request.calls.some((call) => call.name === 'eval')
    : request.calls.some((call) => names(step).test(call.result)) || tries(step) >= 3);

  const step = Array.from({ length: load.steps }, (_, at) => at).find((at) => !done(at));

  if (step === undefined) return { text: `${FAULT_PREFIX}_${who.toUpperCase()}_DONE` };

  if (who === 'root' && step === load.burn) {
    return { text: 'Starting the burn.', toolCall: { name: 'eval', arguments: {
      code: `// Starts the slice burn as a resident process.\nreturn await workspace.startProcess(${JSON.stringify(burnCommand(load.slices))});`,
    } } };
  }

  const marker = faultMarker(who, step);
  const again = tries(step) > 0;

  // The root writes a file on its odd steps, which a second write leaves as it was.
  if (who === 'root' && step % 2 === 1) {
    return { text: `Step ${String(step)}.`, toolCall: { name: 'file', arguments: { op: 'write', path: `/scratch/fault/${marker}.md`, content: marker } } };
  }

  // An interrupted append is checked for before it is made again.
  const append = again ? `grep -qx ${marker} ${FAULT_EFFECTS} 2>/dev/null || echo ${marker} >> ${FAULT_EFFECTS}` : `echo ${marker} >> ${FAULT_EFFECTS}`;

  return { text: again ? `Step ${String(step)} again: it was interrupted.` : `Step ${String(step)}.`, toolCall: { name: 'shell', arguments: {
    runtime: 'workspace', command: `sleep ${String(load.sleepSeconds)}; ${append}; echo ${marker}`,
  } } };
}
