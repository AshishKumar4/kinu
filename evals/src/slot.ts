// Every trial of an eval run acts as an account of its own (core `parseEvalAccount`), so no trial reaches another:
// peers, messages, spawned workspaces, swarm publications and the experience library are all the account's. On
// 2026-10-01 trials sharing eval-service listed each other as peers and messaged each other.
//
// A trial's slot is its place in the run's whole matrix: every task file of evals/tasks, sorted, then model, arm and
// trial. Each worker process works it out alone, and two trials of a run never share one. Before a trial opens, its
// account is checked: a workspace another run marks live means the slot is taken, one a stopped run left is deleted,
// and a row the trial could inherit stops it, named. A deployment that predates trial accounts runs its trials on
// eval-service, as before, and the report says so.
import * as v from 'valibot';
import { EVAL_TRIAL_ACCOUNTS, parseEvalAccount, type EvalAccount } from '@kinu.run/core';
import { deleteWorkspace, listWorkspaces, webHeaders, WORKSPACE_LEASE_MS } from './session';
import type { EvalMatrix } from './config';
import type { EvalTarget } from './target';

/** A trial's place in its run. */
export type TrialPlace = {
  readonly taskFiles: readonly string[];
  readonly task: string;
  readonly matrix: Pick<EvalMatrix, 'models' | 'arms' | 'trials'>;
  readonly model: string;
  readonly arm: string;
  readonly trial: number;
};

/** The trial's own account, `trial-<n>`. */
export function trialSlot(place: TrialPlace): EvalAccount {
  const files = [...place.taskFiles].sort();
  const taskAt = files.indexOf(`${place.task}.eval.ts`);
  const { models, arms, trials } = place.matrix;

  if (taskAt === -1) throw new Error(`task ${place.task} is not evals/tasks/${place.task}.eval.ts, so it has no place in the run's matrix`);
  const needed = files.length * models.length * arms.length * trials;
  const slot = ((taskAt * models.length + models.indexOf(place.model)) * arms.length + arms.indexOf(place.arm)) * trials + place.trial;
  const account = parseEvalAccount(`trial-${String(slot)}`);

  if (needed > EVAL_TRIAL_ACCOUNTS || account === null) {
    throw new Error(`the run's matrix needs ${String(needed)} trial accounts, and a deployment has trial-1 to trial-${String(EVAL_TRIAL_ACCOUNTS)}`);
  }

  return account;
}

/** Every trial account a matrix uses: the ones a deploy gives the eval provider keys. */
export function trialAccounts(taskFiles: readonly string[], matrix: TrialPlace['matrix']): EvalAccount[] {
  return [...taskFiles].sort().flatMap((file) => matrix.models.flatMap((model) => matrix.arms.flatMap((arm) =>
    Array.from({ length: matrix.trials }, (_, at) => trialSlot({ taskFiles, task: file.replace(/\.eval\.ts$/u, ''), matrix, model, arm, trial: at + 1 })))));
}

/**
 * The tables a trial account may hold rows in when its trial opens: its provider keys and what keeps them (the
 * revision counters, grants a disconnect could not revoke), and the account's own bookkeeping (its profile, onboarding,
 * schema version, token generation, and the agents SDK's state row, which the account never writes). A device-status
 * watcher names the workspace that registered it, which the account keeps after the workspace is deleted until a
 * device moves: no later trial opens a workspace of that name.
 */
const KEEPS: ReadonlySet<string> = new Set([
  'user_credentials', 'user_credential_revisions', 'user_credentials_revision', 'user_unrevoked_grants',
  'user_schema_meta', 'user_profile', 'user_onboarding', 'user_auth_generation', 'cf_agents_state', 'device_status_watchers',
]);

/** Of an account's rows by table, the ones a trial would inherit from the trial before it in the slot. */
export function inheritedRows(held: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(held).filter(([table, rows]) => rows > 0 && !KEEPS.has(table)));
}

export type TrialAccounts = { readonly kind: 'trial' } | { readonly kind: 'shared'; readonly why: string };

const ProfileSchema = v.looseObject({ email: v.string() });

/** Whether `target`'s deployment makes `trial-1` a user of its own, asked of its profile route. */
export async function trialAccountsAt(target: EvalTarget): Promise<TrialAccounts> {
  const response = await fetch(`${target.origin}/api/user/profile`, { headers: webHeaders({ ...target.identity, account: 'trial-1' }) });
  const text = await response.text();

  if (response.status === 400 && text.includes('Unknown eval account')) {
    return { kind: 'shared', why: `${target.origin} refuses trial accounts, so its trials share eval-service` };
  }

  if (!response.ok) throw new Error(`asking ${target.origin} for trial-1's profile answered ${String(response.status)}: ${text.slice(0, 300)}`);
  const { email } = v.parse(ProfileSchema, JSON.parse(text));

  return email.includes('+trial-1@') ? { kind: 'trial' }
    : { kind: 'shared', why: `${target.origin} answers trial-1 as ${email}, so its trials share eval-service` };
}

/** The account a target acts as. */
function accountOf(target: EvalTarget): string {
  return target.identity.account ?? 'eval-service';
}

/** Make `target`'s trial account its trial's own before the trial opens on it. */
export async function prepareTrialAccount(target: EvalTarget, now: number): Promise<void> {
  const workspaces = await listWorkspaces(target.origin, target.identity);
  const live = workspaces.find((workspace) => now - workspace.lastVisited < WORKSPACE_LEASE_MS);

  if (live !== undefined) {
    throw new Error(`${accountOf(target)} is in use by another run: its workspace ${live.name} was marked live `
      + `${String(Math.round((now - live.lastVisited) / 1000))}s ago`);
  }

  for (const { name } of workspaces) await deleteWorkspace(target.origin, target.identity, name);
  const response = await fetch(`${target.origin}/api/user/held-rows`, { headers: webHeaders(target.identity) });
  const text = await response.text();

  if (!response.ok) throw new Error(`reading what ${accountOf(target)} holds answered ${String(response.status)}: ${text.slice(0, 300)}`);
  const inherited = Object.entries(inheritedRows(v.parse(v.record(v.string(), v.number()), JSON.parse(text))));

  if (inherited.length > 0) {
    throw new Error(`${accountOf(target)} holds rows a trial would inherit: ${inherited.map(([table, rows]) => `${table} ${String(rows)}`).join(', ')}; `
      + `the next deploy's eval provisioning resets it (bun scripts/eval-provider-keys.ts ${target.origin})`);
  }
}

/** Whether each origin's deployment has trial accounts, asked once per process. */
const asked = new Map<string, Promise<TrialAccounts>>();

/**
 * The target a trial acts through, and the account it names: the trial's own where `target`'s deployment has trial
 * accounts, made ready for it, else eval-service's, saying why.
 */
export async function trialTarget(target: EvalTarget, slot: EvalAccount, now: number): Promise<{ target: EvalTarget; account: string }> {
  let accounts = asked.get(target.origin);

  if (accounts === undefined) {
    accounts = trialAccountsAt(target);
    asked.set(target.origin, accounts);

    const answer = await accounts;

    if (answer.kind === 'shared') console.warn(`[evals] ${answer.why}: they can reach each other`);
  }

  const answer = await accounts;

  if (answer.kind === 'shared') return { target, account: `eval-service (${answer.why})` };
  const own = { ...target, identity: { ...target.identity, account: slot } };

  await prepareTrialAccount(own, now);

  return { target: own, account: slot };
}

/** After opening `own` on `target`'s account: a run that opened on it at the same moment with an earlier name keeps it. */
export async function claimTrialAccount(target: EvalTarget, own: string, now: number): Promise<void> {
  const rival = (await listWorkspaces(target.origin, target.identity))
    .find((workspace) => workspace.name < own && now - workspace.lastVisited < WORKSPACE_LEASE_MS);

  if (rival !== undefined) throw new Error(`${accountOf(target)} was opened on by another run at the same moment (${rival.name})`);
}

const ReportAccountsSchema = v.looseObject({
  testResults: v.array(v.looseObject({
    assertionResults: v.array(v.looseObject({
      meta: v.optional(v.looseObject({
        harness: v.optional(v.looseObject({
          run: v.looseObject({ session: v.looseObject({ metadata: v.looseObject({ account: v.optional(v.string(), 'eval-service') }) }) }),
        })),
      })),
    })),
  })),
});

/** Why a report's trials could reach each other: the first account they shared rather than each acting as its own. */
export function sharedAccounts(report: string): string | undefined {
  const parsed = v.parse(ReportAccountsSchema, JSON.parse(report));

  const shared = parsed.testResults.flatMap((file) => file.assertionResults)
    .map((trial) => trial.meta?.harness?.run.session.metadata.account)
    .find((account) => account !== undefined && !account.startsWith('trial-'));

  return shared === undefined ? undefined : `its trials shared ${shared}, so they could reach each other`;
}
