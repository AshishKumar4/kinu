// A real UserDO over bun:sqlite: the class only needs `ctx`/`env` from its DO base,
// so capability tests exercise the actual credential-guarding methods.
import { AwaitedList } from '@kinu.run/test-utils';
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
  type MossaicVfs,
  type SqlExecRow,
  type SqlValue,
} from '@kinu.run/core';
import { makeExecRaw, makeSql } from '../../../core/tests/helpers';
import * as v from 'valibot';

mockAgentsSdk();

const { UserDO } = await import('../../src/user/user-do');

type UserDOInstance = InstanceType<typeof UserDO>;

/** The real UserDO with only its SDK-constructed Drive plane faked. */
class DriveHarnessUserDO extends UserDO {
  constructor(ctx: AgentContext, env: Env, private readonly drives: (tenant: string) => MossaicVfs | null) {
    super(ctx, env);
  }

  protected override driveFor(tenant: string): MossaicVfs | null {
    return this.drives(tenant);
  }
}

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
  /** Capability tokens the UserDO delivered, per workspace. */
  installed: Map<string, string>;
  destroyedWorkspaces: string[];
  /** Reasons passed to `ctx.abort`: an account delete completes only once `destroy()` raises 'destroyed'. */
  aborted: string[];
  abortRaised: () => Promise<void>;
  /** Socket-revocation pushes fanned out, as `workspace:generation`. */
  revokedSocketPushes: string[];
  /** Browser-session revocations, as `workspace:tokenHash`: a logout must reach a listening-only socket. */
  revokedSessionPushes: string[];
  /** Capability re-pushes requested per workspace; only the root holds the token plaintext. */
  capabilityRepushes: string[];
  consentPrompts: Array<{
    workspace: string;
    method: string;
    command: string;
    workspaceName?: string;
  }>;
  /** Ids of cards actually raised; an identical re-ask adds no entry. */
  raisedConsentIds: string[];
  unavailableNotices: Array<{ workspace: string; devices: Array<{ id: string; label: string; lastSeenAt: number | null }> }>;
  availableNotices: Array<{ workspace: string; device: { id: string; label: string } }>;
  deviceFrames: DeviceFrame[];
  /** Non-call frames pushed to a device (the UPDATE a HELLO earns). */
  devicePushes: DevicePush[];
  /** Default: refuse. `hold` leaves the card waiting so an identical second ask can join it. */
  consentDecision: 'once' | 'always' | 'deny' | 'hold';
  answerConsent(answer: 'once' | 'always' | 'deny'): void;
  pendingConsents(workspace: string): Array<{ consentId: string }>;
  /** The owner's click, as `resolveDeviceConsent` runs it over RPC. */
  resolveConsent(workspace: string, consentId: string, answer: 'once' | 'always' | 'deny'): { ok: boolean };
  attachDevice(deviceId: string | null): void;
  /** Deliver a HELLO through the real socket handler, unvalidated so unknown fields can be tested.
   *  `deviceId` targets an `attachDaemon` socket; absent, the harness's own. */
  sendDeviceHello(hello: JsonValue, deviceId?: string): Promise<void>;
  /** Another fake daemon bound to one machine, with its own socket and frame log; `close()`
   *  runs the real `webSocketClose`. */
  attachDaemon(deviceId: string): FakeDaemon;
  /** Sockets accepted through the UserDO's upgrade path, with what it wrote to each. `drop`
   *  closes one from the far end: the hub refuses a second claimant while a socket is live. */
  acceptedSockets: Array<{ sent: string[]; drop(): void; ws: WebSocket }>;
  /** Join device responder fibers before inspecting asynchronous effects. */
  joinFibers(): Promise<void>;
  close(): void;
}

export const TEST_CREDENTIAL_ENCRYPTION_KEY = 'test-credential-encryption-key-0123456789';

export const TEST_USER_ENV = { CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY };

export function testOwner(): Promise<UserCaller> {
  return ownerCaller(TEST_USER_ENV);
}

export interface TestUserDOOptions {
  /** Without a connected device every device call short-circuits before the consent path. */
  connectedDeviceId?: string;
  /** Build stamp and CLI checksums served via `ASSETS` under `/downloads/`; absent, the hub pushes no UPDATE. */
  servedBuild?: { version: string; checksums?: Record<string, string>; signature?: string };
  /** Answer device RPC frames like the daemon; a returned promise answers later, so one frame
   *  can be held open across another. */
  deviceResponder?: (frame: DeviceFrame) => JsonValue | Promise<JsonValue>;
  credentialEncryptionKey?: string;
  credentialEncryptionKeyPrevious?: string;
  durableObjectId?: string;
  /** In-memory Mossaic per tenant id; absent, the Drive is unbound. */
  drive?: (tenant: string) => MossaicVfs | null;
  destroyWorkspaceError?: string;
  /** Hold workspace teardown open to observe the in-flight destroy window, or route the call to a real workspace object. */
  destroyWorkspaceGate?: (name: string, ownerUserId: string) => Promise<void>;
  /** Revive over storage a retired DO wrote (eviction). The caller owns the handle; `close` leaves it open. */
  storage?: Database;
  /** How many subtree pushes a capability install reports missed, asked per call. */
  capabilityPushMissed?: () => number;
  /** `oauth-app` preset ids the deployment carries a registered app for (fixed values under `MCP_APP_ENV` keys). */
  mcpAppCredentials?: readonly string[];
}

export interface FakeDaemon {
  readonly deviceId: string;
  readonly frames: DeviceFrame[];
  close(): Promise<void>;
}

export interface DeviceFrame {
  id: string;
  method: string;
  params: JsonValue[];
  /** Set for `attachDaemon` sockets; absent on the harness's own socket. */
  device?: string;
  /** The id the hub stamped on the frame. */
  deviceId?: string;
  /** Sandbox frame the daemon enforces; rides beside id/method/params because `DeviceTunnel` spreads `extra`. */
  sandbox?: JsonValue;
  /** The checkpoint hint the daemon snapshots under, on a mutating frame. */
  checkpoint?: JsonValue;
}

const DeviceFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.optional(v.array(JsonValueSchema)),
  sandbox: v.optional(JsonValueSchema),
  checkpoint: v.optional(JsonValueSchema),
  deviceId: v.optional(v.string()),
});

const DevicePushSchema = v.looseObject({ type: v.string() });

export interface DevicePush extends v.InferOutput<typeof DevicePushSchema> {
  device: string | null;
}

/** The `ASSETS` binding: build stamp and checksums, else the SPA shell (what an unpublished file returns). */
function servedAsset(pathname: string, build: TestUserDOOptions['servedBuild']): Response {
  if (build && pathname === '/downloads/kinu-version.json') {
    return Response.json({
      version: build.version, sha: 'sha', builtAt: '2026-09-15T00:00:00Z',
      ...(build.checksums !== undefined && { checksums: build.checksums }),
      ...(build.signature !== undefined && { signature: build.signature }),
    });
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
 * workerd hands a DO a socket pair; bun has none. Reinstalled per harness because other suites
 * replace the global `WebSocketPair`; each harness reads only sockets accepted after it was built.
 */
const ACCEPTED_SOCKETS: Array<{ sent: string[]; drop(): void; ws: WebSocket }> = [];

/** Workspace object storages keyed on the harness database, so a revived harness meets the same consent stores. */
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

        // Delegates to `server` so `drop` is visible through it; the UserDO reads only
        // send, close, readyState and the attachment members.
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
  const aborts = new AwaitedList<string>();
  const aborted = aborts.items;
  const revokedSocketPushes: string[] = [];
  const revokedSessionPushes: string[] = [];
  const capabilityRepushes: string[] = [];
  const consentPrompts: TestUserDO['consentPrompts'] = [];
  const raisedConsentIds: TestUserDO['raisedConsentIds'] = [];
  const unavailableNotices: TestUserDO['unavailableNotices'] = [];
  const availableNotices: TestUserDO['availableNotices'] = [];
  const deviceFrames: DeviceFrame[] = [];
  const devicePushes: DevicePush[] = [];

  const recordPush = (data: string, device: string | null): boolean => {
    const push = v.safeParse(DevicePushSchema, JSON.parse(data));

    if (!push.success) return false;
    devicePushes.push({ ...push.output, device });

    return true;
  };

  /** Late-bound: the socket answers through the object that owns it. */
  interface DOHub { current: UserDOInstance | null }

  const hub: DOHub = { current: null };

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

      if (frame.output.checkpoint !== undefined) call.checkpoint = frame.output.checkpoint;

      if (frame.output.deviceId !== undefined) call.deviceId = frame.output.deviceId;
      deviceFrames.push(call);
      const responder = options.deviceResponder;
      const owner = hub.current;

      if (!responder || !owner) return;

      // The daemon answers a throwing method with an error frame. Tests join the
      // harness fiber before inspecting a delayed answer's effects.
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

  // Hibernatable sockets are workerd-only; the double rides the prototype like
  // helpers/jsrpc-stub.ts, and the hub reads only the members above.
  const socket: WebSocket = Object.create(socketBody);

  let consentDecision: TestUserDO['consentDecision'] = 'deny';

  /** One registry per agent name, as at runtime: the real `DeviceConsentRegistry` decides whether an
   *  identical re-ask joins the existing card. `hold` leaves a card waiting. */
  const registries = new Map<string, DeviceConsentRegistry>();
  let mintedConsents = 0;

  /** Consent stores per workspace name, keyed on this object store's lifetime so a revived UserDO meets them. */
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

  const acceptedFrom = ACCEPTED_SOCKETS.length;
  const live: Array<{ ws: typeof socket; tags: string[] }> = [];
  const daemons: Array<{ deviceId: string; ws: WebSocket; frames: DeviceFrame[] }> = [];

  /** A socket's tags as the platform reports them; attachment-bound fakes imply their device tag. */
  const tagsOf = (ws: WebSocket): string[] => {
    const accepted = live.find((entry) => entry.ws === ws);

    if (accepted) return accepted.tags;
    const attachment = v.safeParse(v.object({ device: v.nullable(v.string()) }), ws.deserializeAttachment());

    return attachment.success && attachment.output.device !== null ? [`device:${attachment.output.device}`] : [];
  };

  const ctx = {
    // Sealed values are bound to the DO id; fixed so a DB written in one test opens in another.
    id: {
      name: options.durableObjectId ?? 'test-user-do',
      toString: () => options.durableObjectId ?? 'test-user-do',
    },
    // Real, not a passthrough: `userMcp_add`/`userMcp_update` claim a name inside one
    // `transactionSync`; a fake makes that claim torn.
    storage: {
      sql,
      transactionSync: <T,>(closure: () => T): T => db.transaction(closure)(),
      // The SDK's `destroy()` runs these before the abort; dropping every table matches `deleteAll`.
      deleteAlarm: async (): Promise<void> => {},
      deleteAll: async (): Promise<void> => {
        // Virtual tables first: dropping an FTS table takes its shadows, and a lone dropped
        // shadow leaves the virtual table undroppable.
        const tables = db.query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY CASE WHEN sql LIKE 'CREATE VIRTUAL%' THEN 0 ELSE 1 END, name`,
        ).all();

        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      },
    },
    abort: (reason: string): void => { aborts.push(reason); },
    // Tag-filtered like the platform: `device:<id>` returns only that machine's socket.
    getWebSockets: (tag?: string) => {
      const all = [...(attached === null ? [] : [socket]), ...live.map((entry) => entry.ws), ...daemons.map((d) => d.ws)];

      return tag === undefined ? all : all.filter((ws) => tagsOf(ws).includes(tag));
    },
    acceptWebSocket: (ws: typeof socket, tags: string[] = []) => { live.push({ ws, tags }); },
  };

  const env: TestUserEnvironment = {
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
        /** Re-push with the token the root already holds; nothing is re-minted. */
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
  const userDO = options.drive === undefined ? new UserDO(agentContext, userEnv) : new DriveHarnessUserDO(agentContext, userEnv, options.drive);
  rememberMcpManager(inheritedMcpManager(userDO));
  hub.current = userDO;

  return {
    userDO, db, sql, installed, destroyedWorkspaces, aborted, revokedSocketPushes,
    abortRaised: () => aborts.until((reasons) => reasons.length > 0),
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
      // Bound to one machine via a fixed attachment. A real attachment, because the hub
      // caches the toolchain probe there; a no-op store would re-probe on every status read.
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

          if (frame.output.checkpoint !== undefined) call.checkpoint = frame.output.checkpoint;

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

/** Register a workspace and provision its capability, as `claimOwnedWorkspace` does. */
export async function provisionTestWorkspace(harness: TestUserDO, name: string, displayName?: string): Promise<string> {
  await harness.userDO.registerWorkspace(await testOwner(), name, displayName ?? name);
  await harness.userDO.ensureWorkspaceCapability(name, null);
  const token = harness.installed.get(name);

  if (!token) throw new Error(`workspace ${name} was not provisioned`);

  return token;
}

/** The entry a register inserted; fails here on any status but `created`. */
export function createdWorkspace(registration: WorkspaceRegistration): WorkspaceEntry {
  if (registration.status !== 'created') {
    throw new Error(`expected registerWorkspace to insert a row, got "${registration.status}"`);
  }

  return registration.entry;
}
