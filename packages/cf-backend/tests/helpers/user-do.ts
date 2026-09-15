// A real UserDO over bun:sqlite.
//
// The class itself is plain TypeScript — its Durable Object base only supplies
// `ctx` and `env` — so with the Agent SDK stubbed it runs against an in-memory
// database. That lets the capability tests exercise the ACTUAL methods that
// guard the owner's credentials rather than a re-description of them.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { AgentContext } from 'agents';
import { joinHarnessFibers, mockAgentsSdk, rememberMcpManager, inheritedMcpManager } from './agents-sdk';
import { sha256Hex } from '@kinu.run/core';
import { ownerCaller, type UserCaller } from '@kinu.run/core';
import type { WorkspaceEntry, WorkspaceRegistration } from '../../src/user/user-do';
import {
  DeviceConsentRegistry,
  DeviceConsentStore,
  initDeviceConsentRequestsTable,
  JsonValueSchema,
  type DeviceConsentDecision,
  type DeviceConsentRequest,
  type JsonValue,
  type SqlExec,
  type SqlExecRow,
  type SqlValue,
} from '@kinu.run/core';
import { makeExecRaw, makeSql } from '../../../core/tests/helpers';
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
  /** Reasons the UserDO aborted its own context with — the SDK's `destroy()`
   *  ends in `ctx.abort('destroyed')` on the next tick, and an account delete
   *  is only complete once that sentinel has been raised. */
  aborted: string[];
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
    workspaceName?: string;
  }>;
  /** Ids of the cards actually RAISED, in order. The registry mints one per
   *  distinct question, so an identical re-ask adds no entry here. */
  raisedConsentIds: string[];
  /** Device-offline notices the UserDO fanned out, per workspace — the frames
   *  a refused device call sends the workspace's own socket. */
  unavailableNotices: Array<{ workspace: string; devices: Array<{ id: string; label: string; lastSeenAt: number | null }> }>;
  /** Device-connect notices the UserDO fanned out, per workspace. */
  availableNotices: Array<{ workspace: string; device: { id: string; label: string } }>;
  /** Device RPC frames that reached the socket — the observable difference
   *  between "consent let it through" and "consent stopped it". */
  deviceFrames: DeviceFrame[];
  /** Frames the hub pushed to a device that are not calls: the UPDATE a
   *  HELLO earns, with the device it went to. */
  devicePushes: DevicePush[];
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
  /** The cards still up on one workspace's OrchestratorAgent — what a client
   *  re-render reads after a reload, and what an activation that never saw
   *  the raise still owes the owner. */
  pendingConsents(workspace: string): Array<{ consentId: string }>;
  /** The owner's click, at the registry the card is waiting on — the same
   *  resolution `resolveDeviceConsent` runs over RPC. */
  resolveConsent(workspace: string, consentId: string, answer: 'once' | 'always' | 'deny'): { ok: boolean };
  /** Attach (or detach with null) the device this harness's live socket
   *  belongs to — the id `registerDevice` just minted. */
  attachDevice(deviceId: string | null): void;
  /** Deliver a HELLO the way a daemon does — through the real socket handler,
   *  so what the hub records is what a machine could actually make it record.
   *  The frame is passed as sent, unvalidated here, because a daemon that sends
   *  a field this build does not know is exactly the case worth testing.
   *  `deviceId` targets one of `attachDaemon`'s sockets; absent, the harness's
   *  own single socket. */
  sendDeviceHello(hello: JsonValue, deviceId?: string): Promise<void>;
  /**
   * A second, third… fake daemon, each bound to ONE machine — the fleet. Each
   * has its own live socket the hub tags by that device id, its own frame log,
   * and a far-end `close()` that goes through the real `webSocketClose`
   * handler, exactly as a machine leaving does. `deviceFrames` records every
   * daemon's frames too, tagged with the device they reached. The harness's
   * own `attachDevice` socket is untouched: a one-machine suite never sees
   * these.
   */
  attachDaemon(deviceId: string): FakeDaemon;
  /** Sockets the UserDO accepted through its own upgrade path, with what it
   *  wrote to each — how a test reads the rotation frame the hub pushes.
   *  `drop` closes one from the far end, which is what makes a redial
   *  legitimate: the hub refuses a second claimant while a socket is live.
   *  `ws` is the socket itself, for driving a daemon-sent frame through
   *  `webSocketMessage` the way the runtime delivers one. */
  acceptedSockets: Array<{ sent: string[]; drop(): void; ws: WebSocket }>;
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
  /** What the deployment publishes under `/downloads/`: the build stamp and
   *  the CLI artifacts' checksums, served through the `ASSETS` binding the
   *  hub reads for a device's UPDATE decision. Absent means a deployment
   *  that published no stamp — the hub then pushes nothing. */
  servedBuild?: { version: string; checksums?: Record<string, string> };
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
   *  around that await exists to close — or to route the call at a REAL
   *  workspace object a test built, with the caller-supplied owner id intact. */
  destroyWorkspaceGate?: (name: string, ownerUserId: string) => Promise<void>;
  /** Bring a new Durable Object up over storage a retired one wrote, which is
   *  what an eviction and the next request really are. Ownership of the handle
   *  stays with the caller: this harness's `close` leaves it open. */
  storage?: Database;
  /** How many subtree pushes a capability install (or its re-push) reports it
   *  MISSED. Asked per call, so a test can strand a replica on the first push
   *  and let the reconciliation retry converge on the next. */
  capabilityPushMissed?: () => number;
  /** Which `oauth-app` presets the deployment pretends to carry the
   *  registered app for — preset ids (`'github'`, `'google'`), filled with
   *  fixed test values under the keys `MCP_APP_ENV` names. Absent means no
   *  preset app is configured. */
  mcpAppCredentials?: readonly string[];
}

export interface FakeDaemon {
  readonly deviceId: string;
  /** Frames the hub sent to THIS machine, in order. */
  readonly frames: DeviceFrame[];
  /** Leave, from the far end: the socket reads closed and the hub's close
   *  handler runs, as it does when a daemon's process ends. */
  close(): Promise<void>;
}

/** One JSON-RPC frame as the hub's tunnel writes it onto the device socket. */
export interface DeviceFrame {
  id: string;
  method: string;
  params: JsonValue[];
  /** The machine this frame reached, when the harness holds several (a
   *  socket from `attachDaemon`). Absent on the harness's own single socket. */
  device?: string;
  /** The id the hub stamped ON the frame — the wire's own statement of which
   *  machine it is for, read back so a test can hold the hub to it. */
  deviceId?: string;
  /** The sandbox frame the hub computed for this command, which the daemon
   *  enforces. It rides beside `id`/`method`/`params` because `DeviceTunnel`
   *  SPREADS its `extra` into the frame. Recorded because a decision the hub
   *  makes on the way out is invisible in the params: they are the same
   *  whether or not the command was sandboxed. */
  sandbox?: JsonValue;
}

const DeviceFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.optional(v.array(JsonValueSchema)),
  sandbox: v.optional(JsonValueSchema),
  deviceId: v.optional(v.string()),
});

/** A pushed frame: typed by its `type` word, the rest kept as sent. */
const DevicePushSchema = v.looseObject({ type: v.string() });

export interface DevicePush extends v.InferOutput<typeof DevicePushSchema> {
  device: string | null;
}

/**
 * The static-asset bundle as the UserDO's `ASSETS` binding reads it: the build
 * stamp and the checksum files, or the SPA shell for anything else — which is
 * what a deployment answers for a file it never published, and what the
 * asset reader refuses.
 */
function servedAsset(pathname: string, build: TestUserDOOptions['servedBuild']): Response {
  if (build && pathname === '/downloads/kinu-version.json') {
    return Response.json({ version: build.version, sha: 'sha', builtAt: '2026-09-15T00:00:00Z' });
  }

  const checksum = build?.checksums?.[pathname.replace(/\.sha256$/, '')];

  if (build && pathname.endsWith('.sha256') && checksum !== undefined) {
    return new Response(`${checksum}  ${pathname.slice('/downloads/'.length, -'.sha256'.length)}\n`);
  }

  return new Response('<!doctype html><title>Kinu</title>', { status: 200, headers: { 'content-type': 'text/html' } });
}

interface TestUserEnvironment {
  CREDENTIAL_ENCRYPTION_KEY: string;
  CLI_PUBLIC_ORIGIN?: string;
  ASSETS?: { fetch(input: Request): Promise<Response> };
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
  MCP_GITHUB_CLIENT_ID?: string;
  MCP_GITHUB_CLIENT_SECRET?: string;
  MCP_GOOGLE_CLIENT_ID?: string;
  MCP_GOOGLE_CLIENT_SECRET?: string;
  OrchestratorAgent: {
    idFromName(name: string): string;
    get(name: string): {
      destroyAgent(ownerUserId: string): Promise<void>;
      installWorkspaceCapability(token: string): Promise<{ readonly ok: true; missed: number }>;
      repushWorkspaceCapability(): Promise<{ missed: number }>;
      getWorkspaceCapabilityHash(): Promise<string | null>;
      awaitDeviceConsent(request: DeviceConsentRequest): Promise<DeviceConsentDecision>;
      announceDeviceUnavailable(devices: Array<{ id: string; label: string; lastSeenAt: number | null }>): Promise<{ ok: boolean }>;
      announceDeviceAvailable(device: { id: string; label: string }): Promise<{ ok: boolean }>;
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
const ACCEPTED_SOCKETS: Array<{ sent: string[]; drop(): void; ws: WebSocket }> = [];

/**
 * The workspace objects' own storages, keyed on the harness database whose
 * lifetime they share. A Durable Object is ephemeral over durable storage;
 * `createTestUserDO({ storage })` re-keys here so a re-instantiated harness
 * meets the same OrchestratorAgent stores its predecessor wrote, which is the
 * only durable half of a consent card the production seam keeps.
 */
const CONSENT_STORES = new WeakMap<Database, Map<string, DeviceConsentStore>>();

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

        const server = {
          readyState: 1,
          send: (data: string) => { sent.push(data); },
          close: () => { server.readyState = 3; },
          serializeAttachment: (value: JsonValue) => { attachment = value; },
          deserializeAttachment: () => attachment,
        };

        // Delegates every member to `server`, so `drop` below is visible
        // through it. Same construction as the fixture socket further down:
        // the UserDO reads a device socket only through send, close,
        // readyState and the two attachment members.
        const ws: WebSocket = Object.create(server);
        ACCEPTED_SOCKETS.push({ sent, drop: () => { server.readyState = 3; }, ws });
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
  const aborted: string[] = [];
  const revokedSocketPushes: string[] = [];
  const revokedSessionPushes: string[] = [];
  const capabilityRepushes: string[] = [];
  const consentPrompts: TestUserDO['consentPrompts'] = [];
  const raisedConsentIds: TestUserDO['raisedConsentIds'] = [];
  const unavailableNotices: TestUserDO['unavailableNotices'] = [];
  const availableNotices: TestUserDO['availableNotices'] = [];
  const deviceFrames: DeviceFrame[] = [];
  const devicePushes: DevicePush[] = [];

  /** A frame the hub pushed that is not an RPC call — HELLO's answers such as
   *  UPDATE — recorded with the socket it went to. */
  const recordPush = (data: string, device: string | null): boolean => {
    const push = v.safeParse(DevicePushSchema, JSON.parse(data));

    if (!push.success) return false;
    devicePushes.push({ ...push.output, device });

    return true;
  };

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
      if (recordPush(data, attached)) return;
      const frame = v.safeParse(DeviceFrameSchema, JSON.parse(data));

      if (!frame.success) return;
      const call: DeviceFrame = { id: frame.output.id, method: frame.output.method, params: frame.output.params ?? [] };

      if (frame.output.sandbox !== undefined) call.sandbox = frame.output.sandbox;

      if (frame.output.deviceId !== undefined) call.deviceId = frame.output.deviceId;
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
   * same one. A hand-rolled stub answering every call could not express that,
   * so the dedupe would end up asserted against a caller-side check the UserDO
   * does not perform.
   *
   * The card is answered from `announce` — the runtime's own synchronous-answer
   * path — unless `consentDecision` is `hold`, which leaves it waiting so a
   * second ask can be seen joining it.
   */
  const registries = new Map<string, DeviceConsentRegistry>();
  let mintedConsents = 0;

  /**
   * A Durable Object's storage outlives the object. These are the
   * OrchestratorAgents' consent stores, one database per workspace name,
   * keyed on THIS object store's lifetime: a revived UserDO over the same
   * `db` meets the same workspace storages, which is the eviction-then-next-
   * request shape the platform actually produces.
   */
  const consentStores = CONSENT_STORES.get(db) ?? new Map<string, DeviceConsentStore>();
  CONSENT_STORES.set(db, consentStores);

  const storeFor = (name: string): DeviceConsentStore => {
    const existing = consentStores.get(name);

    if (existing) return existing;

    const storage = new Database(':memory:');
    initDeviceConsentRequestsTable(makeExecRaw(storage));
    const store = new DeviceConsentStore(makeSql(storage));
    consentStores.set(name, store);

    return store;
  };

  const registryFor = (name: string): DeviceConsentRegistry => {
    const existing = registries.get(name);

    if (existing) return existing;

    const registry: DeviceConsentRegistry = new DeviceConsentRegistry({
      store: storeFor(name),
      newId: () => `cons-${++mintedConsents}`,
      announce: (notice) => {
        if (notice.kind !== 'raised') return;
        const consent = notice.consent;
        raisedConsentIds.push(consent.consentId);

        const prompt: TestUserDO['consentPrompts'][number] = {
          workspace: name,
          method: consent.method,
          command: consent.command,
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
  const live: Array<{ ws: typeof socket; tags: string[] }> = [];
  /** The fleet's fake daemons, by device id, each with its own socket. */
  const daemons: Array<{ deviceId: string; ws: WebSocket; frames: DeviceFrame[] }> = [];

  /** The tags a socket answers to, as the platform would report them: the
   *  ones it was accepted with, or — for the attachment-bound fakes — the
   *  device tag its attachment implies. */
  const tagsOf = (ws: WebSocket): string[] => {
    const accepted = live.find((entry) => entry.ws === ws);

    if (accepted) return accepted.tags;
    const attachment = v.safeParse(v.object({ device: v.nullable(v.string()) }), ws.deserializeAttachment());

    return attachment.success && attachment.output.device !== null ? [`device:${attachment.output.device}`] : [];
  };

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
    storage: {
      sql,
      transactionSync: <T,>(closure: () => T): T => db.transaction(closure)(),
      // The SDK's `destroy()` runs these two before the abort. `deleteAll` on
      // the platform takes every table and every key; over bun:sqlite the
      // tables are the whole of what the UserDO wrote, so dropping each one is
      // the same observable end state — a fresh object over this database
      // recreates them empty, as a fresh activation would.
      deleteAlarm: async (): Promise<void> => {},
      deleteAll: async (): Promise<void> => {
        // Virtual tables first: dropping an FTS table takes its shadow tables
        // with it, and a shadow dropped on its own leaves the virtual table
        // undroppable. `IF EXISTS` covers the shadows the first pass removed.
        const tables = db.query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY CASE WHEN sql LIKE 'CREATE VIRTUAL%' THEN 0 ELSE 1 END, name`,
        ).all();

        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      },
    },
    abort: (reason: string): void => { aborted.push(reason); },
    // Tag-filtered, as the platform's is: a hub asking for `device:<id>` gets
    // THAT machine's socket and no other. A tag-blind answer here would hand
    // one machine's tunnel another machine's socket — a flap the real hub
    // does not have, so the harness must not have it either.
    getWebSockets: (tag?: string) => {
      const all = [...(attached === null ? [] : [socket]), ...live.map((entry) => entry.ws), ...daemons.map((d) => d.ws)];

      return tag === undefined ? all : all.filter((ws) => tagsOf(ws).includes(tag));
    },
    acceptWebSocket: (ws: typeof socket, tags: string[] = []) => { live.push({ ws, tags }); },
  };

  const env: TestUserEnvironment = {
    // The credential store refuses to operate without its key, so a harness
    // exercising the real methods has to supply one exactly as a deployment does.
    CREDENTIAL_ENCRYPTION_KEY: options.credentialEncryptionKey ?? TEST_CREDENTIAL_ENCRYPTION_KEY,
    CLI_PUBLIC_ORIGIN: 'https://kinu.example.com',
    ASSETS: { fetch: async (input: Request) => servedAsset(new URL(input.url).pathname, options.servedBuild) },
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        async destroyAgent(ownerUserId: string) {
          if (options.destroyWorkspaceGate) await options.destroyWorkspaceGate(name, ownerUserId);

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
        async announceDeviceUnavailable(devices: TestUserDO['unavailableNotices'][number]['devices']) {
          unavailableNotices.push({ workspace: name, devices });

          return { ok: true };
        },
        async announceDeviceAvailable(device: { id: string; label: string }) {
          availableNotices.push({ workspace: name, device });

          return { ok: true };
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

  for (const preset of options.mcpAppCredentials ?? []) {
    if (preset === 'github') {
      env.MCP_GITHUB_CLIENT_ID = 'test-github-client-id';
      env.MCP_GITHUB_CLIENT_SECRET = 'test-github-client-secret';
    } else if (preset === 'google') {
      env.MCP_GOOGLE_CLIENT_ID = 'test-google-client-id';
      env.MCP_GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
    }
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
  rememberMcpManager(inheritedMcpManager(userDO));
  hub.current = userDO;

  return {
    userDO, db, sql, installed, destroyedWorkspaces, aborted, revokedSocketPushes,
    revokedSessionPushes, capabilityRepushes,
    pendingConsents: (workspace) => registryFor(workspace).list(),
    resolveConsent: (workspace, consentId, answer) => ({ ok: registryFor(workspace).resolve(consentId, answer) }),
    consentPrompts, raisedConsentIds, unavailableNotices, availableNotices, deviceFrames, devicePushes,
    get consentDecision() { return consentDecision; },
    set consentDecision(decision) { consentDecision = decision; },
    answerConsent: (answer) => {
      for (const registry of registries.values()) {
        for (const waiting of registry.list()) registry.resolve(waiting.consentId, answer);
      }
    },
    sendDeviceHello: (hello, deviceId) => {
      const target = deviceId === undefined ? socket : daemons.find((d) => d.deviceId === deviceId)?.ws;

      if (!target) throw new Error(`no fake daemon is attached for ${deviceId}`);

      return userDO.webSocketMessage(target, JSON.stringify(hello));
    },
    attachDevice: (deviceId) => { attached = deviceId; },
    attachDaemon: (deviceId) => {
      const frames: DeviceFrame[] = [];
      // The same shape as the harness's own socket, bound to ONE machine: the
      // attachment is fixed, so the hub tags and routes it as that device
      // and nothing else, and the responder answers on this very socket.
      // A real attachment, because the hub keeps the machine's toolchain
      // probe THERE: a no-op store would make every status read ask the
      // machine again, and two reads of one unchanged fleet would differ.
      let attachment: JsonValue = { device: deviceId };

      const body = {
        readyState: 1,
        deserializeAttachment: () => attachment,
        serializeAttachment: (value: JsonValue) => { attachment = value; },
        send: (data: string) => {
          if (recordPush(data, deviceId)) return;
          const frame = v.safeParse(DeviceFrameSchema, JSON.parse(data));

          if (!frame.success) return;

          const call: DeviceFrame = {
            id: frame.output.id, method: frame.output.method, params: frame.output.params ?? [], device: deviceId,
          };

          if (frame.output.sandbox !== undefined) call.sandbox = frame.output.sandbox;

          if (frame.output.deviceId !== undefined) call.deviceId = frame.output.deviceId;
          frames.push(call);
          deviceFrames.push(call);
          const responder = options.deviceResponder;
          const owner = hub.current;

          if (!responder || !owner) return;

          return owner.runFiber('test:device-responder', async () => {
            try {
              const result = await responder(call);
              await owner.webSocketMessage(ws, JSON.stringify({ id: call.id, result }));
            } catch (cause) {
              await owner.webSocketMessage(ws, JSON.stringify({
                id: call.id, error: cause instanceof Error ? cause.message : String(cause),
              }));
            }
          });
        },
        close: () => { body.readyState = 3; },
      };

      // Same construction as the harness socket above: the hub reads only the
      // members the body declares, which is the boundary under test.
      const ws: WebSocket = Object.create(body);
      daemons.push({ deviceId, ws, frames });

      return {
        deviceId,
        frames,
        close: async () => {
          body.readyState = 3;
          const at = daemons.findIndex((d) => d.ws === ws);

          if (at !== -1) daemons.splice(at, 1);
          await userDO.webSocketClose(ws, 1000, 'daemon left', true);
        },
      };
    },
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
