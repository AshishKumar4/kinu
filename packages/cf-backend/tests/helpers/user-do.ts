// A real UserDO over bun:sqlite.
//
// The class itself is plain TypeScript — its Durable Object base only supplies
// `ctx` and `env` — so with the Agent SDK stubbed it runs against an in-memory
// database. That lets the capability tests exercise the ACTUAL methods that
// guard the owner's credentials rather than a re-description of them.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { AgentContext } from 'agents';
import { joinHarnessFibers, mockAgentsSdk } from './agents-sdk';
import { sha256Hex } from '../../src/lib/crypto';
import { ownerCaller, type UserCaller } from '../../src/user/workspace-capability';
import type { WorkspaceEntry, WorkspaceRegistration } from '../../src/user/user-do';
import {
  DeviceConsentRegistry,
  JsonValueSchema,
  type DeviceConsentDecision,
  type DeviceConsentRequest,
  type DeviceConsentScope,
  type JsonValue,
  type SqlExec,
  type SqlExecRow,
  type SqlValue,
} from '@kinu.run/core';
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

export interface TestUserDO {
  userDO: UserDOInstance;
  db: Database;
  sql: SqlExec;
  /** Capability tokens the UserDO delivered, per workspace — the real flow
   *  installs straight into each workspace's own Durable Object. */
  installed: Map<string, string>;
  /** Workspace DOs the UserDO tore down (workspace delete). */
  destroyedWorkspaces: string[];
  /** Socket-revocation pushes the UserDO fanned out, as `workspace:generation`
   *  — how a test reads that a revocation reached the workspaces holding the
   *  sockets, rather than only the row it wrote. */
  revokedSocketPushes: string[];
  /** The same for a browser session, as `workspace:tokenHash`: a logout has to
   *  reach a socket that is only listening, and the hash is what names it. */
  revokedSessionPushes: string[];
  /** Capability re-pushes the UserDO asked a workspace root for, by workspace
   *  — the reconciliation retry, which only the root can run because only the
   *  root holds the token's plaintext. */
  capabilityRepushes: string[];
  /** Consent cards the UserDO raised, as raised — the workspace it asked on,
   *  the method, the words the owner would read. */
  consentPrompts: Array<{
    workspace: string;
    method: string;
    command: string;
    scope: DeviceConsentScope;
    workspaceName?: string;
  }>;
  /** Ids of the cards actually RAISED, in order. The registry mints one per
   *  distinct question, so an identical re-ask adds no entry here. */
  raisedConsentIds: string[];
  /** Device RPC frames that reached the socket — the observable difference
   *  between "consent let it through" and "consent stopped it". */
  deviceFrames: DeviceFrame[];
  /**
   * How a prompted workspace answers. Default: refuse.
   *
   * `hold` leaves the card WAITING, which is the only state in which a second
   * identical ask can be observed joining the first. `answerConsent` then
   * settles it, and every caller waiting on that one card settles with it.
   */
  consentDecision: 'once' | 'always' | 'deny' | 'hold';
  /** Answer every card left waiting by `hold`. */
  answerConsent(answer: 'once' | 'always' | 'deny'): void;
  /** Attach (or detach with null) the device this harness's live socket
   *  belongs to — the id `registerDevice` just minted. */
  attachDevice(deviceId: string | null): void;
  /** Sockets the UserDO accepted through its own upgrade path, with what it
   *  wrote to each — how a test reads the rotation frame the hub pushes. */
  acceptedSockets: Array<{ sent: string[] }>;
  /** Join device responder fibers before inspecting asynchronous effects. */
  joinFibers(): Promise<void>;
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
   *  is only observable when the far end answers.
   *
   *  A responder may answer LATER by returning a promise. That is how a test
   *  holds one frame open across another — a command's result withheld until
   *  after its cancellation — which is the ordering a real machine produces and
   *  an always-immediate double cannot. */
  deviceResponder?: (frame: DeviceFrame) => JsonValue | Promise<JsonValue>;
  /** Override the credential encryption key — rotation tests supply the key
   *  that succeeds the one the store was written under. */
  credentialEncryptionKey?: string;
  credentialEncryptionKeyPrevious?: string;
  /** Stand in for a different user's Durable Object. */
  durableObjectId?: string;
  /** Make workspace teardown fail at the real UserDO -> Orchestrator seam. */
  destroyWorkspaceError?: string;
  /** Hold the workspace teardown open at the real UserDO → Orchestrator seam.
   *  The only way to observe what a workspace marked for deletion can still do
   *  while its destroy is in flight, which is exactly the window the fence
   *  around that await exists to close. */
  destroyWorkspaceGate?: (name: string) => Promise<void>;
  /** Bring a new Durable Object up over storage a retired one wrote, which is
   *  what an eviction and the next request really are. Ownership of the handle
   *  stays with the caller: this harness's `close` leaves it open. */
  storage?: Database;
  /** How many subtree pushes a capability install (or its re-push) reports it
   *  MISSED. Asked per call, so a test can strand a replica on the first push
   *  and let the reconciliation retry converge on the next. */
  capabilityPushMissed?: () => number;
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
      installWorkspaceCapability(token: string): Promise<{ readonly ok: true; missed: number }>;
      repushWorkspaceCapability(): Promise<{ missed: number }>;
      getWorkspaceCapabilityHash(): Promise<string | null>;
      awaitDeviceConsent(request: DeviceConsentRequest): Promise<DeviceConsentDecision>;
      closeRevokedCliSockets(generation: number): Promise<{ closed: number }>;
      closeRevokedSessionSockets(tokenHash: string): Promise<{ closed: number }>;
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
  const db = options.storage ?? new Database(':memory:');
  const sql = sqlExec(db);
  const installed = new Map<string, string>();
  const destroyedWorkspaces: string[] = [];
  const revokedSocketPushes: string[] = [];
  const revokedSessionPushes: string[] = [];
  const capabilityRepushes: string[] = [];
  const consentPrompts: TestUserDO['consentPrompts'] = [];
  const raisedConsentIds: TestUserDO['raisedConsentIds'] = [];
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
      const owner = hub.current;
      if (!responder || !owner) return;
      // The daemon answers a method that throws with an error frame, so a double
      // that can only ever answer `result` cannot exercise a failing device call.
      // The harness fiber owns a delayed answer through the same durable lifecycle
      // production uses; tests join it before inspecting its asynchronous effects.
      return owner.runFiber('test:device-responder', async () => {
        try {
          const result = await responder(call);
          await owner.webSocketMessage(socket, JSON.stringify({ id: call.id, result }));
        } catch (cause) {
          await owner.webSocketMessage(socket, JSON.stringify({
            id: call.id, error: cause instanceof Error ? cause.message : String(cause),
          }));
        }
      });
    },
    close: () => {},
  };
  // Unchecked and named: the platform socket interface is wide and hibernation
  // is workerd-only, so a test cannot construct one. The double rides the
  // prototype the way helpers/jsrpc-stub.ts builds stubs; the hub reads only
  // the members above, which is the boundary under test.
  const socket: WebSocket = Object.create(socketBody);

  let consentDecision: TestUserDO['consentDecision'] = 'deny';

  /**
   * ONE registry per agent name, because that is what the runtime has: the real
   * `DeviceConsentRegistry` lives on the OrchestratorAgent DO, and it is the
   * authority that decides whether an identical re-ask is a second card or the
   * same one. A hand-rolled stub that answered every call could not express
   * that, so the dedupe used to be asserted against a caller-side check the
   * UserDO no longer performs.
   *
   * The card is answered from `announce` — the runtime's own synchronous-answer
   * path — unless `consentDecision` is `hold`, which leaves it waiting so a
   * second ask can be seen joining it.
   */
  const registries = new Map<string, DeviceConsentRegistry>();
  let mintedConsents = 0;
  const registryFor = (name: string): DeviceConsentRegistry => {
    const existing = registries.get(name);
    if (existing) return existing;
    const registry: DeviceConsentRegistry = new DeviceConsentRegistry({
      newId: () => `cons-${++mintedConsents}`,
      announce: (notice) => {
        if (notice.kind !== 'raised') return;
        const consent = notice.consent;
        raisedConsentIds.push(consent.consentId);
        const prompt: TestUserDO['consentPrompts'][number] = {
          workspace: name,
          method: consent.method,
          command: consent.command,
          scope: consent.scope,
        };
        if (consent.workspaceName) prompt.workspaceName = consent.workspaceName;
        consentPrompts.push(prompt);
        if (consentDecision !== 'hold') registry.resolve(consent.consentId, consentDecision);
      },
    });
    registries.set(name, registry);
    return registry;
  };

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
    // REAL, not a callback passthrough: `userMcp_add`/`userMcp_update` claim a
    // server name by reading and writing inside one `transactionSync`, and a
    // fake turns that atomic claim into a torn one that still reports success.
    storage: { sql, transactionSync: <T,>(closure: () => T): T => db.transaction(closure)() },
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
          if (options.destroyWorkspaceGate) await options.destroyWorkspaceGate(name);
          if (options.destroyWorkspaceError) throw new Error(options.destroyWorkspaceError);
          destroyedWorkspaces.push(name);
        },
        async installWorkspaceCapability(token: string) {
          installed.set(name, token);
          return { ok: true as const, missed: options.capabilityPushMissed?.() ?? 0 };
        },
        /** The root re-running its own subtree push with the token it already
         *  holds. Nothing is re-minted, which is the point: the same token, the
         *  same hash, one more attempt at the replicas that missed it. */
        async repushWorkspaceCapability() {
          capabilityRepushes.push(name);
          return { missed: options.capabilityPushMissed?.() ?? 0 };
        },
        async getWorkspaceCapabilityHash() {
          const token = installed.get(name);
          return token ? sha256Hex(token) : null;
        },
        awaitDeviceConsent(request: DeviceConsentRequest) {
          return registryFor(name).request(request);
        },
        async closeRevokedCliSockets(generation: number) {
          revokedSocketPushes.push(`${name}:${generation}`);
          return { closed: 0 };
        },
        async closeRevokedSessionSockets(tokenHash: string) {
          revokedSessionPushes.push(`${name}:${tokenHash}`);
          return { closed: 0 };
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
  hub.current = userDO;
  return {
    userDO, db, sql, installed, destroyedWorkspaces, revokedSocketPushes,
    revokedSessionPushes, capabilityRepushes,
    consentPrompts, raisedConsentIds, deviceFrames,
    get consentDecision() { return consentDecision; },
    set consentDecision(decision) { consentDecision = decision; },
    answerConsent: (answer) => {
      for (const registry of registries.values()) {
        for (const waiting of registry.list()) registry.resolve(waiting.consentId, answer);
      }
    },
    attachDevice: (deviceId) => { attached = deviceId; },
    get acceptedSockets() { return ACCEPTED_SOCKETS.slice(acceptedFrom); },
    joinFibers: joinHarnessFibers,
    close: () => { if (!options.storage) db.close(); },
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

/** The entry a register INSERTED. A status other than `created` fails here,
 *  where the register happened, instead of surfacing as an undefined read
 *  further down a test. */
export function createdWorkspace(registration: WorkspaceRegistration): WorkspaceEntry {
  if (registration.status !== 'created') {
    throw new Error(`expected registerWorkspace to insert a row, got "${registration.status}"`);
  }
  return registration.entry;
}
