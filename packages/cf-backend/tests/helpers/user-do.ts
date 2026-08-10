// A real UserDO over bun:sqlite.
//
// The class itself is plain TypeScript — its Durable Object base only supplies
// `ctx` and `env` — so with the Agent SDK stubbed it runs against an in-memory
// database. That lets the capability tests exercise the ACTUAL methods that
// guard the owner's credentials rather than a re-description of them.
import { Database } from 'bun:sqlite';
import { mockAgentsSdk } from './agents-sdk.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import type { SqlExec } from '@proteus/core';

mockAgentsSdk();

const { UserDO } = await import('../../src/user/user-do.js');
type UserDOInstance = InstanceType<typeof UserDO>;

/** A `SqlExec` over bun:sqlite — the same seam the Durable Object provides. */
export function sqlExec(db: Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const trimmed = query.trim().toUpperCase();
      const reads = trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA');
      if (reads) return { toArray: () => statement.all(...(bindings as never[])) as Array<Record<string, unknown>> };
      statement.run(...(bindings as never[]));
      return { toArray: () => [] as Array<Record<string, unknown>> };
    },
  };
}

export interface TestUserDO {
  userDO: UserDOInstance;
  db: Database;
  sql: SqlExec;
  /** Capability tokens the UserDO delivered, per workspace — the real flow
   *  installs straight into each workspace's own Durable Object. */
  installed: Map<string, string>;
  /** Workspace DOs the UserDO tore down (workspace delete). */
  destroyedWorkspaces: string[];
  /** Consent cards the UserDO raised, and on which workspace. */
  consentPrompts: Array<{ workspace: string; method: string }>;
  /** How a prompted workspace answers. Default: refuse. */
  consentDecision: 'once' | 'always' | 'deny';
  close(): void;
}

export interface TestUserDOOptions {
  /** Attach a connected device so the device plane is LIVE. Without one, every
   *  device call short-circuits on "no device connected" before reaching the
   *  consent path, which would leave that path untested. */
  connectedDeviceId?: string;
}

export function createTestUserDO(options: TestUserDOOptions = {}): TestUserDO {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  const installed = new Map<string, string>();
  const destroyedWorkspaces: string[] = [];
  const consentPrompts: Array<{ workspace: string; method: string }> = [];

  // The device hub reads liveness off hibernatable sockets tagged by device id.
  const sockets = options.connectedDeviceId
    ? [{
        readyState: 1,
        deserializeAttachment: () => ({ device: options.connectedDeviceId }),
        serializeAttachment: () => {},
        send: () => {},
        close: () => {},
      }]
    : [];

  const harness = {
    db, sql, installed, destroyedWorkspaces, consentPrompts,
    consentDecision: 'deny' as TestUserDO['consentDecision'],
    close: () => db.close(),
  } as TestUserDO;

  const ctx = {
    storage: { sql },
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  };
  const env = {
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        async destroyAgent() { destroyedWorkspaces.push(name); },
        async installWorkspaceCapability(token: string) { installed.set(name, token); return { ok: true as const }; },
        async getWorkspaceCapabilityHash() {
          const token = installed.get(name);
          return token ? sha256Hex(token) : null;
        },
        async awaitDeviceConsent(request: { method: string }) {
          consentPrompts.push({ workspace: name, method: request.method });
          return harness.consentDecision;
        },
      }),
    },
  };
  harness.userDO = new (UserDO as unknown as new (ctx: unknown, env: unknown) => UserDOInstance)(ctx, env);
  return harness;
}

/** Register a workspace and provision its capability, returning the token the
 *  UserDO delivered into it — the same handshake `claimOwnedWorkspace` runs. */
export async function provisionTestWorkspace(harness: TestUserDO, name: string, displayName?: string): Promise<string> {
  const { OWNER_SESSION } = await import('../../src/user/workspace-capability.js');
  await harness.userDO.registerWorkspace(OWNER_SESSION, name, displayName ?? name);
  await harness.userDO.ensureWorkspaceCapability(name, null);
  const token = harness.installed.get(name);
  if (!token) throw new Error(`workspace ${name} was not provisioned`);
  return token;
}
