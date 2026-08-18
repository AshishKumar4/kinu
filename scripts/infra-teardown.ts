/**
 * `bun run infra:teardown` — delete what provisioning created, in reverse
 * dependency order, and refuse without a typed acknowledgement naming the
 * environment.
 *
 * THIS PROGRAM IS A LEAF. Nothing imports it. It is not reachable from
 * `infra-provision.ts`, from `infra-verify.ts`, or from `deploy.sh`, and it must
 * stay that way: a destructive path that can be reached by a wrong flag on a
 * constructive command is a destructive path that will be.
 *
 * THE CONFIRMATION IS A SENTENCE, NOT A `-y`. It names the worker and the
 * environment, so it cannot be pasted out of a runbook for a different
 * deployment, and it cannot be produced by a shell that answers yes to
 * everything. It is printed only after the report of WHAT IS INSIDE each
 * data-bearing resource — a list of names tells an operator nothing about what
 * they are about to lose.
 *
 * IT REFUSES TO DELETE SHARED RESOURCES. `proteus-backups` and
 * `nimbus-runtime-cache` are bound by production AND staging, so tearing down one
 * environment must not take them: they are reported as retained, with the
 * environment that still holds them. `exclusiveTo` is the whole of that rule and
 * it comes from the manifest, not from a list here.
 *
 * ORDER IS THE REVERSE OF PROVISIONING, and the Worker goes first for a reason:
 * deleting it releases every Durable Object namespace and all their storage,
 * which no CLI can delete on its own, and it also releases the bindings that
 * would otherwise make a bucket deletion fail.
 */

import { createInterface } from 'node:readline/promises';
import {
  type Resource, deriveInfrastructure, exclusiveTo,
} from './infra-manifest';
import { authenticated, why, wrangler } from './infra-cloudflare';

const BOLD = '\u001B[1m';
const RED = '\u001B[0;31m';
const NC = '\u001B[0m';

/** Set instead of typing the phrase, for the one case where a terminal is not
 *  available. It carries the SAME phrase — the guard is the sentence, not the
 *  channel, so an automation still has to name the exact environment it means. */
export const CONFIRM_VAR = 'PROTEUS_TEARDOWN_CONFIRM';

/** The sentence the operator must produce. Derived from the target, so it can
 *  never be right for a deployment other than the one being destroyed. */
export function confirmationPhrase(workerName: string, environment: string): string {
  return `destroy ${workerName} ${environment}`;
}

/**
 * Reverse dependency order for the resources that have a delete command.
 *
 * The Worker first: it holds the Durable Object namespaces, and a DO namespace
 * has no delete command of its own. Then the container application, then the
 * index, then buckets, then the database last, because it is the one whose loss
 * is least recoverable and the operator should have had every chance to
 * interrupt.
 */
const ORDER: readonly string[] = ['worker', 'container', 'vectorize', 'r2', 'd1'];

export interface Partition {
  /** Deleted by their own wrangler command, in the order given. */
  readonly deleted: readonly Resource[];
  /** Destroyed as a CONSEQUENCE of deleting the Worker, with no command of
   *  their own. */
  readonly swept: readonly Resource[];
  /** Survives: nothing here created it and nothing here removes it. */
  readonly outlives: readonly Resource[];
}

/**
 * Every resource in exactly one of three fates. TOTAL by construction, and the
 * test asserts it, because this partition is what the confirmation prompt is
 * built from and a resource in no group is a loss nobody was warned about.
 *
 * `swept` exists because an earlier draft had no such group and listed five
 * Durable Object namespaces — every UserDO profile, every agent's state, every
 * open incident — under "no wrangler command removes these; they outlive the
 * teardown". That is the exact opposite of what happens: they go with
 * `wrangler delete`, and hiding the largest data loss in the operation behind a
 * reassuring heading is worse than not printing it at all.
 */
export function partition(resources: readonly Resource[]): Partition {
  return {
    deleted: resources.filter((resource) => resource.destroy !== undefined)
      .sort((a: Resource, b: Resource) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)),
    swept: resources.filter((resource) =>
      resource.destroy === undefined && resource.origin !== 'manual'),
    outlives: resources.filter((resource) =>
      resource.destroy === undefined && resource.origin === 'manual'),
  };
}

/** What the operator is about to lose. A data-bearing resource is named with its
 *  CONTENTS, because "proteus-auth will be deleted" and "every signed-in
 *  identity and every live session will be deleted" are different sentences and
 *  only one of them stops a mistake. */
function describe(deleted: readonly Resource[], swept: readonly Resource[]): void {
  console.log(`\n${RED}${BOLD}THIS DELETES DATA${NC}\n`);
  console.log('  Deleted directly, in this order:');
  for (const resource of deleted) {
    console.log(`\n    ${BOLD}${resource.id}${NC}\n      via:   wrangler ${(resource.destroy ?? []).join(' ')}`
      + (resource.holds === undefined ? '\n      holds: nothing of its own' : `\n      holds: ${resource.holds}`));
  }
  const bearing = swept.filter((resource) => resource.holds !== undefined);
  const inert = swept.filter((resource) => resource.holds === undefined);
  if (bearing.length > 0) {
    console.log('\n  Destroyed WITH the Worker — no command of their own, and this is where the '
      + 'storage goes:');
    for (const resource of bearing) {
      console.log(`\n    ${BOLD}${resource.id}${NC}\n      holds: ${resource.holds ?? ''}`);
    }
  }
  if (inert.length > 0) {
    // Not all of these go with the WORKER — a D1 database takes its applied
    // schema with it — so the heading says "as a consequence" rather than
    // naming a mechanism that is only true of most of them.
    console.log('\n  Also removed as a consequence, holding no data of their own: '
      + inert.map((resource) => resource.id).join(', '));
  }
}

async function main(): Promise<number> {
  const target = process.argv[2];
  const infrastructure = deriveInfrastructure();
  const keys = infrastructure.environments.map((environment) => environment.key);
  const environment = infrastructure.environments.find((entry) => entry.key === target);
  if (environment === undefined) {
    console.error('infra:teardown: name the environment to destroy.\n'
      + `  usage: bun run infra:teardown <${keys.join('|')}>\n`
      + '  There is no default and there will not be one.');
    return 1;
  }

  const session = authenticated();
  if (session.state !== 'present') {
    console.error(`infra:teardown: no Cloudflare session — ${session.state === 'unknown' ? session.reason : 'wrangler is logged out'}`);
    return 1;
  }

  const shared = infrastructure.resources.filter((resource) =>
    resource.environments.includes(environment.key)
    && resource.environments.some((key) => key !== environment.key));
  const fate = partition(exclusiveTo(infrastructure, environment.key));
  const doomed = fate.deleted;

  console.log(`${BOLD}Proteus infrastructure teardown — ${environment.key} (${environment.workerName})${NC}`);
  describe(doomed, fate.swept);

  if (shared.length > 0) {
    console.log(`\n${BOLD}RETAINED${NC} — bound by another environment, so this teardown will not touch them:`);
    for (const resource of shared) {
      const others = resource.environments.filter((key) => key !== environment.key);
      console.log(`  ${resource.id} — still held by ${others.join(', ')}`);
    }
  }
  if (fate.outlives.length > 0) {
    console.log(`\n${BOLD}SURVIVES${NC} — nothing here created these and nothing here removes them:`);
    for (const resource of fate.outlives) console.log(`  ${resource.id} — ${resource.purpose}`);
  }

  const phrase = confirmationPhrase(environment.workerName, environment.key);
  const supplied = (process.env[CONFIRM_VAR] ?? '').trim();
  let typed = supplied;
  if (typed.length === 0) {
    if (process.stdin.isTTY !== true) {
      console.error(`\ninfra:teardown: refused. Nothing was deleted.\n`
        + `  This needs a typed acknowledgement and there is no terminal to type it at.\n`
        + `  Set ${CONFIRM_VAR}='${phrase}' to acknowledge it in the invocation instead.`);
      return 1;
    }
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      typed = (await reader.question(`\nType exactly '${phrase}' to proceed: `)).trim();
    } finally {
      reader.close();
    }
  }
  if (typed !== phrase) {
    console.error(`\ninfra:teardown: refused. Nothing was deleted.\n`
      + `  expected: '${phrase}'\n`
      + `  got:      '${typed}'`);
    return 1;
  }

  console.log(`\n${BOLD}Deleting, in reverse dependency order${NC}`);
  let failures = 0;
  for (const resource of doomed) {
    const argv = [
      ...(resource.destroy ?? []),
      ...(environment.wranglerEnv === undefined || resource.kind !== 'worker'
        ? []
        : ['--env', environment.wranglerEnv]),
    ];
    const run = wrangler(argv, 300_000);
    if (run.ok) {
      console.log(`  deleted  ${resource.id}`);
      continue;
    }
    failures += 1;
    console.error(`  FAILED   ${resource.id}: \`wrangler ${argv.join(' ')}\` — ${why(run)}`);
  }

  console.log(`\ninfra:teardown: ${String(doomed.length - failures)} deleted, ${String(failures)} failed, `
    + `${String(shared.length)} retained because another environment binds them.`);
  console.log('  Rebuild with: bun run infra:provision && bun run deploy && bun run gate:infra');
  return failures > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
