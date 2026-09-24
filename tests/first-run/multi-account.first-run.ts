/**
 * FIRST RUN: two accounts of one provider, on the deployed product.
 *
 * THE ASK, in the owner's words (m1447, 2026-09-19): "I would want multiple accounts per provider
 * capability for all providers, just like OMP has". A second key of one provider is stored under a
 * name beside the first; the web listing and the CLI menu both name both; a workspace chooses which
 * one pays, from the CLI and through the web picker's pin; removing one account leaves the other.
 *
 * EVERY STEP IS A CLIENT'S OWN CALL, made as the eval identity:
 *   store    POST /api/user/credentials/<key>, the providers panel's setCredential, on the key
 *            core's accountCredentialKey builds, as the panel does
 *   list     GET /api/user/credentials, the panel's listing
 *   menu     GET /api/cli/models through the CLI's own listCloudAvailableModels
 *   choose   the CLI RPC setProviderAccount that `/accounts use` sends, read back with
 *            getProviderAccounts; and the workspace socket's setModel on `<provider>@<name>/<model>`,
 *            the web picker's pin
 *   remove   DELETE /api/user/credentials/<key>, the panel's remove
 *
 * NO MODEL CALL. The keys are fake and nothing sends a turn. The bare key is never written, and each
 * account name carries a nonce, so the row cannot touch a key the account already holds.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import {
  accountCredentialKey, formatModelSpec, OPENAI_DEFAULT_MODEL, ORCHESTRATOR_AGENT_SLUG, parseModelSpec,
} from '@kinu.run/core';
import { workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { callAgentRpc, listCloudAvailableModels } from '../../packages/cli/src/cloud-api';
import { webHeaders, type PublicWebIdentity } from '../evals/public-session';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { ask, openPublicSocket, rpcDetail, type Answer } from './public-socket';

const SUITE = 'First-run · multi-account';

const CASE = 'multi-account' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const PROVIDER = 'openai';

const BASE_KEY = 'openai.bearer';

const ListedSchema = v.array(v.looseObject({ key: v.string() }));

const ProviderAccountsSchema = v.looseObject({ accounts: v.record(v.string(), v.string()) });

const PinnedSchema = v.looseObject({ spec: v.string() });

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: string };

async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, failure: (error instanceof Error ? error.message : String(error)).slice(0, 240) };
  }
}

/** The first failed step's reason, else what the last read said. */
function detailOf(steps: ReadonlyArray<readonly [string, Attempt<unknown>]>, said: () => string): string {
  for (const [label, step] of steps) {
    if (!step.ok) return `${label}: ${step.failure}`;
  }

  return said();
}

async function answered(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);

  return response;
}

/** The providers panel's REST, as the web client sends it. */
function providersPanel(origin: string, identity: PublicWebIdentity, signal?: AbortSignal) {
  const headers = webHeaders(identity);
  const at = (key: string) => `${origin}/api/user/credentials/${encodeURIComponent(key)}`;

  return {
    store: (key: string, token: string) => attempt(async () => answered(await fetch(at(key), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bearer', token }),
      signal,
    }))),
    remove: (key: string) => attempt(async () => answered(await fetch(at(key), { method: 'DELETE', headers, signal }))),
    keys: () => attempt(async () => {
      const response = await answered(await fetch(`${origin}/api/user/credentials`, { headers, signal }));

      return v.parse(ListedSchema, await response.json()).map((row) => row.key);
    }),
  };
}

/** This row's own keys in a listing, so the detail never prints the account's other credentials. */
const ours = (keys: readonly string[]) => JSON.stringify(keys.filter((key) => key.startsWith(BASE_KEY)));

/** Removes one account through the panel and reads the listing back: that key gone, `kept` still listed. */
async function removeAccount(
  panel: ReturnType<typeof providersPanel>, held: Set<string>, key: string, kept: string | null,
): Promise<Omit<EvalSubgoal, 'what'>> {
  const removed = await panel.remove(key);

  if (removed.ok) held.delete(key);
  const after = await panel.keys();

  return {
    reached: removed.ok && after.ok && !after.value.includes(key) && (kept === null || after.value.includes(kept)),
    detail: detailOf(
      [[`DELETE ${key}`, removed], ['GET /api/user/credentials', after]],
      () => (after.ok ? `after removing ${key} the panel lists ${ours(after.value)}` : ''),
    ),
  };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false, budgetMs: 5 * 60_000,
      purpose: 'Disposable multi-account probe; no model task.',
      async run({ session, plan, budget }) {
        const goals: EvalSubgoal[] = [];
        const nonce = crypto.randomUUID().slice(0, 8);
        const [first, second] = [`fr${nonce}a`, `fr${nonce}b`];
        const [firstKey, secondKey] = [accountCredentialKey(BASE_KEY, first), accountCredentialKey(BASE_KEY, second)];
        const panel = providersPanel(plan.origin, plan.identity, budget);
        const cli = { origin: plan.origin, token: workerSession(plan.llm).token, name: session.workspace };
        const room = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`;
        const socket = openPublicSocket(plan.origin, plan.identity, room, budget);
        const held = new Set<string>();

        try {
          const refusals: string[] = [];

          for (const key of [firstKey, secondKey]) {
            const stored = await panel.store(key, `sk-first-run-${nonce}`);

            if (stored.ok) held.add(key);
            else refusals.push(`${key}: ${stored.failure}`);
          }

          goals.push({
            what: 'second-account-stored',
            reached: held.size === 2,
            detail: refusals.length === 0 ? `${firstKey} and ${secondKey} stored` : `refused ${refusals.join('; ')}`,
          });

          const listed = await panel.keys();

          goals.push({
            what: 'panel-lists-both',
            reached: listed.ok && listed.value.includes(firstKey) && listed.value.includes(secondKey),
            detail: listed.ok ? `the panel lists ${ours(listed.value)}` : `GET /api/user/credentials: ${listed.failure}`,
          });

          const menu = await attempt(() => listCloudAvailableModels(cli.origin, cli.token));
          const offered = menu.ok ? menu.value.accounts?.[PROVIDER] : undefined;

          goals.push({
            what: 'cli-menu-names-both',
            reached: offered !== undefined && offered.includes(first) && offered.includes(second),
            detail: !menu.ok
              ? `GET /api/cli/models: ${menu.failure}`
              : `the CLI menu's ${PROVIDER} accounts: ${JSON.stringify(offered ?? null)}`,
          });

          const chosen = await attempt(() => callAgentRpc({
            ...cli, method: 'setProviderAccount', args: [PROVIDER, second], schema: ProviderAccountsSchema,
          }));

          const readBack = await attempt(() => callAgentRpc({ ...cli, method: 'getProviderAccounts', schema: ProviderAccountsSchema }));

          goals.push({
            what: 'cli-chooses-workspace-account',
            reached: chosen.ok && readBack.ok && readBack.value.accounts[PROVIDER] === second,
            detail: detailOf(
              [['setProviderAccount', chosen], ['getProviderAccounts', readBack]],
              () => (readBack.ok ? `the workspace reads back ${JSON.stringify(readBack.value.accounts)}` : ''),
            ),
          });

          const pin = formatModelSpec({ provider: PROVIDER, account: first, modelId: OPENAI_DEFAULT_MODEL });
          const pinned: Answer = await socket.opened ? await ask(socket, 'setModel', [pin]) : { ok: false, failure: `${socket.path} refused the upgrade` };
          const accepted = pinned.ok ? v.safeParse(PinnedSchema, pinned.value) : null;
          const kept = accepted?.success === true ? parseModelSpec(accepted.output.spec) : null;

          goals.push({
            what: 'web-picker-pins-account',
            reached: kept !== null && kept.provider === PROVIDER && kept.account === first,
            detail: rpcDetail({
              rpc: 'setModel', answer: pinned, refusal: 'refused',
              said: accepted?.success === true ? `setModel(${pin}) answered ${accepted.output.spec}` : null,
            }),
          });

          goals.push({ what: 'removing-one-keeps-the-other', ...await removeAccount(panel, held, firstKey, secondKey) });
          goals.push({ what: 'last-account-removed', ...await removeAccount(panel, held, secondKey, null) });

          return goals;
        } finally {
          socket.close('the row is done');
          const cleanup = providersPanel(plan.origin, plan.identity);

          for (const key of held) {
            const left = await cleanup.remove(key);

            if (!left.ok) console.warn(`    [multi-account] ${key} is still stored on the eval account: ${left.failure}`);
          }
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
