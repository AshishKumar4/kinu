import * as v from 'valibot';
import { USER_AI_PROXY_PATH } from '@kinu.run/core';
import { DeploymentAnswer, evalTargetVerdict, evalWorkspaceName, infraBoundary } from '@kinu.run/test-utils';
import {
  openPublicSession, resolveWebIdentity, webHeaders, type CatalogNeed, type KinuPublicSession, type PublicWebIdentity,
} from './session';
import { REVIEW_ACCOUNTS, REVIEW_KEYED_MODEL, REVIEW_MODELS, reviewLogin } from './config';
import { reviewerCatalog, REVIEWER_ROLE_ID } from './reviewer';
import type { SeedFile } from './task';
import { answered, repliesTo, settle, TurnWatch } from './workspace-completion';

type Env = Record<string, string | undefined>;

/** Where trials run and as whom: the eval-service identity on the deployment, never a person's session. */
export type EvalTarget = { readonly origin: string; readonly identity: PublicWebIdentity };

/**
 * A named workspace setting applied when a trial's workspace opens. `product` changes nothing; an
 * arm that compares a setting against the product is declared here, and its cohorts never mix
 * with another arm's.
 */
export type EvalArm = { readonly id: string; apply(session: KinuPublicSession): Promise<void> };

export const ARMS = [
  { id: 'product', apply: () => Promise.resolve() },
  // docs/EVOLUTION-REDESIGN.md §8: the reactive run's two arms.
  { id: 'learning-on', apply: (session) => session.setLearning(true) },
  { id: 'learning-off', apply: (session) => session.setLearning(false) },
] as const satisfies readonly EvalArm[];

/** The deployment and the browser-plane identity, refused before any trial when either is missing. */
export function resolveEvalTarget(env: Env): EvalTarget {
  const verdict = evalTargetVerdict(env.KINU_EVAL_ORIGIN);

  if (verdict.kind === 'refused') throw new Error(verdict.reason);
  const web = resolveWebIdentity(verdict.origin, env);

  if (web.kind === 'absent') throw new Error(web.remedy);

  return { origin: verdict.origin, identity: web.identity };
}

const HealthSchema = v.object({
  build: v.object({ sha: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/)) }),
});

/** What the deployment serves now, the product a trial measures: the build's sha. */
export interface Served {
  readonly sha: string;
}

export function deployedBuild(target: EvalTarget): Promise<Served> {
  return infraBoundary(`GET ${target.origin}/api/health`, async () => {
    const response = await fetch(`${target.origin}/api/health`);

    if (!response.ok) throw new DeploymentAnswer(`/api/health answered ${String(response.status)}`, response.status);
    const health = v.parse(HealthSchema, await response.json());

    return { sha: health.build.sha };
  });
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
    llm: { name: 'eval', baseURL: `${target.origin}${USER_AI_PROXY_PATH}`, headers: {}, model: request.model },
    ...(request.role !== undefined && { role: request.role }),
    ...(request.catalog !== undefined && { catalog: request.catalog }),
  });
}

const ModelsSchema = v.object({ models: v.array(v.object({ spec: v.string() })) });

const CredentialsSchema = v.array(v.looseObject({ key: v.string() }));

/** One read the eval identity makes of its deployment's user surface, parsed by `schema`. */
async function userRead<Schema extends v.GenericSchema>(target: EvalTarget, path: string, schema: Schema): Promise<v.InferOutput<Schema>> {
  const response = await fetch(`${target.origin}${path}`, { headers: webHeaders(target.identity) });

  if (!response.ok) throw new DeploymentAnswer(`${path} answered ${String(response.status)}`, response.status);

  return v.parse(schema, await response.json());
}

/**
 * The reviewer's models the deployment serves the eval identity, first choice first (`REVIEW_MODELS`): a ChatGPT login
 * by its credential being held, the key's model by its listing, so a review runs on the next when one is missing. None
 * served fails the review, naming what would serve one.
 */
export function reviewerModels(target: EvalTarget): Promise<[string, ...string[]]> {
  return infraBoundary(`GET ${target.origin}/api/user/models`, async () => {
    const [{ models }, credentials] = await Promise.all([
      userRead(target, '/api/user/models', ModelsSchema), userRead(target, '/api/user/credentials', CredentialsSchema),
    ]);

    const held = new Set(credentials.map((credential) => credential.key));
    const logins = REVIEW_ACCOUNTS.map(reviewLogin).filter((login) => held.has(login.key)).map((login) => login.spec);
    const [first, ...rest] = [...logins, ...models.map((model) => model.spec).filter((spec) => spec === REVIEW_KEYED_MODEL)];

    if (first === undefined) {
      throw new Error(`${target.origin} serves none of the reviewer's models (${REVIEW_MODELS.join(', ')}) to the eval identity: `
        + `sign it in (bun evals/scripts/reviewer-sign-in.ts ${target.origin}) or store its keys (bun scripts/eval-provider-keys.ts ${target.origin})`);
    }

    return [first, ...rest];
  });
}

/**
 * One question put to a model in a fresh eval workspace of its own: `files` written into it, `prompt` sent in Plan, the
 * workspace waited out, and its last reply, trimmed. The workspace is deleted whatever happened. The diagnosis, the
 * trajectory review and the judge ask through it, and read what they are given as untrusted, so the workspace is the
 * reviewer's role (`REVIEWER_ROLE`): the product itself offers the turn the file tool alone, and Plan refuses its writes.
 * A trajectory that tells its reader to write, run, fetch or remember something is refused by the turn, not the prompt.
 * It runs on `model` when one is named, else on the first of the reviewer's models listed, falling back to the rest.
 */
export async function askOnce(target: EvalTarget, request: {
  subject: string; mission: string; model?: string | undefined; files: readonly SeedFile[]; prompt: string;
}): Promise<string> {
  const [model, ...fallbacks] = request.model === undefined ? await reviewerModels(target) : [request.model];
  const session = await openWorkspace(target, { ...request, model, role: REVIEWER_ROLE_ID, catalog: [reviewerCatalog(model, fallbacks)] });

  try {
    for (const file of request.files) await session.writeFile(file.path, file.content);

    const watch = new TurnWatch(session);

    await answered(watch, session.prompt(request.prompt, 'plan'));
    await settle(watch);

    return repliesTo(await session.history(), request.prompt).at(-1)?.trim() ?? '';
  } finally {
    await session.teardown();
  }
}
