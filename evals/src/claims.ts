// Which live process owns each eval workspace on this machine, so a run can delete the ones nobody
// does. A harness claims a workspace's name before it creates the workspace, and releases the claim
// once the workspace is deleted. A process that dies mid-trial leaves its claim behind, and a dead
// owner's claim is no claim (`ownerAlive`, scripts/process-owner.ts). A person holds a workspace the
// same way, with a reason instead of an owner, and a held workspace is never swept.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { tolerate } from '@kinu.run/core/obs';
import { currentOwner, ProcessOwnerSchema } from '../../scripts/process-owner';

const ClaimSchema = v.variant('kind', [
  v.object({ kind: v.literal('owned'), owner: ProcessOwnerSchema }),
  v.object({ kind: v.literal('held'), reason: v.pipe(v.string(), v.minLength(1)) }),
]);

export type EvalWorkspaceClaim = v.InferOutput<typeof ClaimSchema>;

/** Beside the eval sessions (`evalSessionPath`), one directory per deployment: a name on one origin says nothing
 *  about the same name on another. State, not cache: a claim deleted by hand makes a live run's workspace sweepable. */
function claimPath(origin: string, name: string): string {
  return join(homedir(), '.config', 'kinu', 'eval-workspaces', new URL(origin).host, `${name}.json`);
}

function write(origin: string, name: string, claim: EvalWorkspaceClaim): void {
  const path = claimPath(origin, name);

  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(claim)}\n`);
}

/** Claim `name` for this process; made before the workspace is, so no sweep can find it unclaimed. */
export function claimEvalWorkspace(origin: string, name: string): void {
  const owner = currentOwner();

  if (owner === null) throw new Error(`cannot claim ${name}: this process cannot name itself without /proc`);

  write(origin, name, { kind: 'owned', owner });
}

/** Keep `name` out of every sweep, for the reason given, until the claim is released. */
export function holdEvalWorkspace(origin: string, name: string, reason: string): void {
  write(origin, name, { kind: 'held', reason });
}

/** Drop the claim on a workspace that is gone. */
export function releaseEvalWorkspace(origin: string, name: string): void {
  rmSync(claimPath(origin, name), { force: true });
}

/** The claim on `name`, or null when no process ever claimed it on this machine. */
export function evalWorkspaceClaim(origin: string, name: string): EvalWorkspaceClaim | null {
  const text = tolerate(() => readFileSync(claimPath(origin, name), 'utf8'), 'enoent');

  return text === undefined ? null : v.parse(ClaimSchema, JSON.parse(text));
}
