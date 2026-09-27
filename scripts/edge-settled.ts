#!/usr/bin/env bun
/**
 * THE DEPLOYMENT'S NAMES ANSWER OVER VERIFIED TLS BEFORE ANYTHING DRIVES THEM. An upload that creates an environment's
 * Custom Domain and routes returns before the edge holds a certificate for every name under them. On 2026-09-26
 * staging's triggers deployed at 06:54:35, its tiers started a minute later, and share-capability-cut failed three
 * times on "unknown certificate verification error" for a share host under `*.staging.kinu.run`; asked again at
 * 07:04, the same case passed. A red no change to the product could fix.
 *
 * So the smoke step waits for a checked condition, never for a length of time: every name the deployment serves,
 * each Custom Domain and a name under each route, answers HTTPS with a certificate that verifies, asked the way
 * `gate:infra` asks (`observeEdge`). A name is asked again every {@link POLL_SECONDS} until it answers, and a name
 * that never does by {@link SETTLE_SECONDS} fails the deploy with what it last answered.
 */

import { deriveInfrastructure, INFRA_ENVIRONMENTS, type Resource } from './infra-manifest';
import type { Observation } from './infra-cloudflare';
import { EDGE_KINDS, observeEdge } from './infra-verify';

/** How often an unsettled name is asked again. */
export const POLL_SECONDS = 15;

/** The bound on the wait, the hang detector: the certificate that raced staging's first deploy was issued within ten
 *  minutes of its triggers (2026-09-26), and Cloudflare documents no bound on issuance. */
export const SETTLE_SECONDS = 900;

type EdgeResource = Resource & { readonly kind: (typeof EDGE_KINDS)[number] };

/** The time a wait reads and spends, handed in so the wait itself is testable. */
export interface SettleClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface Settled {
  /** Each name that never answered by the bound, with what it last answered. */
  readonly unsettled: ReadonlyMap<string, Observation>;
  /** How many times each name was asked. */
  readonly asked: ReadonlyMap<string, number>;
}

/** Asks each resource until it is present or `bound` seconds have passed, asking again only the ones not yet
 *  present. */
export async function settle(
  resources: readonly EdgeResource[],
  observe: (resource: EdgeResource) => Promise<Observation>,
  clock: SettleClock,
  bound = SETTLE_SECONDS,
): Promise<Settled> {
  const deadline = clock.now() + bound * 1000;
  const asked = new Map<string, number>();
  const last = new Map<string, Observation>();
  let waiting = [...resources];

  for (;;) {
    const answers = await Promise.all(waiting.map(async (resource) => [resource, await observe(resource)] as const));

    for (const [resource, answer] of answers) {
      asked.set(resource.id, (asked.get(resource.id) ?? 0) + 1);
      last.set(resource.id, answer);
    }

    waiting = answers.filter(([, answer]) => answer.state !== 'present').map(([resource]) => resource);

    if (waiting.length === 0 || clock.now() + POLL_SECONDS * 1000 > deadline) break;
    await clock.sleep(POLL_SECONDS * 1000);
  }

  const unsettled = new Map(waiting.map((resource) => [resource.id, last.get(resource.id) ?? { state: 'absent' as const }]));

  return { unsettled, asked };
}

const isEdge = (resource: Resource): resource is EdgeResource =>
  EDGE_KINDS.some((kind) => kind === resource.kind);

/** What an observation says, as one line. */
function said(observation: Observation): string {
  if (observation.state === 'unknown') return observation.reason;

  return observation.detail ?? observation.state;
}

async function main(): Promise<number> {
  const environment = INFRA_ENVIRONMENTS.find((name) => name === (process.argv[2] ?? 'production'));

  if (environment === undefined) {
    console.error(`edge-settled: usage: bun scripts/edge-settled.ts [${INFRA_ENVIRONMENTS.join('|')}]`);

    return 2;
  }

  const resources = deriveInfrastructure(environment).resources.filter(isEdge);
  const started = Date.now();
  const { unsettled, asked } = await settle(resources, observeEdge, { now: Date.now, sleep: Bun.sleep });
  const waited = ((Date.now() - started) / 1000).toFixed(0);

  for (const resource of resources) {
    const answer = unsettled.get(resource.id);

    console.log(`  ${answer === undefined ? 'ok  ' : 'NOT '}  ${resource.id}  (asked ${String(asked.get(resource.id) ?? 0)} time(s))`
      + (answer === undefined ? '' : `: ${said(answer)}`));
  }

  if (unsettled.size > 0) {
    console.error(`edge-settled: ${String(unsettled.size)} name(s) did not answer over verified TLS within ${String(SETTLE_SECONDS)}s`);

    return 1;
  }

  console.log(`edge-settled: every name ${environment} serves answers over verified TLS (after ${waited}s)`);

  return 0;
}

if (import.meta.main) process.exit(await main());
