/**
 * The whole `/api` app, driven through `api.fetch` with one live browser session: the bindings its gates
 * read, and recording doubles behind them. Bun-only (its KV and key come from Bun helpers).
 */
import { present } from '@kinu.run/test-utils';
import { sha256Hex, type UserCaller } from '@kinu.run/core';
import { SESSION_COOKIE_NAME } from '../../src/auth/session';
import { workerContext } from './bindings';
import { makeKv } from './kv';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './user-do';

export const PROBE_ORIGIN = 'https://kinu.example.com';

export interface AppProbe {
  /** Bindings enough for the whole `/api` app to authenticate a browser session and answer. */
  readonly env: Env;
  readonly ctx: ReturnType<typeof workerContext>;
  /** The `cookie` header of one live browser session. */
  readonly cookie: string;
  /** Every method called on the session's account object, in order. */
  readonly accountCalls: string[];
  /** Every method called on a workspace object, in order. */
  readonly workspaceCalls: string[];
}

/** The session's live row, as the account object answers `verifyBrowserSession` for its own token. */
interface LiveSession {
  readonly identity: {
    readonly email: string; readonly sub: string; readonly provider: string; readonly displayName: null; readonly authTime: number;
  };
}

/** What a double answers: whatever a gate needs to let a request by, and nothing a family could render. */
type ProbeAnswer = boolean | null | readonly never[] | LiveSession | { readonly owner: string; readonly capabilityHash: null };

/** What the gates need to let a request by; any listing is empty, anything else `null`. */
function gateAnswer(method: string): ProbeAnswer {
  if (method === 'hasWorkspace') return true;

  if (method.startsWith('list')) return [];

  return null;
}

/** An object whose every call is recorded by name, then answered by `answer`. Not a thenable. */
function recording(calls: string[], answer: (method: string, presented: string) => ProbeAnswer) {
  return new Proxy({}, {
    get: (_target, property) => (property === 'then' ? undefined : async (_caller: UserCaller, presented: string) => {
      calls.push(String(property));

      return answer(String(property), presented);
    }),
  });
}

/**
 * The `/api` app's bindings with one live browser session. The session's account object answers every
 * call (recorded in `accountCalls`) so a probe gets past the gates into each family.
 */
export async function appProbe(): Promise<AppProbe> {
  const userId = 'e'.repeat(32);
  const token = `ps_${userId}_${'k'.repeat(64)}`;
  const tokenHash = await sha256Hex(token);
  const accountCalls: string[] = [];
  const workspaceCalls: string[] = [];

  const account = recording(accountCalls, (method, presented) => {
    if (method !== 'verifyBrowserSession') return gateAnswer(method);

    return presented === tokenHash
      ? { identity: { email: 'owner@example.com', sub: 'sub', provider: 'github', displayName: null, authTime: Date.now() } }
      : null;
  });

  // The workspace gate's claim succeeds: the session's user owns every name it presents.
  const workspace = recording(workspaceCalls, (method) => (method === 'claimOwner' ? { owner: userId, capabilityHash: null } : gateAnswer(method)));

  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, {
    AUTH_KV: makeKv(),
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: { idFromName: (name: string) => name, get: () => account },
    OrchestratorAgent: { idFromName: (name: string) => name, get: () => workspace },
    ASSETS: { fetch: async () => new Response('<!doctype html><html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) },
    PREVIEW_HOST_SUFFIX: 'kinu.example.com',
  });

  return {
    // SAFETY: this probe constructs every binding the app's gates read, and the doubles it constructs
    // for `UserDO`, `OrchestratorAgent` and `ASSETS` answer any call a family past them makes.
    env: partialEnv as Env,
    ctx: workerContext(),
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    accountCalls,
    workspaceCalls,
  };
}

/** One value per path parameter the /api routes declare; a regex param's sample must satisfy it. */
const PARAM_SAMPLES = new Map([
  ['name', 'jarvis'], ['id', 'device-1'], ['key', 'openai.bearer'], ['hash', 'a'.repeat(64)], ['run', 'run-1'],
  ['userId', 'b'.repeat(32)], ['ref', 'ci'],
]);

/** A concrete path a route pattern matches: each `:param` (with its `{regex}`) sampled, a trailing wildcard dropped. */
export function concretePath(pattern: string): string {
  const filled = pattern.replace(/:(\w+)(?:\{((?:[^{}]|\{[^{}]*\})*)\})?/g, (_whole, name: string, regex: string | undefined) => {
    const sample = present(PARAM_SAMPLES.get(name), `a sample for :${name} in ${pattern}`);

    if (regex !== undefined && !new RegExp(`^(?:${regex})$`).test(sample)) throw new Error(`${sample} does not match :${name}{${regex}} in ${pattern}`);

    return sample;
  });

  return filled.replace(/\/?\*$/, '');
}
