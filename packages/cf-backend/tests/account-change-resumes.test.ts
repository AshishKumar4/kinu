// A provider refusal the owner must fix (402, 401, 403) parks the background effect it stopped, with no wake
// (ironwood-cairn-6dbcb8de, 2026-09-29: the fast tier answered 402 for 11.5 hours). The owner's fix is a change to the
// account, so each such change reaches every active workspace, which releases what it parked; a change the account
// refused releases nothing. The flow parks a real sleep-time compute on a warm workspace, changes the account through
// the owner's own route, and follows the effect to its answer.
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { BUILTIN_PROFILE_CATALOG, type JsonValue, type UserCaller } from '@kinu.run/core';
import { SLEEP_TIME_PROMPT_OPENING } from '../../core/src/utils/prompt-sections';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import type { ProfileCatalogWriteResult } from '../src/user/profile';
import type { ChatGptPlanStatus } from '../src/user/chatgpt-sign-in';
import type { AuthIdentity } from '../src/auth/session';
import { serveFamily } from './helpers/api';
import { bootstrappedProfile, userAccount, workspaceObject } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { catalogTurn, gatewayWorkspace, until, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, openingOf, stubAiBinding } from './helpers/platform-gateway';

afterEach(() => { setSystemTime(); });

const IDENTITY: AuthIdentity = { userId: '0123456789abcdef0123456789abcdef', email: 'owner@example.com', sub: 'sub', provider: 'test', authTime: Date.now() };

/** What the fast tier answers once the account can pay: one durable fact. */
const UPDATE = { upserts: [{ key: 'deploy.region', value: 'eu-west', confidence: 0.9, rationale: 'the owner said so twice' }], decay: [] };

/** The owner's account changes, each through its own route; `parks` names the one the account refuses. */
interface AccountChange {
  readonly what: string; readonly path: string; readonly method: string; readonly body?: JsonValue; readonly parks?: true;
  /** What the account's ChatGPT plan read answers: a machine's sign-in reaches the web only through that read (SIWC-08). */
  readonly planChanged?: boolean;
  readonly claudeConnected?: boolean;
}

const CHANGES: AccountChange[] = [
  { what: 'a credential is set', path: '/credentials/openai.api', method: 'POST', body: { kind: 'bearer', token: 'sk-new' } },
  { what: 'a credential is removed', path: '/credentials/openai.api', method: 'DELETE' },
  { what: 'a profile catalog write lands', path: '/profile-catalog', method: 'PUT', body: { catalog: {}, expectedVersion: 28 } },
  { what: 'a profile catalog write is refused', path: '/profile-catalog', method: 'PUT', body: { catalog: {}, expectedVersion: 27 }, parks: true },
  { what: 'Codex is disconnected', path: '/codex', method: 'DELETE' },
  { what: 'a Codex sign-in completes', path: '/codex/poll', method: 'POST', body: {} },
  { what: 'the web first sees a ChatGPT sign-in made on a machine', path: '/chatgpt', method: 'GET', planChanged: true },
  { what: 'the web reads a ChatGPT plan that has not changed', path: '/chatgpt', method: 'GET', planChanged: false, parks: true },
  { what: 'a Claude sign-in finishes', path: '/claude/finish', method: 'POST', body: { code: 'the-code#state' }, claudeConnected: true },
  { what: 'Claude refuses the sign-in exchange', path: '/claude/finish', method: 'POST', body: { code: 'the-code#state' }, claudeConnected: false, parks: true },
];

test.each(CHANGES)('when $what, a sleep-time compute parked on a refusal the owner must fix resumes or stays parked', async (change) => {
  let funded = false;

  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).startsWith(SLEEP_TIME_PROMPT_OPENING)) return chatCompletion(run, 'noted');

    return funded
      ? chatCompletion(run, JSON.stringify(UPDATE))
      : Response.json({ error: { message: 'Upstream request failed: Insufficient account funds', type: 'server_error' } }, { status: 402 });
  });

  const workspace = gatewayWorkspace(gateway);

  // On, as it is for an owner: the harness keeps it off unless a suite asks.
  workspaceMainActor(workspace.db).config.setSleepTimeComputeEnabled(true);
  const effect = () => workspace.db.query<{ status: string }, []>(`SELECT status FROM terminal_effects WHERE effect_name = 'sleep_time'`).all().map((row) => row.status);
  const fact = () => workspace.db.query<{ value: string }, []>(`SELECT value_json AS value FROM agent_facts WHERE key = 'deploy.region'`).get()?.value ?? null;

  // Three settled turns make the compute due; its fast-tier call is refused for funds, and the effect parks.
  for (const words of ['we deploy to eu-west', 'remember: eu-west only', 'ship the build']) await catalogTurn(workspace.agent, words);
  await workspace.agent.terminalRetryPass();
  await until(() => effect().includes('parked'), 'the sleep-time compute parked');

  // The owner tops up and changes the account; every active workspace hears of it from the route itself.
  funded = true;
  const pending: Promise<unknown>[] = [];

  const env: UserRoutesEnv<string> = {
    UserDO: { idFromName: (name) => name, get: () => userAccount({
      async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
      async userMcp_warmConnections() { return { servers: 0 }; },
      async setCredential() {},
      async deleteCredential() {},
      async disconnectCodex() {},
      async pollCodexDeviceFlow() { return { connected: true, accountId: 'acc' }; },
      async putProfileCatalog(_caller: UserCaller, _catalog: JsonValue, expectedVersion: number): Promise<ProfileCatalogWriteResult> {
        return expectedVersion === 28
          ? { ok: true, envelope: { authority: { kind: 'account', accountId: 'acc' }, version: 29, digest: 'd', catalog: BUILTIN_PROFILE_CATALOG } }
          : { ok: false, kind: 'conflict', currentVersion: 28, currentDigest: 'd' };
      },
      async listActiveWorkspaces() { return [{ name: 'harness-parent', displayName: 'Harness', createdAt: 1, nameOrigin: 'user' as const }]; },
      async finishClaudeSignIn() {
        return change.claudeConnected === true ? { connected: true } : { connected: false, error: 'Claude refused the sign-in: invalid_grant' };
      },
      async chatgptPlan(): Promise<ChatGptPlanStatus> {
        return {
          device: { id: 'dev-1', label: 'studio' },
          status: { signedIn: true, email: 'owner@example.com', planEnabled: true, planDeclined: false, pending: false, lastFailure: null, firstSignIn: true },
          account: null, machineSignIn: null, changed: change.planChanged === true,
        };
      },
    }) },
    OrchestratorAgent: {
      idFromName: (name) => name,
      get: () => workspaceObject({ onModelSettingsChanged: async () => await workspace.agent.onModelSettingsChanged() }),
    },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };

  const answered = await serveFamily(userRoutes, { identity: IDENTITY, ctx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } })(
    new Request(`https://kinu.example.com/api/user${change.path}`, {
      method: change.method, headers: { 'content-type': 'application/json' }, body: change.body === undefined ? undefined : JSON.stringify(change.body),
    }),
    env,
  );

  await Promise.all(pending);
  await workspace.agent.terminalRetryPass();

  if (change.parks === true) {
    expect({ status: answered?.status, effect: effect(), fact: fact() })
      .toEqual({ status: change.what.startsWith('a profile catalog') ? 409 : 200, effect: ['parked'], fact: null });

    return;
  }

  await until(() => fact() !== null, 'the released compute answered');
  expect({ status: answered?.status, effect: effect(), fact: v.parse(v.string(), JSON.parse(fact() ?? 'null')) })
    .toEqual({ status: 200, effect: [], fact: 'eu-west' });
});
