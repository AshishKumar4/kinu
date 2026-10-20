// What the page shows of a run (docs/SELF-DEPLOY-FLOW.md § The page's contract): the ledger's steps folded into seven
// phases in plain words, and one state. Built from the ledger and what the run holds; it holds no secret.
import * as v from 'valibot';
import { FACT_ADDRESS } from './context';
import {
  DeployNeedSchema, DeployRefusalSchema, SIGN_IN_AGAIN_NEED, failureWords, judgeRefusal,
  type DeployNeed, type DeployRefusal,
} from './refusals';
import { factsFrom, type DeployStepRow } from './runner';
import type { DeployRunPhase } from './frames';

export type DeployPhaseId = 'prepare' | 'storage' | 'upload' | 'address' | 'mail' | 'check' | 'live';

/** In the order a run passes through them. */
const PHASE_ORDER: readonly DeployPhaseId[] = ['prepare', 'storage', 'upload', 'address', 'mail', 'check', 'live'];

const PHASE_WORDS: Record<DeployPhaseId, string> = {
  prepare: 'Preparing your account',
  storage: 'Creating storage',
  upload: 'Uploading Kinu',
  address: 'Putting it on your address',
  mail: 'Setting up mail',
  check: 'Checking it answers',
  live: 'Going live',
};

/**
 * Each ledger step's phase. A step not named here sits in the phase of the step before it, so a new step is one line
 * here, or none.
 */
const STEP_PHASES = {
  account: 'prepare',
  'computer-token': 'prepare',
  kv: 'storage',
  r2: 'storage',
  vectorize: 'storage',
  'ai-gateway': 'storage',
  seed: 'storage',
  'computer-tools': 'storage',
  secrets: 'upload',
  upload: 'upload',
  computer: 'upload',
  address: 'address',
  mail: 'mail',
  smoke: 'check',
  promote: 'live',
  handover: 'live',
} satisfies Record<string, DeployPhaseId>;

const STEP_PHASE = new Map<string, DeployPhaseId>(Object.entries(STEP_PHASES));

export type DeployPhaseState = 'done' | 'running' | 'waiting' | 'refused';

export type DeployRunViewState = 'running' | 'paused' | 'refused' | 'live';

export interface DeployPhase {
  readonly id: DeployPhaseId;
  readonly words: string;
  readonly state: DeployPhaseState;
  /** Said by the run in this phase, as when it took the next free name. */
  readonly note?: string;
}

export interface DeployLive {
  readonly url: string;
  /** Empty once the link lapsed, or for a change that kept the one it had. */
  readonly setupLink: string;
  readonly setupLinkExpiresAt: number;
  readonly cli: string;
  /** A domain registered elsewhere: the nameservers to set, until its zone is active and the run moved onto it. */
  /** A domain still on its way: its nameservers, and whether it points at them now and waits on a sign-in to move. */
  readonly pending?: { readonly domain: string; readonly nameservers: readonly string[]; readonly ready: boolean };
}

export interface DeployRunView {
  readonly runId: string;
  readonly account: string;
  readonly state: DeployRunViewState;
  readonly phase: { readonly id: DeployPhaseId; readonly index: number; readonly of: number; readonly words: string };
  readonly phases: readonly DeployPhase[];
  readonly paused?: DeployNeed;
  readonly refused?: DeployRefusal;
  readonly live?: DeployLive;
}

const PhaseIdSchema = v.picklist(['prepare', 'storage', 'upload', 'address', 'mail', 'check', 'live']);

export const DeployRunViewSchema: v.GenericSchema<DeployRunView> = v.object({
  runId: v.string(),
  account: v.string(),
  state: v.picklist(['running', 'paused', 'refused', 'live']),
  phase: v.object({ id: PhaseIdSchema, index: v.number(), of: v.number(), words: v.string() }),
  phases: v.array(v.object({
    id: PhaseIdSchema, words: v.string(), state: v.picklist(['done', 'running', 'waiting', 'refused']), note: v.optional(v.string()),
  })),
  paused: v.optional(DeployNeedSchema),
  refused: v.optional(DeployRefusalSchema),
  live: v.optional(v.object({
    url: v.string(),
    setupLink: v.string(),
    setupLinkExpiresAt: v.number(),
    cli: v.string(),
    pending: v.optional(v.object({ domain: v.string(), nameservers: v.array(v.string()), ready: v.boolean() })),
  })),
});

/** The page's frame: sent beside each snapshot, so a reader that knows only `DeployFrameSchema` skips it. */
export const DeployRunFrameSchema = v.object({ type: v.literal('deploy.run'), run: DeployRunViewSchema });

export type DeployRunFrame = v.InferOutput<typeof DeployRunFrameSchema>;

/** What the run holds that the view reads, besides its ledger. */
export interface DeployRunStanding {
  readonly runId: string;
  readonly account: string;
  readonly rows: readonly DeployStepRow[];
  readonly state: DeployRunPhase;
  /** The deployment has mail, so the mail phase applies. */
  readonly mail: boolean;
  /** The prerequisite the run is paused on, and the step it stopped at. */
  readonly paused: DeployNeed | null;
  /** The run holds no grant: whatever it stopped on, signing in again comes first. */
  readonly signedOut: boolean;
  readonly seat: { readonly link: string; readonly expiresAt: number } | null;
  readonly pending: { readonly domain: string; readonly nameservers: readonly string[]; readonly ready: boolean } | null;
  /** The prepare phase's note: the name the run took when the asked one was gone. */
  readonly note: string;
  readonly now: number;
}

export function deployRunView(standing: DeployRunStanding): DeployRunView {
  const verdict = verdictOf(standing);
  const phases = phaseStates(standing, 'refused' in verdict);
  const unfinished = phases.findIndex((phase) => phase.state !== 'done');
  // Every phase done: the run is in its last, live.
  const at = unfinished === -1 ? phases.length - 1 : unfinished;
  const id = phases[at]?.id ?? 'prepare';

  return {
    runId: standing.runId,
    account: standing.account,
    phase: { id, index: at + 1, of: phases.length, words: PHASE_WORDS[id] },
    phases,
    ...verdict,
  };
}

type Verdict = Pick<DeployRunView, 'state' | 'paused' | 'refused' | 'live'>;

/** Live once every step is done; signed out before anything else, since nothing moves without a grant; then the
 *  prerequisite it paused on, or the refusal it stopped on, in the catalog's words. */
function verdictOf(standing: DeployRunStanding): Verdict {
  const failed = standing.rows.find((row) => row.state === 'failed');

  if (standing.state === 'done' && failed === undefined) return { state: 'live', live: liveOf(standing) };

  if (standing.signedOut || standing.state === 'expired') {
    return { state: 'paused', paused: standing.paused?.id === 'signin-again' ? standing.paused : SIGN_IN_AGAIN_NEED };
  }

  if (standing.paused !== null) return { state: 'paused', paused: standing.paused };

  if (failed === undefined || failed.failure === null || standing.state === 'running') return { state: 'running' };
  const judged = judgeRefusal(failureWords(failed.failure), standing.account);

  return 'need' in judged ? { state: 'paused', paused: judged.need } : { state: 'refused', refused: judged.refused };
}

/** Phases in their fixed order; one with no step yet waits, and mail is left out when the deployment has none. A
 *  paused phase is still running: the run is in it, asking again. */
function phaseStates(standing: DeployRunStanding, refused: boolean): DeployPhase[] {
  const byPhase = new Map<DeployPhaseId, DeployStepRow[]>();
  let previous: DeployPhaseId = 'prepare';

  for (const row of standing.rows) {
    const phase: DeployPhaseId = STEP_PHASE.get(row.id) ?? previous;

    byPhase.set(phase, [...byPhase.get(phase) ?? [], row]);
    previous = phase;
  }

  const shown = PHASE_ORDER.filter((phase) => phase !== 'mail' || standing.mail);
  const started = standing.rows.length > 0 || standing.state === 'running';

  return shown.map((id, index): DeployPhase => {
    const state = phaseState(byPhase.get(id) ?? [], refused);
    const entry = { id, words: PHASE_WORDS[id] };
    const first = index === 0 && started && state === 'waiting' ? 'running' : state;

    return id === 'prepare' && standing.note !== '' ? { ...entry, state: first, note: standing.note } : { ...entry, state: first };
  });
}

function phaseState(rows: readonly DeployStepRow[], refused: boolean): DeployPhaseState {
  if (rows.length === 0) return 'waiting';

  if (rows.every((row) => row.state === 'done')) return 'done';

  if (refused && rows.some((row) => row.state === 'failed')) return 'refused';

  return rows.some((row) => row.state !== 'pending') ? 'running' : 'waiting';
}

function liveOf(standing: DeployRunStanding): DeployLive {
  const address = factsFrom(standing.rows).get(FACT_ADDRESS) ?? '';
  const origin = `https://${address}`;
  const seat = standing.seat !== null && standing.seat.expiresAt > standing.now ? standing.seat : null;

  const live: DeployLive = {
    url: origin,
    setupLink: seat?.link ?? '',
    setupLinkExpiresAt: seat?.expiresAt ?? 0,
    cli: `curl -fsSL ${origin}/install.sh | bash`,
  };

  return standing.pending === null ? live : { ...live, pending: standing.pending };
}
