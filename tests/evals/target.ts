/**
 * WHICH target a suite runs on — one knob, one resolution, one printed line.
 *
 * A suite calls {@link resolveEvalTarget} once at module scope, gates its live
 * tests on the result, and provisions per case. It never reads a credential to
 * decide where it is, and it never branches on `backend` to decide what to
 * assert: an assertion that holds on one target and not the other says so
 * inline, with its reason, through {@link platformSpecific}.
 *
 * SKIPS PRINT REMEDIES, always. A skip that says nothing is the false green the
 * whole live tier was rebuilt to remove, and "cloud evals are unavailable" is not
 * a remedy. Every branch below names the command or the variable that would make
 * the run happen.
 *
 * CLOUD IS NEVER AMBIENT. It requires `KINU_EVAL_BACKEND=cloud` — an explicit
 * choice — on top of everything `liveModelTarget` already requires
 * (`KINU_EVAL_LIVE=1`, set by `scripts/eval-tier.sh` and by nothing else). So no
 * gate tier can reach it by accident, and a developer with a credential in their
 * shell cannot make a commit hook create workspaces on a shared deployment.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';

import type { LLMProviderConfig } from '../../packages/core/src/index';
import {
  EVAL_BACKEND_ENV, evalNameSlug, liveChatModel, liveModelTarget, resolveEvalBackend, workerSession,
  type AgentEvalTarget, type EvalBackend, type LiveModelTarget,
} from '@kinu.run/test-utils';
import { provisionLocalTarget } from './target-local';
import { provisionCloudTarget } from './target-cloud';

/** What one case needs to become a provisioned target. Deliberately small: a
 *  suite says what the workspace is FOR and the resolution supplies everything
 *  that is a property of the target rather than of the case. */
export interface EvalCaseRequest {
  /** Distinguishes this case's workspace from its siblings'. Folded into the
   *  local directory name and into the cloud `eval-` name. */
  readonly subject: string;
  readonly purpose: string;
  /** The arm's evolution setting. Local only — a deployed workspace's evolution
   *  is its own durable config, which is a declared platform difference. */
  readonly evolution: boolean;
}

/**
 * A resolved target factory, plus everything a run record has to state about
 * where it went.
 *
 * `provision` rather than a target, because a suite runs many cases and each
 * needs its own workspace: one workspace reused across cases would let case N's
 * ledger rows be read as case N+1's, which is the zero-denominator error in
 * reverse.
 */
export interface EvalTargetPlan {
  readonly backend: EvalBackend;
  /** The line a suite prints before it spends. */
  readonly describe: string;
  readonly llm: LLMProviderConfig;
  /** The AI SDK model, for suites that also drive a model directly. */
  readonly model: LanguageModel;
  provision(request: EvalCaseRequest): Promise<AgentEvalTarget>;
}

/**
 * The plan for `suite` on `model`, or null when the environment legitimately has
 * none.
 *
 * `model` rather than a whole `LLMProviderConfig`, because the CREDENTIAL is the
 * environment's and the MODEL ID is the arm's. A suite that resolved a target
 * itself to build a config would call `liveModelTarget` twice and print its
 * banner twice, and two resolutions is one more than the docstring above
 * promises. So the resolution happens here, once, and every suite reads
 * `plan.llm` back off the plan — which is also what stops a run recording a
 * model id its own config did not carry.
 *
 * Throws only on a REFUSAL — a backend name that is neither target, or a cloud
 * arm whose credential fronts a model instead of a deployment. Someone meant
 * those to run and where they would have gone is the thing to say out loud.
 */
export function resolveEvalTarget(suite: string, model: string): EvalTargetPlan | null {
  const backend = resolveEvalBackend();
  if (backend.kind === 'refused') throw new Error(`${suite}: ${backend.reason}`);

  const target = liveModelTarget(suite);
  if (target === null) return null;

  const llm: LLMProviderConfig = { ...target.llm, model };
  if (backend.backend === 'local') return localPlan(suite, target, llm);
  return cloudPlan(suite, target, llm);
}

/**
 * The local plan: one scratch directory per CASE, named for the suite that made
 * it.
 *
 * NO INTERMEDIATE ROOT. A per-plan `kinu-eval-local-<stamp>` directory with each
 * case provisioned inside it left that root behind on every suite run, because
 * `teardown` owns the case's directory and nothing owned the parent — a leak in
 * the module whose cloud half is built around "a run that throws must not leave a
 * row". Each case's directory is now a sibling in tmpdir, so the thing that
 * created it is the thing that removes it.
 *
 * THE NAME CARRIES THE SUITE. Every case used to be `behaviour-<subject>`
 * whatever resolved the plan, so a swarm or research case would carry a
 * behaviour-arm name in its own store and in the banner a reader attributes rows
 * from. The stamp keeps two runs of one suite from colliding in tmpdir.
 */
function localPlan(suite: string, target: LiveModelTarget, llm: LLMProviderConfig): EvalTargetPlan {
  const model = liveChatModel(llm);
  const run = `${evalNameSlug(suite)}-${Date.now().toString(36)}`;
  return {
    backend: 'local',
    describe: `local cli-backend runtime · ${target.describe}`,
    llm,
    model,
    provision: (request) => {
      const name = `${run}-${evalNameSlug(request.subject)}`;
      return provisionLocalTarget({
        dir: join(tmpdir(), `kinu-eval-${name}`),
        workspace: name,
        purpose: request.purpose,
        llm,
        model,
        evolution: request.evolution,
      });
    },
  };
}

/**
 * The cloud plan, or a refusal that names the reason.
 *
 * `workerSession` is what decides reachability, and it decides it from the
 * TARGET rather than from the environment: a worker-proxy target carries the
 * deployment's own API origin in its base URL, and an AI-gateway target does not
 * carry one at all. So "can this arm create a workspace" is answered by the same
 * value the tier's banner printed, and the two can never disagree about which
 * deployment a run touched.
 *
 * The workspace name carries the SUITE as well as the case, for the reason the
 * local plan's does: a survivor on the account has to say what made it, and
 * `eval-<case>` alone does not.
 */
function cloudPlan(suite: string, target: LiveModelTarget, llm: LLMProviderConfig): EvalTargetPlan {
  if (target.via !== 'worker-proxy') {
    throw new Error(`${suite}: ${EVAL_BACKEND_ENV}=cloud needs a credential for a Kinu `
      + `deployment, and this run resolved a bare model endpoint (${target.via}). An AI Gateway `
      + 'fronts a model and no deployment, so there is no workspace API to create against. '
      + 'Mint an eval-service credential instead: `kinu auth --origin https://staging.kinu.run` '
      + 'then `kinu tokens create --name evals --scopes ai.proxy`, and export it as '
      + 'KINU_EVAL_TOKEN.');
  }
  const session = workerSession(llm);
  const model = liveChatModel(llm);
  const suiteSlug = evalNameSlug(suite);
  return {
    backend: 'cloud',
    describe: `cloud staging · ${session.origin} · ${target.describe}`,
    llm,
    model,
    provision: (request) => provisionCloudTarget({
      origin: session.origin,
      token: session.token,
      subject: `${suiteSlug}-${request.subject}`,
      purpose: request.purpose,
      llm,
    }),
  };
}

/**
 * Declare that an assertion is a statement about ONE platform, with its reason.
 *
 * WHY A HELPER RATHER THAN AN `if`. A bare `if (plan.backend === 'local')` around
 * an expectation is indistinguishable from an assertion somebody quietly turned
 * off for the arm it kept failing on — which is how a suite ends up green on both
 * targets while measuring neither. This makes the declaration a value: the reason
 * is required, and a skipped assertion PRINTS that it was skipped and why. A
 * reader of the log sees the same sentence whichever arm ran.
 *
 * Use it only where the difference is genuinely the platform's. A step cap, a
 * verifier that cannot run, a spend window a suite cannot widen — those are
 * findings, and a finding belongs in an assertion that fails, not behind this.
 */
export function platformSpecific(
  plan: EvalTargetPlan,
  only: EvalBackend,
  reason: string,
  assert: () => void,
): void {
  if (plan.backend === only) {
    assert();
    return;
  }
  console.warn(`[platform] skipped a ${only}-only assertion on the ${plan.backend} arm — ${reason}`);
}
