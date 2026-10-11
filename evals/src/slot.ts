// Every trial of an eval run acts as an account of its own (core `parseEvalAccount`), so no trial reaches another:
// peers, messages, spawned workspaces, swarm publications and the experience library are all the account's. On
// 2026-10-01 trials sharing eval-service listed each other as peers and messaged each other.
//
// A trial's slot is its place in the run's whole matrix: every runner file, sorted, then model, arm and
// trial. Each worker process works it out alone, and two trials of a run never share one. Before a trial opens, its
// account is checked: a workspace another run marks live means the slot is taken, one a stopped run left is deleted,
// and a row the trial could inherit stops it, named.
import * as v from 'valibot';
import { EVAL_TRIAL_ACCOUNTS, inheritedRows, JsonValueSchema, parseEvalAccount, ProfileCatalogEnvelopeSchema, type EvalAccount, type JsonValue } from '@kinu.run/core';
import { deleteWorkspace, listWorkspaces, webHeaders, WORKSPACE_LEASE_MS } from './workspace-roster';
import type { EvalMatrix } from './config';
import type { EvalTarget } from './workspace-roster';

/** A trial's place in its run. */
export type TrialPlace = {
  readonly taskFiles: readonly string[];
  readonly task: string;
  readonly matrix: Pick<EvalMatrix, 'models' | 'arms' | 'trials' | 'firstSlot'>;
  readonly model: string;
  readonly arm: string;
  readonly trial: number;
};

/** The trial's own account, `trial-<n>`. */
export function trialSlot(place: TrialPlace): EvalAccount {
  const files = [...place.taskFiles].sort();
  const taskAt = files.indexOf(place.task);
  const { models, arms, trials, firstSlot } = place.matrix;

  if (taskAt === -1) throw new Error(`runner ${place.task} has no place in the run's matrix`);
  const needed = files.length * models.length * arms.length * trials;
  const half = EVAL_TRIAL_ACCOUNTS / 2;
  const slot = firstSlot - 1 + ((taskAt * models.length + models.indexOf(place.model)) * arms.length + arms.indexOf(place.arm)) * trials + place.trial;
  const account = parseEvalAccount(`trial-${String(slot)}`);

  if (needed > half || account === null) {
    throw new Error(`the run's matrix needs ${String(needed)} trial accounts, and its half of a deployment's has trial-${String(firstSlot)} to trial-${String(firstSlot - 1 + half)}`);
  }

  return account;
}

/** Every trial account a matrix uses: the ones a deploy gives the eval provider keys. */
export function trialAccounts(taskFiles: readonly string[], matrix: TrialPlace['matrix']): EvalAccount[] {
  return [...taskFiles].sort().flatMap((file) => matrix.models.flatMap((model) => matrix.arms.flatMap((arm) =>
    Array.from({ length: matrix.trials }, (_, at) => trialSlot({ taskFiles, task: file, matrix, model, arm, trial: at + 1 })))));
}


/** The account a target acts as. */
function accountOf(target: EvalTarget): string {
  return target.identity.account ?? 'eval-service';
}

/** What a trial would inherit, distinguishing the account's stored model catalog from other configuration. */
export async function trialInheritedRows(target: EvalTarget): Promise<{ inherited: Record<string, number> } | { why: string }> {
  const read = async (path: string): Promise<{ value: JsonValue } | { why: string }> => {
    const response = await fetch(`${target.origin}${path}`, { headers: webHeaders(target.identity) });
    const text = await response.text();

    return response.ok ? { value: v.parse(JsonValueSchema, JSON.parse(text)) }
      : { why: `reading ${path} answered ${String(response.status)}: ${text.slice(0, 300)}` };
  };

  const held = await read('/api/user/held-rows');

  if ('why' in held) return { why: held.why };
  const rows = v.parse(v.record(v.string(), v.number()), held.value);

  if ((rows.user_config ?? 0) === 0) return { inherited: inheritedRows(rows) };
  const catalog = await read('/api/user/profile-catalog');

  return 'why' in catalog ? { why: catalog.why }
    : { inherited: inheritedRows(rows, v.parse(ProfileCatalogEnvelopeSchema, catalog.value).version) };
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
  const read = await trialInheritedRows(target);

  if ('why' in read) throw new Error(`${accountOf(target)}: ${read.why}`);
  const inherited = Object.entries(read.inherited);

  if (inherited.length > 0) {
    throw new Error(`${accountOf(target)} holds rows a trial would inherit: ${inherited.map(([table, rows]) => `${table} ${String(rows)}`).join(', ')}; `
      + `the next deploy's eval provisioning resets it (bun scripts/eval-provider-keys.ts ${target.origin})`);
  }
}


/**
 * A late, lexically earlier workspace cannot take an already claimed slot (red: 20261011193750-66fc10ae).
 * Concurrent runs can both be refused; a visible failure is preferable to trials running on a contaminated account.
 */
export async function claimTrialAccount(target: EvalTarget, own: string, now: number): Promise<void> {
  const rival = (await listWorkspaces(target.origin, target.identity))
    .find((workspace) => workspace.name !== own && now - workspace.lastVisited < WORKSPACE_LEASE_MS);

  if (rival !== undefined) throw new Error(`${accountOf(target)} is occupied by another run's workspace ${rival.name}; ${own} cannot claim it`);
}
