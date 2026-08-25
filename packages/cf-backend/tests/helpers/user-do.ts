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
import { JsonValueSchema, type JsonValue, type SqlExec, type SqlExecRow, type SqlExecutor, type SqlValue } from '@kinu.run/core';
import * as v from 'valibot';

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
  /** Consent cards the UserDO raised, as raised — the workspace it asked on,
   *  the method, the words the owner would read. */
  consentPrompts: Array<{ workspace: string; method: string; command: string; workspaceName?: string }>;
  /** Cards a client would still be showing. The UserDO reads this before
   *  raising a provisioning request, so a test can prove the dedupe. */
  pendingConsents: Array<{ consentId: string; method: string }>;
  /** Device RPC frames that reached the socket — the observable difference
   *  between "consent let it through" and "consent stopped it". */
  deviceFrames: DeviceFrame[];
  /** How a prompted workspace answers. Default: refuse. */
  consentDecision: 'once' | 'always' | 'deny';
  /** Attach (or detach with null) the device this harness's live socket
   *  belongs to — the id `registerDevice` just minted. */
  attachDevice(deviceId: string | null): void;
  /** Sockets the UserDO accepted through its own upgrade path, with what it
   *  wrote to each — how a test reads the rotation frame the hub pushes. */
  acceptedSockets: Array<{ sent: string[] }>;
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
  /** Answer device RPC frames the way the daemon does, so a call that PASSES
   *  consent completes instead of hanging on a socket nobody listens to. The
   *  difference between "the grant let it through" and "the grant did nothing"
   *  is only observable when the far end answers. */
  deviceResponder?: (frame: DeviceFrame) => JsonValue;
  /** Override the credential encryption key — rotation tests supply the key
   *  that succeeds the one the store was written under. */
  credentialEncryptionKey?: string;
  credentialEncryptionKeyPrevious?: string;
  /** Stand in for a different user's Durable Object. */
  durableObjectId?: string;
  /** Make workspace teardown fail at the real UserDO -> Orchestrator seam. */
  destroyWorkspaceError?: string;
}

/** One JSON-RPC frame as the hub's tunnel writes it onto the device socket. */
export interface DeviceFrame {
  id: string;
  method: string;
  params: JsonValue[];
}

const DeviceFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.optional(v.array(JsonValueSchema)),
});

interface TestUserEnvironment {
  CREDENTIAL_ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
  OrchestratorAgent: {
    idFromName(name: string): string;
    get(name: string): {
      destroyAgent(): Promise<void>;
      installWorkspaceCapability(token: string): Promise<{ readonly ok: true }>;
      getWorkspaceCapabilityHash(): Promise<string | null>;
      awaitDeviceConsent(request: {
        method: string; command: string; workspaceName?: string;
      }): Promise<TestUserDO['consentDecision']>;
      listPendingConsents(): Promise<TestUserDO['pendingConsents']>;
    };
  };
}

/**
 * workerd hands a Durable Object a socket PAIR; bun has none, so the suite
 * supplies the same two-object shape and records what the hub writes to the
 * server end. That is how a test reads the token-rotation frame, which exists
 * only on the accepted socket and deliberately never in a URL or a log.
 *
 * `new WebSocketPair()` is reached through a global, and other suites install
 * their own fake into it, so this one is (re)installed by every harness that is
 * built — the harness about to drive an accept is the one whose recorder must
 * be current. The registry is process-wide for the same reason, and each
 * harness reads only the slice accepted after its own construction.
 */
const ACCEPTED_SOCKETS: Array<{ sent: string[] }> = [];

function installRecordingSocketPair(): void {
  Object.defineProperty(globalThis, 'WebSocketPair', {
    configurable: true,
    writable: true,
    value: class {
      readonly 0: unknown;
      readonly 1: unknown;
      constructor() {
        const sent: string[] = [];
        let attachment: JsonValue = null;
        ACCEPTED_SOCKETS.push({ sent });
        const server = {
          readyState: 1,
          send: (data: string) => { sent.push(data); },
          close: () => { server.readyState = 3; },
          serializeAttachment: (value: JsonValue) => { attachment = value; },
          deserializeAttachment: () => attachment,
        };
        this[0] = { readyState: 1 };
        this[1] = server;
      }
    },
  });
}

export function createTestUserDO(options: TestUserDOOptions = {}): TestUserDO {
  installRecordingSocketPair();
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  const installed = new Map<string, string>();
  const destroyedWorkspaces: string[] = [];
  const consentPrompts: TestUserDO['consentPrompts'] = [];
  const pendingConsents: TestUserDO['pendingConsents'] = [];
  const deviceFrames: DeviceFrame[] = [];
  // Bound after construction: the socket answers THROUGH the object that owns
  // it, exactly as the runtime's own message handler does.
  /** Late-bound self reference: the socket answers THROUGH the object that
   *  owns it, so it cannot be captured before construction finishes. */
  interface DOHub { current: UserDOInstance | null }

  const hub: DOHub = { current: null };

  // The device hub reads liveness off hibernatable sockets tagged by device id.
  // Which device this socket belongs to is settable, because the id only exists
  let attached = options.connectedDeviceId ?? null;
  const socketBody = {
    readyState: 1,
    deserializeAttachment: () => ({ device: attached }),
    serializeAttachment: () => {},
    send: (data: string) => {
      const frame = v.safeParse(DeviceFrameSchema, JSON.parse(data));
      if (!frame.success) return;
      const call: DeviceFrame = { id: frame.output.id, method: frame.output.method, params: frame.output.params ?? [] };
      deviceFrames.push(call);
      const responder = options.deviceResponder;
      if (!responder) return;
      void hub.current?.webSocketMessage(
        socket,
        JSON.stringify({ id: call.id, result: responder(call) }),
      );
    },
    close: () => {},
  };
  // Unchecked and named: the platform socket interface is wide and hibernation
  // is workerd-only, so a test cannot construct one. The double rides the
  // prototype the way helpers/jsrpc-stub.ts builds stubs; the hub reads only
  // the members above, which is the boundary under test.
  const socket: WebSocket = Object.create(socketBody);

  let consentDecision: TestUserDO['consentDecision'] = 'deny';

  // The socket pair is installed once per process (see ACCEPTED_SOCKETS below);
  // this harness reads only the sockets accepted after its own construction.
  const acceptedFrom = ACCEPTED_SOCKETS.length;
  const live: Array<typeof socket> = [];

  const ctx = {
    // Sealed values are bound to the Durable Object's id, so the harness has
    // to have one — a fixed value, so a DB written in one test opens in another.
    id: {
      name: options.durableObjectId ?? 'test-user-do',
      toString: () => options.durableObjectId ?? 'test-user-do',
    },
    storage: { sql },
    getWebSockets: () => [...(attached === null ? [] : [socket]), ...live],
    acceptWebSocket: (ws: typeof socket) => { live.push(ws); },
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
        async awaitDeviceConsent(request: { method: string; command: string; workspaceName?: string }) {
          const prompt: TestUserDO['consentPrompts'][number] = {
            workspace: name,
            method: request.method,
            command: request.command,
          };
          if (request.workspaceName) prompt.workspaceName = request.workspaceName;
          consentPrompts.push(prompt);
          return consentDecision;
        },
        async listPendingConsents() { return pendingConsents; },
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
  hub.current = userDO;
  return {
    userDO, db, sql, installed, destroyedWorkspaces, consentPrompts, pendingConsents, deviceFrames,
    get consentDecision() { return consentDecision; },
    set consentDecision(decision) { consentDecision = decision; },
    attachDevice: (deviceId) => { attached = deviceId; },
    get acceptedSockets() { return ACCEPTED_SOCKETS.slice(acceptedFrom); },
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
