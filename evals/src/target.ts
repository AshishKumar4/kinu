import * as v from 'valibot';
import { USER_AI_PROXY_PATH, type RunEvent } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { DeploymentAnswer, evalTargetVerdict, evalWorkspaceName, infraBoundary } from '@kinu.run/test-utils';
import { servedHealth } from '../../scripts/served-health';
import { openPublicSession, type KinuPublicSession } from './session';
import type { CatalogNeed } from './workspace-roster';
import { resolveWebIdentity, webHeaders, type EvalTarget } from './workspace-roster';
import { REVIEW_LOGIN } from './config';
import { reviewerCatalog, REVIEWER_ROLE_ID } from './reviewer';
import { claimTrialAccount } from './slot';
import type { SeedFile } from './task';
import { answered, repliesTo, settle, TurnWatch } from './workspace-completion';

type Env = Record<string, string | undefined>;



/**
 * A named workspace setting applied when a trial's workspace opens. `product` changes nothing; an
 * arm that compares a setting against the product is declared here, and its cohorts never mix
 * with another arm's.
 */
export type EvalArm = { readonly id: string; apply(session: KinuPublicSession): Promise<void> };

export const ARMS = [
  { id: 'product', apply: () => Promise.resolve() },
  // docs/EVOLUTION-REDESIGN.md §8: the reactive run's arms. `crafting-off` learns, and crafts nothing.
  { id: 'learning-on', apply: (session) => session.setLearning(true) },
  { id: 'learning-off', apply: (session) => session.setLearning(false) },
  { id: 'crafting-off', apply: async (session) => { await session.setLearning(true); await session.setCrafting(false); } },
] as const satisfies readonly EvalArm[];

/** The deployment and the browser-plane identity, refused before any trial when either is missing. */
export function resolveEvalTarget(env: Env): EvalTarget {
  const verdict = evalTargetVerdict(env.KINU_EVAL_ORIGIN);

  if (verdict.kind === 'refused') throw new Error(verdict.reason);
  const web = resolveWebIdentity(verdict.origin, env);

  if (web.kind === 'absent') throw new Error(web.remedy);

  return { origin: verdict.origin, identity: web.identity };
}

/** What the deployment serves now, the product a trial measures: the build's sha. */
export interface Served {
  readonly sha: string;
  /** The Worker version that answered, or null where the deployment names none (a loopback one). */
  readonly version: string | null;
}

export function deployedBuild(target: Pick<EvalTarget, 'origin'>): Promise<Served> {
  return infraBoundary(`GET ${target.origin}/api/health`, async () => {
    const { status, build, workerVersion } = await servedHealth(target.origin);

    if (build === undefined || build === null) throw new DeploymentAnswer(`/api/health answered ${String(status)} with no build stamp`, status);

    return { sha: build.sha, version: workerVersion };
  });
}

/**
 * What changed under a trial between its start and its end, or null: a new build, or a new Worker version of the same
 * build (a secret change makes one). Either restarts every Durable Object, so the trial measured the deployment, not
 * the model or the product, and it is recorded as infrastructure (`EvalBuildChanged`, task.ts HARNESS_ERRORS).
 */
export function buildChanged(before: Served, after: Served): string | null {
  if (after.sha !== before.sha) return `the deployment served ${before.sha.slice(0, 12)} then ${after.sha.slice(0, 12)} during the trial`;

  if (before.version === null || after.version === null || before.version === after.version) return null;

  return `the deployment's Worker changed version during the trial, ${before.version.slice(0, 8)} then ${after.version.slice(0, 8)}, on build `
    + `${before.sha.slice(0, 12)}: a new version restarts every Durable Object, so this trial measured the deployment, not the model or the product`;
}

/**
 * A fresh eval-prefixed workspace on `model`, its mission written before the first prompt so no
 * genesis turn runs. The caller tears it down.
 */
export function openWorkspace(target: EvalTarget, request: {
  subject: string; mission: string; model: string; role?: string; catalog?: readonly CatalogNeed[];
}): Promise<KinuPublicSession> {
  return openPublicSession({
    origin: target.origin,
    identity: target.identity,
    workspace: evalWorkspaceName(request.subject),
    purpose: request.mission,
    genesis: false,
    ...(target.identity.account?.startsWith('trial-') && {
      claim: (workspace: string) => claimTrialAccount(target, workspace, Date.now()),
    }),
    llm: { name: 'eval', baseURL: `${target.origin}${USER_AI_PROXY_PATH}`, headers: {}, model: request.model },
    ...(request.role !== undefined && { role: request.role }),
    ...(request.catalog !== undefined && { catalog: request.catalog }),
  });
}

const CredentialsSchema = v.array(v.looseObject({ key: v.string() }));

/** One read the eval identity makes of its deployment's user surface, parsed by `schema`. */
async function userRead<Schema extends v.GenericSchema>(target: EvalTarget, path: string, schema: Schema): Promise<v.InferOutput<Schema>> {
  const response = await fetch(`${target.origin}${path}`, { headers: webHeaders(target.identity) });

  if (!response.ok) throw new DeploymentAnswer(`${path} answered ${String(response.status)}`, response.status);

  return v.parse(schema, await response.json());
}

/** The reviewer's model once the deployment holds its login for the eval identity; without it the review fails, naming the sign-in. */
export function reviewerModel(target: EvalTarget): Promise<string> {
  return infraBoundary(`GET ${target.origin}/api/user/credentials`, async () => {
    const credentials = await userRead(target, '/api/user/credentials', CredentialsSchema);

    if (!credentials.some((credential) => credential.key === REVIEW_LOGIN.key)) {
      throw new Error(`${target.origin} holds no ChatGPT login ${REVIEW_LOGIN.account} for the eval identity, so ${REVIEW_LOGIN.spec} cannot review: `
        + `sign it in (bun evals/scripts/reviewer-sign-in.ts ${target.origin})`);
    }

    return REVIEW_LOGIN.spec;
  });
}

/**
 * One question put to a model in a fresh eval workspace of its own: `files` written into it, `prompt` sent in Plan, the
 * workspace waited out, and its last reply, trimmed. The workspace is deleted whatever happened. The diagnosis, the
 * trajectory review and the judge ask through it, and read what they are given as untrusted, so the workspace is the
 * reviewer's role (`REVIEWER_ROLE`): the product itself offers the turn the file tool alone, and Plan refuses its writes.
 * A trajectory that tells its reader to write, run, fetch or remember something is refused by the turn, not the prompt.
 * It runs on `model` when one is named, else on the reviewer's, and on nothing else.
 */
export async function askOnce(target: EvalTarget, request: {
  subject: string; mission: string; model?: string | undefined; files: readonly SeedFile[]; prompt: string;
}): Promise<string> {
  const model = request.model ?? await reviewerModel(target);
  const session = await openWorkspace(target, { ...request, model, role: REVIEWER_ROLE_ID, catalog: [reviewerCatalog(model)] });

  try {
    for (const file of request.files) await session.writeFile(file.path, file.content);

    const watch = new TurnWatch(session);

    const result = await answered(watch, session.prompt(request.prompt, 'plan'));
    let terminal: Extract<RunEvent, { type: 'run_end' }> | undefined;

    await settle(watch, (_busy, events) => {
      terminal = events.filter((event): event is Extract<RunEvent, { type: 'run_end' }> => event.type === 'run_end').at(-1);
    });

    if ((result.landed === 'turn' && result.hadError) || terminal?.error !== undefined
      || (terminal?.reason !== undefined && terminal.reason !== 'completed')) {
      throw new KinuError('unavailable', terminal?.error ?? `The reviewer turn ended ${terminal?.reason ?? 'in error'} without a recorded cause.`);
    }

    const reply = repliesTo(await session.history(), request.prompt).at(-1)?.text.trim();

    if (reply === undefined || reply === '') throw new KinuError('unavailable', 'The reviewer finished without an answer to its prompt.');

    return reply;
  } finally {
    await session.teardown();
  }
}
