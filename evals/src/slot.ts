// Every trial of an eval run acts as an account of its own (core `parseEvalAccount`), so no trial reaches another:
// peers, messages, spawned workspaces, swarm publications and the experience library are all the account's. On
// 2026-10-01 trials sharing eval-service listed each other as peers and messaged each other.
//
// A trial's slot is its place in the run's whole matrix: every runner file, sorted, then model, arm and
// trial, from the first account of the block its run leased (scripts/evals-lease.ts). Each worker process works it out
// alone, two trials of a run never share one, and two open runs never hold one block. Before a trial opens, its
// account is checked: a workspace another run marks live means the slot is taken, one a stopped run left is deleted,
// and a row the trial could inherit stops it, named.
import * as v from 'valibot';
import {
  EVAL_TRIAL_ACCOUNTS, EVAL_WORKSPACE_LEASE_MS, inheritedRows, JsonValueSchema, parseEvalAccount, ProfileCatalogEnvelopeSchema, type EvalAccount,
  type JsonValue,
} from '@kinu.run/core';
import { evalWorkspaceStem } from '@kinu.run/test-utils';
import { deleteWorkspace, listWorkspaces, webHeaders } from './workspace-roster';
import type { EvalMatrix } from './config';
import type { EvalTarget } from './workspace-roster';

/** A trial's place in its run. */
export type TrialPlace = {
  readonly taskFiles: readonly string[];
  readonly task: string;
  readonly matrix: Pick<EvalMatrix, 'models' | 'arms' | 'trials' | 'firstSlot' | 'sequence'>;
  readonly model: string;
  readonly arm: string;
  readonly trial: number;
};

/** The trial's own account, `trial-<n>`. */
export function trialSlot(place: TrialPlace): EvalAccount {
  const files = [...place.taskFiles].sort();
  const { models, arms, trials, firstSlot, sequence } = place.matrix;
  // A sequence's tasks share their model, arm and trial's account; otherwise each task has its own.
  const taskAt = sequence ? 0 : files.indexOf(place.task);
  const tasks = sequence ? 1 : files.length;

  if (!files.includes(place.task)) throw new Error(`runner ${place.task} has no place in the run's matrix`);
  const needed = tasks * models.length * arms.length * trials;
  const [low, high] = halfOf(firstSlot > HALF);
  const slot = firstSlot - 1 + ((taskAt * models.length + models.indexOf(place.model)) * arms.length + arms.indexOf(place.arm)) * trials + place.trial;
  const account = parseEvalAccount(`trial-${String(slot)}`);

  if (firstSlot - 1 + needed > high || account === null) {
    throw new Error(`the run's matrix needs ${String(needed)} trial accounts from trial-${String(firstSlot)}, and its half of a deployment's has trial-${String(low)} to trial-${String(high)}`);
  }

  return account;
}

const HALF = EVAL_TRIAL_ACCOUNTS / 2;

/** The accounts a deploy's one-trial pass takes (the upper half), or every other run (the lower): `[first, last]`. */
function halfOf(pass: boolean): readonly [number, number] {
  return pass ? [HALF + 1, EVAL_TRIAL_ACCOUNTS] : [1, HALF];
}

/** A run's hold on a block of trial accounts on the deployments it drives, as its armada job's label declares it. */
export type SlotClaim = { readonly first: number; readonly last: number; readonly hosts: readonly string[] };

const CLAIM = /\bslots (\d+)-(\d+) on (\S+)$/u;

/** The label an eval run's armada job carries: its definitions and the block it holds, read back by {@link claimOf}. */
export function claimLabel(sha: string, claim: SlotClaim): string {
  return `evals ${sha.slice(0, 12)} slots ${String(claim.first)}-${String(claim.last)} on ${claim.hosts.join(',')}`;
}

/** The block a job's label claims, or null for a job that claims none. */
export function claimOf(label: string): SlotClaim | null {
  const [, first, last, hosts] = CLAIM.exec(label) ?? [];

  return first === undefined || last === undefined || hosts === undefined ? null : { first: Number(first), last: Number(last), hosts: hosts.split(',') };
}

/**
 * The first account of the lowest block of `size` in the run's half (`pass`) that no claim on any of `hosts` holds; null
 * when every such block is held, and the run waits for one to end.
 */
export function freeBlock(size: number, pass: boolean, hosts: readonly string[], claims: readonly SlotClaim[]): number | null {
  const [low, high] = halfOf(pass);
  const held = claims.filter((claim) => claim.hosts.some((host) => hosts.includes(host)));

  for (let first = low; first - 1 + size <= high;) {
    const blocking = held.find((claim) => claim.first <= first - 1 + size && claim.last >= first);

    if (blocking === undefined) return first;
    first = blocking.last + 1;
  }

  return null;
}

/** Every trial account a matrix uses: the ones a deploy gives the eval provider keys. */
export function trialAccounts(taskFiles: readonly string[], matrix: TrialPlace['matrix']): EvalAccount[] {
  return [...new Set([...taskFiles].sort().flatMap((file) => matrix.models.flatMap((model) => matrix.arms.flatMap((arm) =>
    Array.from({ length: matrix.trials }, (_, at) => trialSlot({ taskFiles, task: file, matrix, model, arm, trial: at + 1 }))))))];
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
  const [catalog, gateways] = await Promise.all([read('/api/user/profile-catalog'), read('/api/user/cloudflare/gateways')]);

  if ('why' in catalog) return { why: catalog.why };

  if ('why' in gateways) return { why: gateways.why };

  return { inherited: inheritedRows(rows, {
    catalog: v.parse(ProfileCatalogEnvelopeSchema, catalog.value).version > 0,
    gateway: v.parse(v.looseObject({ selectedId: v.nullable(v.string()) }), gateways.value).selectedId !== null,
  }) };
}

/**
 * Make `target`'s trial account its trial's own before the trial opens on it. A live workspace named for this trial
 * (`subject`) is its own earlier attempt, which armada ran again once it lost it: the account is the trial's alone in
 * its run's leased block, so the retry takes it back as it does a stopped run's. Any other live workspace is another
 * run's, and stops it. A task of a sequence opens on the rows its sequence's earlier tasks left; the sequence's account
 * was checked once, before its first task (scripts/evals-map.ts).
 */
export async function prepareTrialAccount(target: EvalTarget, now: number, trial: { readonly subject?: string; readonly sequence: boolean } = { sequence: false }): Promise<void> {
  const workspaces = await listWorkspaces(target.origin, target.identity);
  const own = trial.subject === undefined ? null : evalWorkspaceStem(trial.subject);
  const live = workspaces.find((workspace) => now - workspace.lastVisited < EVAL_WORKSPACE_LEASE_MS && (own === null || !workspace.name.startsWith(own)));

  if (live !== undefined) {
    throw new Error(`${accountOf(target)} is in use by another run: its workspace ${live.name} was marked live `
      + `${String(Math.round((now - live.lastVisited) / 1000))}s ago`);
  }

  for (const { name } of workspaces) await deleteWorkspace(target.origin, target.identity, name);

  if (trial.sequence) return;
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
    .find((workspace) => workspace.name !== own && now - workspace.lastVisited < EVAL_WORKSPACE_LEASE_MS);

  if (rival !== undefined) throw new Error(`${accountOf(target)} is occupied by another run's workspace ${rival.name}; ${own} cannot claim it`);
}
