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
import { halfOf, type TrialLease } from './lease';

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
  const [low, high] = halfOf(firstSlot > EVAL_TRIAL_ACCOUNTS / 2);
  const slot = firstSlot - 1 + ((taskAt * models.length + models.indexOf(place.model)) * arms.length + arms.indexOf(place.arm)) * trials + place.trial;
  const account = parseEvalAccount(`trial-${String(slot)}`);

  if (firstSlot - 1 + needed > high || account === null) {
    throw new Error(`the run's matrix needs ${String(needed)} trial accounts from trial-${String(firstSlot)}, and its half of a deployment's has trial-${String(low)} to trial-${String(high)}`);
  }

  return account;
}

/** A run's block of trial accounts on the deployments it drives, as its armada job's label claims it: with the run's
 *  lease (evals/src/lease.ts), one of the two facts that keep a block from every other run. */
export type SlotClaim = { readonly first: number; readonly last: number; readonly hosts: readonly string[] };

/** The label an eval run's armada job carries: its definitions and the block it runs on, read back by {@link claimOf}. */
export function claimLabel(sha: string, claim: SlotClaim): string {
  return `evals ${sha.slice(0, 12)} slots ${String(claim.first)}-${String(claim.last)} on ${claim.hosts.join(',')}`;
}

const CLAIM = /\bslots (\d+)-(\d+) on (\S+)$/u;

/** The block a job's label claims, or null for a job that claims none. */
export function claimOf(label: string): SlotClaim | null {
  const [, first, last, hosts] = CLAIM.exec(label) ?? [];

  return first === undefined || last === undefined || hosts === undefined ? null : { first: Number(first), last: Number(last), hosts: hosts.split(',') };
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

/** How long a trial waits for the deletions it asked for to land. */
const DELETIONS_LAND_MS = 180_000;

/**
 * A workspace's delete, and an account's, answers once it is durable, and its teardown runs in the account's own job,
 * which keeps the workspace's row and that job, and the account's mark (`account:deleting`), until it lands: a trial
 * reads the account once they went, or once its wait ends, and reports what stayed.
 */
export async function deletionsLanded(target: EvalTarget, deleted: boolean): Promise<Awaited<ReturnType<typeof trialInheritedRows>>> {
  const deadline = Date.now() + DELETIONS_LAND_MS;

  for (;;) {
    const read = await trialInheritedRows(target);
    const pending = !('why' in read) && ['user_workspaces', 'cf_agents_jobs', 'account:deleting'].some((held) => read.inherited[held] !== undefined);

    if (!deleted || !pending || Date.now() > deadline) return read;
    await Bun.sleep(1_000);
  }
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
  const read = await deletionsLanded(target, workspaces.length > 0);

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

const ProfileEmailSchema = v.looseObject({ email: v.string() });

/** How long one call to the deployment may take while an account is deleted. */
const DELETE_CALL_MS = 30_000;

const HeldKeysSchema = v.array(v.looseObject({ key: v.string() }));

/**
 * Signs `target`'s account in, as the dev identity's sign-in does (`POST /api/auth/dev-session`): the one way an account
 * deleted before is made again, which a read never does. A finding, or null.
 */
export async function signInTrialAccount(target: EvalTarget): Promise<string | null> {
  const answer = await fetch(`${target.origin}/api/auth/dev-session`, { method: 'POST', headers: webHeaders(target.identity), signal: AbortSignal.timeout(DELETE_CALL_MS) });

  return answer.ok ? null : `signing ${accountOf(target)} in at ${target.origin} answered ${String(answer.status)}`;
}

/** How long a run's teardown reads a deletion under way before it lets its lease go with the account still owed. */
const DELETION_FINISH_MS = 10 * 60_000;

/** How often a deletion under way is read again. */
const DELETION_POLL_MS = 2_000;

/** What reading an account answers about its deletion: still the account, being deleted, or deleted. */
function standingOf(status: number): 'live' | 'deleting' | 'deleted' | null {
  if (status === 404) return 'deleted';

  if (status === 503) return 'deleting';

  return status >= 200 && status < 300 ? 'live' : null;
}

/** How a teardown waits between reads of a deletion under way; a test hands its own. */
export type Pause = (ms: number) => Promise<void>;

/**
 * Whether `target`'s account has no deletion under way: it reads deleted (404), or live. One still being deleted (503), or
 * any other answer, has not settled; a read that fails rejects.
 */
export async function teardownSettled(target: EvalTarget): Promise<boolean> {
  const standing = standingOf((await fetch(`${target.origin}/api/user/profile`, { headers: webHeaders(target.identity), signal: AbortSignal.timeout(DELETE_CALL_MS) })).status);

  return standing === 'deleted' || standing === 'live';
}

/**
 * Deletes `target`'s account through the product's own account delete, its profile's email confirming it, and answers
 * once the deletion has finished, or `DELETION_FINISH_MS` from its start has passed: a finding, or null. Its credentials go first, each disconnected without revoking: an
 * account's delete revokes what it holds at the provider, and a trial account holds logins it does not own (a plan's,
 * OMP's; the deployment's gateway token). Reading it after is safe: a deleted account, or one being deleted, answers so
 * (`UserDO.ensureProfile`), and is neither made again nor noted in the control plane by a read (`UserDO.observed`).
 */
export async function deleteTrialAccount(target: EvalTarget, pause: Pause = async (ms) => Bun.sleep(ms)): Promise<string | null> {
  const headers = webHeaders(target.identity);
  const account = accountOf(target);

  const deadline = Date.now() + DELETION_FINISH_MS;

  const call = async (path: string, init: { readonly method?: string; readonly json?: unknown } = {}) => fetch(`${target.origin}${path}`, {
    method: init.method ?? 'GET', signal: AbortSignal.timeout(Math.max(1, Math.min(DELETE_CALL_MS, deadline - Date.now()))),
    headers: init.json === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...init.json !== undefined && { body: JSON.stringify(init.json) },
  });

  const profile = await call('/api/user/profile');
  const standing = standingOf(profile.status);

  if (standing === null) return `reading ${account}'s profile at ${target.origin} answered ${String(profile.status)}`;

  if (standing === 'live') {
    const held = await call('/api/user/credentials');

    if (!held.ok) return `listing ${account}'s credentials at ${target.origin} answered ${String(held.status)}`;

    for (const { key } of v.parse(HeldKeysSchema, await held.json())) {
      const dropped = await call(`/api/user/credentials/${encodeURIComponent(key)}?revoke=0`, { method: 'DELETE' });

      if (!dropped.ok) return `disconnecting ${account}'s ${key} at ${target.origin} answered ${String(dropped.status)}`;
    }

    const { email } = v.parse(ProfileEmailSchema, await profile.json());
    const deleted = await call('/api/user/account', { method: 'DELETE', json: { confirm: email } });

    if (!deleted.ok) return `deleting ${account} at ${target.origin} answered ${String(deleted.status)}`;
  }

  // Its workspaces are torn down and its storage destroyed by jobs of its own: the account is free once they have run.
  while (Date.now() < deadline) {
    const now = standingOf((await call('/api/user/profile')).status);

    if (now === 'deleted') return null;

    if (now !== 'deleting') return `${account} at ${target.origin} read as ${now ?? 'an error'} while its deletion was finishing`;
    await pause(Math.min(DELETION_POLL_MS, Math.max(0, deadline - Date.now())));
  }

  return `${account}'s deletion at ${target.origin} had not finished after ${String(DELETION_FINISH_MS / 60_000)} minutes`;
}

/** A run's leased block as it acts as it: each origin's account of the block. */
export interface TrialBlock {
  readonly targets: readonly EvalTarget[];
}

/** The file a run writes in its output once it leased its block: which accounts it holds, for its plan run's holder to
 *  renew into (scripts/eval-plan-run.ts). A description, never a lease. */
export const LEASED_FILE = 'lease.json';

/** The file a run writes in its output as its teardown begins: what renews into its accounts stops (scripts/eval-plan-run.ts). */
export const TEARDOWN_MARK = 'tearing-down';

/** The file a plan run's holder keeps in a run's output while it renews into the run's accounts; the teardown waits it out. */
export const RENEWING_MARK = 'renewing';

/**
 * Each account of `block` deleted, eight at a time, each answering before the next eight: what that came to, in words.
 * Each is marked owed on `lease` before its delete is asked, and the mark cleared only once it reads deleted, so one whose
 * deletion this run could not see finish keeps its block from the next run until a read finds it settled.
 */
async function deleteBlock(lease: TrialLease, block: TrialBlock, pause?: Pause): Promise<string> {
  const refused: string[] = [];
  let deleted = 0;

  const deleting = async (target: EvalTarget): Promise<string | null> => {
    const owed = { origin: target.origin, account: accountOf(target) };

    lease.owe(owed);
    const finding = await deleteTrialAccount(target, pause);

    if (finding === null) lease.settle(owed);

    return finding;
  };

  for (let at = 0; at < block.targets.length; at += 8) {
    const answers = await Promise.allSettled(block.targets.slice(at, at + 8).map(deleting));

    deleted += answers.filter((answer) => answer.status === 'fulfilled' && answer.value === null).length;
    refused.push(...answers.flatMap((answer) => (answer.status === 'rejected' ? [String(answer.reason)] : answer.value ?? [])));
  }

  return `evals: deleted ${String(deleted)} of the run's ${String(block.targets.length)} trial accounts${refused.length === 0 ? '' : `; refused: ${refused.join('; ')}`}`;
}

/**
 * `run` on its leased block (evals/src/lease.ts), whose accounts are deleted when it ends, however it ends, before the lease
 * is let go: trial accounts pile up otherwise (the owner, 2026-11-09: 64 left on production, 256 on staging). An account
 * whose deletion it could not see finish stays owed on the lease, so no run takes the block before it has settled.
 * The lease is held from before anything touches the block, so its teardown deletes nothing another run holds. The next
 * run's provisioning makes each account again before any trial opens on it (scripts/eval-provider-keys.ts). `before`
 * runs first: it waits for the run's remote trials to have ended, and for anything writing to the block to stop; where
 * it throws, the accounts are left as they are and the lease still goes. What a delete refused is said, never thrown
 * over `run`'s end.
 */
export async function onTrialBlock<T>(
  lease: TrialLease, block: TrialBlock, run: () => Promise<T>,
  options: { readonly say?: (line: string) => void; readonly before?: () => Promise<void>; readonly pause?: Pause } = {},
): Promise<T> {
  try {
    return await run();
  } finally {
    try {
      await options.before?.();
      (options.say ?? console.log)(await deleteBlock(lease, block, options.pause));
    } finally {
      await lease.release();
    }
  }
}
