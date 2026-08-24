// A real UserDO over bun:sqlite.
//
// The class itself is plain TypeScript — its Durable Object base only supplies
// `ctx` and `env` — so with the Agent SDK stubbed it runs against an in-memory
// database. That lets the capability tests exercise the ACTUAL methods that
// guard the owner's credentials rather than a re-description of them.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { AgentContext } from 'agents';
import { mockAgentsSdk } from './agents-sdk';
import { sha256Hex } from '../../src/lib/crypto';
import { ownerCaller, type UserCaller } from '../../src/user/workspace-capability';
import type { SqlExec, SqlExecRow, SqlExecutor, SqlValue } from '@kinu.run/core';

mockAgentsSdk();

const { UserDO } = await import('../../src/user/user-do');
type UserDOInstance = InstanceType<typeof UserDO>;

/** A `SqlExec` over bun:sqlite — the same seam the Durable Object provides. */
export function sqlExec(db: Database): SqlExec {
  return {
    exec(query: string, ...bindings: SqlValue[]) {
      type NativeSqlValue = string | number | boolean | null | Uint8Array;
      type NativeSqlRow = Record<string, NativeSqlValue>;
      const bound: SQLQueryBindings[] = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const statement = db.prepare<NativeSqlRow, SQLQueryBindings[]>(query);
      if (statement.columnNames.length === 0) {
        statement.run(...bound);
        return { toArray: () => [] };
      }
      const rows: SqlExecRow[] = statement.all(...bound).map((row) => Object.fromEntries(
        Object.entries(row).map(([column, value]) => {
          if (!(value instanceof Uint8Array)) return [column, value];
          const copy = new Uint8Array(value.byteLength);
          copy.set(value);
          return [column, copy.buffer];
        }),
      ));
      return { toArray: () => rows };
    },
  };
}

/** The tagged-template `SqlExecutor` over bun:sqlite — the second of the two SQL
 *  protocols a Durable Object exposes, alongside {@link sqlExec}'s positional one.
 *  `reconcileColumns` needs this form: it binds the table name into
 *  `pragma_table_info(?)`. The row generic is threaded into `prepare` so the rows
 *  are typed at the boundary rather than asserted after the fact. */
export function taggedSql(db: Database): SqlExecutor {
  return function <T = unknown>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    const bound: SQLQueryBindings[] = values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const statement = db.prepare<T, SQLQueryBindings[]>(query);
    if (statement.columnNames.length === 0) {
      statement.run(...bound);
      return [];
    }
    return statement.all(...bound);
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

/** A fixed key so a harness DB written in one test opens in another. */
export const TEST_CREDENTIAL_ENCRYPTION_KEY = 'test-credential-encryption-key-0123456789';

/** The env every harness DO is built with — also what mints the owner
 *  capability tests present, so they exercise the real derivation. */
export const TEST_USER_ENV = { CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY };

export function testOwner(): Promise<UserCaller> {
  return ownerCaller(TEST_USER_ENV);
}

export interface TestUserDOOptions {
  /** Attach a connected device so the device plane is LIVE. Without one, every
   *  device call short-circuits on "no device connected" before reaching the
   *  consent path, which would leave that path untested. */
  connectedDeviceId?: string;
  /** Override the credential encryption key — rotation tests supply the key
   *  that succeeds the one the store was written under. */
  credentialEncryptionKey?: string;
  credentialEncryptionKeyPrevious?: string;
  /** Stand in for a different user's Durable Object. */
  durableObjectId?: string;
  /** Make workspace teardown fail at the real UserDO -> Orchestrator seam. */
  destroyWorkspaceError?: string;
}

interface TestUserEnvironment {
  CREDENTIAL_ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
  OrchestratorAgent: {
    idFromName(name: string): string;
    get(name: string): {
      destroyAgent(): Promise<void>;
      installWorkspaceCapability(token: string): Promise<{ readonly ok: true }>;
      getWorkspaceCapabilityHash(): Promise<string | null>;
      awaitDeviceConsent(request: { method: string }): Promise<TestUserDO['consentDecision']>;
    };
  };
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

  let consentDecision: TestUserDO['consentDecision'] = 'deny';

  const ctx = {
    // Sealed values are bound to the Durable Object's id, so the harness has
    // to have one — a fixed value, so a DB written in one test opens in another.
    id: {
      name: options.durableObjectId ?? 'test-user-do',
      toString: () => options.durableObjectId ?? 'test-user-do',
    },
    storage: { sql },
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  };
  const env: TestUserEnvironment = {
    // The credential store refuses to operate without its key, so a harness
    // exercising the real methods has to supply one exactly as a deployment does.
    CREDENTIAL_ENCRYPTION_KEY: options.credentialEncryptionKey ?? TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        async destroyAgent() {
          if (options.destroyWorkspaceError) throw new Error(options.destroyWorkspaceError);
          destroyedWorkspaces.push(name);
        },
        async installWorkspaceCapability(token: string) { installed.set(name, token); return { ok: true as const }; },
        async getWorkspaceCapabilityHash() {
          const token = installed.get(name);
          return token ? sha256Hex(token) : null;
        },
        async awaitDeviceConsent(request: { method: string }) {
          consentPrompts.push({ workspace: name, method: request.method });
          return consentDecision;
        },
      }),
    },
  };
  if (options.credentialEncryptionKeyPrevious) {
    env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = options.credentialEncryptionKeyPrevious;
  }
  const partialContext: Partial<AgentContext> = {};
  Object.assign(partialContext, ctx);
  // SAFETY: the Agent constructor contract stores this locally constructed
  // context, and UserDO only reads its provided id, SQL, and WebSocket members.
  const agentContext = partialContext as AgentContext;
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, env);
  // SAFETY: the UserDO dependency contract reads only the locally constructed
  // credential key and OrchestratorAgent binding in this harness.
  const userEnv = partialEnv as Env;
  const userDO = new UserDO(agentContext, userEnv);
  return {
    userDO, db, sql, installed, destroyedWorkspaces, consentPrompts,
    get consentDecision() { return consentDecision; },
    set consentDecision(decision) { consentDecision = decision; },
    close: () => db.close(),
  };
}

/** Register a workspace and provision its capability, returning the token the
 *  UserDO delivered into it — the same handshake `claimOwnedWorkspace` runs. */
export async function provisionTestWorkspace(harness: TestUserDO, name: string, displayName?: string): Promise<string> {
  await harness.userDO.registerWorkspace(await testOwner(), name, displayName ?? name);
  await harness.userDO.ensureWorkspaceCapability(name, null);
  const token = harness.installed.get(name);
  if (!token) throw new Error(`workspace ${name} was not provisioned`);
  return token;
}
