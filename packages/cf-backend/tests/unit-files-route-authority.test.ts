/**
 * WHO may move bytes through the files route, proved at the boundary that
 * decides it rather than described beside it.
 *
 * `unit-files-routes.test.ts` covers the TRANSFER contract — chunking, the
 * total-size refusal, a streamed response — against an injected actor. It says
 * nothing about authority, because its actor answers everyone. So this suite
 * drives the whole rail instead:
 *
 *   the real Worker `fetch`  (auth → CSRF → ownership → files route)
 *     over a real browser session in real KV + the owner's real UserDO,
 *   into a real OrchestratorAgent, whose runtime is the production one —
 *     the workspace plane, the mount table, and the laptop executor over
 *     `createHubDeviceTransport`,
 *   into the real `UserDO.deviceRpc` consent chokepoint,
 *   into a device socket that answers the way the daemon does.
 *
 * Nothing between the cookie and the machine is stood in for. That is the
 * point: every refusal below is produced by the code that produces it in
 * production, and each one is checked twice — the caller's answer, AND whether
 * a frame reached the machine or a byte changed on a plane. A refusal that
 * still touched the file is not a refusal.
 *
 * The `/pc` path is the product's own: the file manager addresses the device as
 * a MOUNT inside the workspace plane (`executor=workspace&path=/pc/...`,
 * FilesSurface.tsx), so that is how the device is reached here.
 *
 * The 412 revision conflict itself lives in `unit-files-routes.test.ts`, where
 * a plane with compare-and-write is injected. What belongs here is the half
 * that is about authority over bytes: a precondition this plane cannot honour
 * must refuse WITHOUT writing, and a malformed one must never reach a plane.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type TestUserDO,
} from './helpers/user-do';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { makeKv } from './helpers/kv';
import type { UserCaller } from '../src/user/workspace-capability';
import type { JsonValue } from '@kinu.run/core';

// Dynamic, and deliberately: the helpers imported above install the agents-SDK
// mock at module load, and every module below reaches `agents`, whose dist
// imports workerd-only `cloudflare:*` modules that crash bun's loader. Same
// shape, and same reason, as unit-files-routes.test.ts.
const { createSession, deriveUserId } = await import('../src/auth/store');
const { SESSION_COOKIE_NAME } = await import('../src/auth/session');
const worker = (await import('../src/server')).default;

const ORIGIN = 'https://kinu.example.com';
const OWNER_EMAIL = 'owner@kinu.example.com';
const STRANGER_EMAIL = 'stranger@kinu.example.com';
/** The device's own absolute paths, as the daemon reports them. */
const DEVICE_HOME = '/home/dev';
const DEVICE_FILE = `${DEVICE_HOME}/notes.md`;
/** The same file as the file manager addresses it: the `/pc` mount point. */
const PC_FILE = `/pc${DEVICE_FILE}`;
const WORKSPACE_FILE = '/home/user/report.bin';

/** Device methods that MOVE or REVEAL a file. `which` (the toolchain probe) and
 *  the exec ack are hub bookkeeping and deliberately consent-free, so counting
 *  them would make every refusal look like a leak. */
const FILE_METHODS = {
  readFile: true, readRange: true, writeFile: true, listFiles: true,
  statPath: true, unlinkPath: true, mkdirPath: true, exists: true,
} as const;

/** The write frame's option bag, as the daemon reads it. */
const Base64WriteSchema = v.object({ encoding: v.literal('base64') });

const ErrorReplySchema = v.object({ error: v.string() });
const OkReplySchema = v.object({ ok: v.literal(true) });

/** A daemon over an in-memory filesystem: the far end has to answer, or a call
 *  that PASSED consent could not be told from one that was stopped. */
function daemon(files: Map<string, string>) {
  return (frame: DeviceFrame): JsonValue => {
    const path = String(frame.params[0] ?? '');
    const body = files.get(path);
    switch (frame.method) {
      case 'which': return { present: [] };
      case 'statPath': return body === undefined ? null : { size: body.length, mtimeMs: 1, isDir: false };
      case 'readFile': return { encoding: 'base64', content: btoa(body ?? '') };
      case 'readRange': return { encoding: 'base64', content: btoa((body ?? '').slice(0, 64)) };
      case 'exists': return files.has(path);
      case 'listFiles': return [...files.keys()]
        .filter((name) => name.startsWith(`${path}/`))
        .map((name) => ({ name: name.slice(path.length + 1), type: 'file' }));
      case 'unlinkPath': files.delete(path); return { success: true };
      case 'writeFile': {
        const raw = String(frame.params[1] ?? '');
        files.set(path, v.is(Base64WriteSchema, frame.params[2]) ? atob(raw) : raw);
        return { success: true };
      }
      // The consented root: the file view asks the machine where its home is.
      default: return { stdout: DEVICE_HOME, stderr: '', exitCode: 0 };
    }
  };
}

interface Seam {
  /** The owner's real Durable Object — grants, tokens, device socket. */
  readonly user: TestUserDO;
  readonly stranger: TestUserDO;
  readonly owner: UserCaller;
  readonly deviceId: string;
  /** The device's filesystem, so a refusal can be checked against the bytes. */
  readonly device: Map<string, string>;
  readonly ownerSession: string;
  readonly strangerSession: string;
  actorFor(workspace: string): HarnessOrchestratorAgent;
  /** Device frames that moved or revealed a file. */
  fileFrames(): DeviceFrame[];
  /** One files-route request, through the real Worker entry point. */
  files(input: {
    session: string;
    workspace: string;
    path: string;
    executor?: string;
    method?: 'GET' | 'PUT';
    body?: BodyInit;
    ifMatch?: string;
  }): Promise<Response>;
  /** Any request through the same entry point, for the gate the agent RPC
   *  transport (rename/delete) sits behind. */
  fetch(url: string, session: string, init?: RequestInit): Promise<Response>;
  removeWorkspace(name: string): Promise<void>;
  /** End every live browser session at the ONE authority that decides it — the
   *  owner's own Durable Object — leaving the KV record where it is. */
  signOutAtAuthority(): Promise<void>;
  close(): void;
}

const open: Seam[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

/**
 * The whole rail, standing up.
 *
 * `workspaces` are the owner's; `strangerWorkspaces` are registered in the
 * OTHER user's registry, which is how a name can be claimed by two people at
 * once. Every actor is a real OrchestratorAgent holding the capability token
 * the owner's UserDO actually minted for it — the handshake `claimOwnedWorkspace`
 * performs — so the device plane it builds answers to real consent.
 */
async function seam(options: {
  workspaces: readonly string[];
  strangerWorkspaces?: readonly string[];
  deviceFiles?: Record<string, string>;
}): Promise<Seam> {
  const device = new Map<string, string>(Object.entries(options.deviceFiles ?? { [DEVICE_FILE]: 'hello' }));
  const ownerUserId = await deriveUserId(OWNER_EMAIL);
  const strangerUserId = await deriveUserId(STRANGER_EMAIL);
  const user = createTestUserDO({ deviceResponder: daemon(device), durableObjectId: ownerUserId });
  const stranger = createTestUserDO({ durableObjectId: strangerUserId });
  const owner = await testOwner();
  const { deviceId } = await user.userDO.registerDevice(owner, 'ashish@studio');
  user.attachDevice(deviceId);

  const actors = new Map<string, ActorHarness<HarnessOrchestratorAgent>>();
  for (const workspace of options.workspaces) {
    const token = await provisionTestWorkspace(user, workspace, workspace);
    const actor = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId });
    actor.agent.harnessHoldsCapability(token);
    // The turn-start refresh, which is what makes a connected device visible to
    // the mount table. Awaited here because production detaches it.
    await actor.agent.harnessRefreshDeviceStatus();
    actors.set(workspace, actor);
  }
  for (const workspace of options.strangerWorkspaces ?? []) {
    await stranger.userDO.registerWorkspace(owner, workspace, workspace);
  }

  const users = new Map([[ownerUserId, user], [strangerUserId, stranger]]);
  const kv = makeKv();
  const bindings = {
    AUTH_KV: kv,
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    ASSETS: { fetch: async () => new Response('<!doctype html>the app', { status: 200 }) },
    UserDO: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        const harness = users.get(id);
        if (!harness) throw new Error(`no Durable Object for user ${id}`);
        return harness.userDO;
      },
    },
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        const actor = actors.get(name);
        if (!actor) throw new Error(`no workspace actor named ${name}`);
        return actor.agent;
      },
    },
  };
  const partial: Partial<Env> = {};
  Object.assign(partial, bindings);
  // SAFETY: the Worker path under test reads exactly the bindings constructed
  // above — session KV, the owner capability secret, the SPA fallback, and the
  // two namespaces the auth, ownership and files steps resolve through.
  const env = partial as Env;
  const partialCtx: Partial<ExecutionContext> = {};
  Object.assign(partialCtx, { waitUntil: () => {}, passThroughOnException: () => {} });
  // SAFETY: the constructed context provides `waitUntil`, the only member this
  // route reaches; nothing else on the generated ExecutionContext contract is
  // touched by the auth, ownership or files steps under test.
  const ctx = partialCtx as ExecutionContext;

  const signIn = async (email: string, sub: string): Promise<string> => (await createSession(env, {
    provider: 'cloudflare', providerSub: sub, email, emailVerified: true, displayName: null,
  })).token;

  const built: Seam = {
    user,
    stranger,
    owner,
    deviceId,
    device,
    ownerSession: await signIn(OWNER_EMAIL, 'cf-owner'),
    strangerSession: await signIn(STRANGER_EMAIL, 'cf-stranger'),
    actorFor: (workspace) => {
      const actor = actors.get(workspace);
      if (!actor) throw new Error(`no workspace actor named ${workspace}`);
      return actor.agent;
    },
    fileFrames: () => user.deviceFrames.filter((frame) => Object.hasOwn(FILE_METHODS, frame.method)),
    fetch: (url, session, init) => worker.fetch(new Request(url, {
      ...init,
      headers: {
        ...init?.headers,
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`,
        origin: ORIGIN,
      },
    }), env, ctx),
    files: (input) => {
      const url = new URL(`${ORIGIN}/api/workspaces/${input.workspace}/files`);
      url.searchParams.set('executor', input.executor ?? 'workspace');
      url.searchParams.set('path', input.path);
      const headers: Record<string, string> = {};
      if (input.ifMatch !== undefined) headers['if-match'] = input.ifMatch;
      const init: RequestInit = { method: input.method ?? 'GET', headers };
      if (input.body !== undefined) init.body = input.body;
      return built.fetch(url.toString(), input.session, init);
    },
    removeWorkspace: async (name) => {
      await user.userDO.removeWorkspace(owner, name, ownerUserId);
    },
    signOutAtAuthority: async () => {
      const rows = user.db
        .query<{ token_hash: string }, []>('SELECT token_hash FROM user_browser_sessions')
        .all();
      for (const row of rows) await user.userDO.revokeBrowserSession(owner, row.token_hash);
    },
    close: () => { user.close(); stranger.close(); },
  };
  open.push(built);
  return built;
}

async function errorOf(response: Response): Promise<string> {
  return v.parse(ErrorReplySchema, await response.json()).error;
}

async function bytesOf(response: Response): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
}

/** Where a rename puts the device's file — the mount-relative path both the
 *  refused mutation and the allowed one name. */
const MOVED = `/pc${DEVICE_HOME}/moved.md`;

describe('a workspace the caller does not hold', () => {
  test('a name outside the registry never reaches a file plane, in either direction', async () => {
    const rail = await seam({ workspaces: ['authority-own'] });

    const read = await rail.files({ session: rail.ownerSession, workspace: 'authority-other', path: PC_FILE });
    const write = await rail.files({
      session: rail.ownerSession, workspace: 'authority-other', path: PC_FILE,
      method: 'PUT', body: 'overwritten',
    });

    expect([read.status, write.status]).toEqual([404, 404]);
    expect(await errorOf(read)).toContain('not in your registry');
    // Nothing was asked of the machine, and the file it holds is untouched.
    expect(rail.fileFrames()).toEqual([]);
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });

  test('a name someone else owns is refused by the workspace, not by the path', async () => {
    // The registry says this stranger has a workspace called `authority-own`.
    // The object of that name belongs to the owner, and it is the object that
    // settles the question — a roster row is a claim about a name.
    const rail = await seam({ workspaces: ['authority-own'], strangerWorkspaces: ['authority-own'] });

    const read = await rail.files({ session: rail.strangerSession, workspace: 'authority-own', path: PC_FILE });

    expect(read.status).toBe(403);
    expect(await errorOf(read)).toContain('owned by a different user');
    expect(rail.fileFrames()).toEqual([]);
  });

  test('the same gate stands in front of the transport rename and delete ride', async () => {
    const rail = await seam({ workspaces: ['authority-own'] });
    // The endpoint the chat pane's own transport uses, and the one the file
    // manager's rename/delete RPCs ride behind.
    const transport = (workspace: string) =>
      `${ORIGIN}/agents/orchestrator-agent/${workspace}/get-messages`;

    const foreign = await rail.fetch(transport('authority-other'), rail.ownerSession);
    const owned = await rail.fetch(transport('authority-own'), rail.ownerSession);

    // Refused before dispatch for a name the caller does not hold; dispatched
    // (and, with no live agent transport under bun, falling through to the app)
    // for one they do. The difference IS the gate.
    expect(foreign.status).toBe(404);
    expect(await errorOf(foreign)).toContain('not in your registry');
    expect(await owned.text()).toContain('the app');
  });
});

describe('a device the workspace has no grant on', () => {
  test('read, write, rename and delete are all refused, and no frame reaches the machine', async () => {
    const rail = await seam({ workspaces: ['device-a'] });
    // The owner is away from the card. An unanswered prompt is not a grant.
    rail.user.consentDecision = 'deny';

    const read = await rail.files({ session: rail.ownerSession, workspace: 'device-a', path: PC_FILE });
    const write = await rail.files({
      session: rail.ownerSession, workspace: 'device-a', path: PC_FILE, method: 'PUT', body: 'overwritten',
    });
    const agent = rail.actorFor('device-a');
    const renamed = await agent.renameExecutorFile('workspace', PC_FILE, MOVED);
    const deleted = await agent.deleteExecutorFile('workspace', PC_FILE);

    expect(await errorOf(read)).toContain('device use was not approved');
    expect(await errorOf(write)).toContain('device use was not approved');
    expect(renamed).toMatchObject({ error: expect.stringContaining('device use was not approved') });
    expect(deleted).toMatchObject({ error: expect.stringContaining('device use was not approved') });
    expect(rail.fileFrames()).toEqual([]);
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });

  test('a grant is not transferable between the owner\'s own workspaces', async () => {
    const rail = await seam({ workspaces: ['device-granted', 'device-ungranted'] });

    rail.user.consentDecision = 'always';
    const granted = await rail.files({
      session: rail.ownerSession, workspace: 'device-granted', path: PC_FILE,
    });
    expect([granted.status, await bytesOf(granted)]).toEqual([200, 'hello']);

    // The sibling holds no grant of its own, and consent is keyed on the PROVEN
    // workspace behind the capability token — never the name a caller passes.
    rail.user.consentDecision = 'deny';
    const sibling = await rail.files({
      session: rail.ownerSession, workspace: 'device-ungranted', path: PC_FILE,
    });

    expect(await errorOf(sibling)).toContain('device use was not approved');
    expect(rail.user.consentPrompts.at(-1)?.workspace).toBe('device-ungranted');
  });

  test('a grant the owner revokes stops the next request, with nothing restarted', async () => {
    const rail = await seam({ workspaces: ['device-revoked'] });
    rail.user.consentDecision = 'always';
    const before = await rail.files({ session: rail.ownerSession, workspace: 'device-revoked', path: PC_FILE });
    expect(await bytesOf(before)).toBe('hello');
    const reads = rail.fileFrames().length;

    expect(await rail.user.userDO.revokeDeviceConsent(rail.owner, 'device-revoked', rail.deviceId))
      .toEqual({ ok: true });
    rail.user.consentDecision = 'deny';

    const after = await rail.files({
      session: rail.ownerSession, workspace: 'device-revoked', path: PC_FILE,
      method: 'PUT', body: 'overwritten',
    });

    expect(await errorOf(after)).toContain('device use was not approved');
    expect(rail.fileFrames()).toHaveLength(reads);
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });

  test('the base action tier does not carry the device file view, and says which tier does', async () => {
    // The owner granted local actions from settings, not the whole machine. The
    // file view's own consent boundary is the device's home, and the plane
    // learns where that is by asking the machine — a shell call, which is the
    // full-filesystem tier by construction (deviceConsentScopeForMethod). So a
    // base-tier workspace is refused at the boundary read, before any file.
    const rail = await seam({ workspaces: ['device-base'] });
    expect(await rail.user.userDO.setDeviceConsentScope(
      rail.owner, 'device-base', rail.deviceId, 'all_local_actions',
    )).toEqual({ ok: true });
    rail.user.consentDecision = 'deny';

    const read = await rail.files({ session: rail.ownerSession, workspace: 'device-base', path: PC_FILE });

    expect(await errorOf(read)).toContain('device use was not approved');
    expect(rail.user.consentPrompts.map((prompt) => prompt.scope)).toEqual(['full_filesystem']);
    expect(rail.fileFrames()).toEqual([]);
  });
});

describe('an executor id the caller made up', () => {
  test('names no plane, on either verb, and nothing is asked of any machine', async () => {
    const rail = await seam({ workspaces: ['executor-forged'] });
    rail.user.consentDecision = 'always';

    for (const executor of ['laptop-2', 'workspace/../laptop', 'ashish@studio', '']) {
      const read = await rail.files({
        session: rail.ownerSession, workspace: 'executor-forged', path: DEVICE_FILE, executor,
      });
      const write = await rail.files({
        session: rail.ownerSession, workspace: 'executor-forged', path: DEVICE_FILE,
        executor, method: 'PUT', body: 'overwritten',
      });
      // Named in the assertion, so a failure says WHICH id was let through.
      const refusal = executor === ''
        ? 'executor query parameter required'
        : `Executor "${executor}" has no file plane`;
      expect(`${executor} → ${await errorOf(read)}`).toBe(`${executor} → ${refusal}`);
      expect(`${executor} → ${await errorOf(write)}`).toBe(`${executor} → ${refusal}`);
    }
    expect(rail.fileFrames()).toEqual([]);
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });

  test('a forged executor cannot rename or delete either', async () => {
    const rail = await seam({ workspaces: ['executor-forged-rpc'] });
    const agent = rail.actorFor('executor-forged-rpc');

    expect(await agent.renameExecutorFile('laptop-2', DEVICE_FILE, `${DEVICE_HOME}/moved.md`))
      .toEqual({ error: 'Executor "laptop-2" has no file plane' });
    expect(await agent.deleteExecutorFile('laptop-2', DEVICE_FILE))
      .toEqual({ error: 'Executor "laptop-2" has no file plane' });
    expect(rail.fileFrames()).toEqual([]);
  });
});

describe('a request the authority behind it has since withdrawn', () => {
  test('a workspace removed from the registry closes behind the isolate that proved it', async () => {
    const rail = await seam({ workspaces: ['stale-workspace'] });
    rail.user.consentDecision = 'always';
    // The proof this isolate now holds: membership answered once, remembered
    // for the life of the isolate (workspace-ownership.ts).
    expect((await rail.files({
      session: rail.ownerSession, workspace: 'stale-workspace', path: PC_FILE,
    })).status).toBe(200);

    await rail.removeWorkspace('stale-workspace');
    const frames = rail.fileFrames().length;

    const after = await rail.files({
      session: rail.ownerSession, workspace: 'stale-workspace', path: PC_FILE,
      method: 'PUT', body: 'overwritten',
    });

    expect(after.status).toBe(404);
    expect(await errorOf(after)).toContain('not in your registry');
    expect(rail.fileFrames()).toHaveLength(frames);
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });

  test('the workspace capability dies with the registry row, so the actor cannot reach the device either', async () => {
    const rail = await seam({ workspaces: ['stale-capability'] });
    rail.user.consentDecision = 'always';
    expect(await bytesOf(await rail.files({
      session: rail.ownerSession, workspace: 'stale-capability', path: PC_FILE,
    }))).toBe('hello');

    await rail.removeWorkspace('stale-capability');

    // The token the actor still holds is no longer a workspace identity, so the
    // user plane refuses it — the route's 404 is not the only thing standing
    // between a deleted workspace and the owner's machine.
    expect(await rail.actorFor('stale-capability').readExecutorFile('workspace', PC_FILE))
      .toMatchObject({ error: expect.stringContaining('capability') });
  });

  test('a cookie the owner signed out of buys nothing, even where the KV delete has not landed', async () => {
    const rail = await seam({ workspaces: ['stale-session'] });
    rail.user.consentDecision = 'always';

    // Sign-out at the AUTHORITY only, which is what a colo the KV delete has
    // not reached still sees: the record is readable and the row behind it is
    // gone. A route that trusted the record would carry this cookie for a
    // minute after logout.
    await rail.signOutAtAuthority();

    const read = await rail.files({ session: rail.ownerSession, workspace: 'stale-session', path: PC_FILE });
    const write = await rail.files({
      session: rail.ownerSession, workspace: 'stale-session', path: PC_FILE,
      method: 'PUT', body: 'overwritten',
    });

    expect([read.status, write.status]).toEqual([401, 401]);
    expect(rail.fileFrames()).toEqual([]);
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });
});

describe('the authority the caller does hold', () => {
  test('the workspace plane carries bytes both ways, byte for byte', async () => {
    const rail = await seam({ workspaces: ['allowed-workspace'] });
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);

    const write = await rail.files({
      session: rail.ownerSession, workspace: 'allowed-workspace', path: WORKSPACE_FILE,
      method: 'PUT', body: payload,
    });
    const read = await rail.files({
      session: rail.ownerSession, workspace: 'allowed-workspace', path: WORKSPACE_FILE,
    });

    expect(v.parse(OkReplySchema, await write.json())).toEqual({ ok: true });
    expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([...payload]);
  });

  test('a consented device is read, written, renamed and deleted through the /pc mount', async () => {
    const rail = await seam({ workspaces: ['allowed-device'] });
    rail.user.consentDecision = 'always';

    const read = await rail.files({ session: rail.ownerSession, workspace: 'allowed-device', path: PC_FILE });
    const write = await rail.files({
      session: rail.ownerSession, workspace: 'allowed-device', path: PC_FILE, method: 'PUT', body: 'rewritten',
    });
    const renamed = await rail.actorFor('allowed-device').renameExecutorFile('workspace', PC_FILE, MOVED);
    const deleted = await rail.actorFor('allowed-device').deleteExecutorFile('workspace', MOVED);

    expect([read.status, await bytesOf(read)]).toEqual([200, 'hello']);
    expect(v.parse(OkReplySchema, await write.json())).toEqual({ ok: true });
    expect(renamed).toEqual({ ok: true });
    expect(deleted).toEqual({ ok: true });
    // The machine's own bytes moved, which is the only proof that matters.
    expect([...rail.device.keys()]).toEqual([]);
  });
});

describe('a transfer that does not finish', () => {
  test('an upload cut mid-body publishes nothing, and leaves the transfer reusable', async () => {
    const rail = await seam({ workspaces: ['upload-cut'] });
    rail.user.consentDecision = 'always';
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('half a fi'));
        controller.error(new Error('the browser went away'));
      },
    });

    const interrupted = await rail.files({
      session: rail.ownerSession, workspace: 'upload-cut', path: PC_FILE, method: 'PUT', body: cut,
    });

    expect(interrupted.status).toBe(400);
    expect(await errorOf(interrupted)).toBe('the upload stopped before the whole file arrived');
    // No half file on the machine: bytes are held until the final chunk, and the
    // abandoned transfer took its buffer with it.
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
    expect(rail.fileFrames().some((frame) => frame.method === 'writeFile')).toBe(false);

    const retried = await rail.files({
      session: rail.ownerSession, workspace: 'upload-cut', path: PC_FILE, method: 'PUT', body: 'all of it',
    });
    expect(v.parse(OkReplySchema, await retried.json())).toEqual({ ok: true });
    expect(rail.device.get(DEVICE_FILE)).toBe('all of it');
  });

  test('a precondition this plane cannot honour refuses base and mounted writes instead of taking them', async () => {
    const rail = await seam({ workspaces: ['upload-conditional'] });
    rail.user.consentDecision = 'always';
    await rail.files({
      session: rail.ownerSession, workspace: 'upload-conditional', path: WORKSPACE_FILE,
      method: 'PUT', body: 'first',
    });

    const conditional = await rail.files({
      session: rail.ownerSession, workspace: 'upload-conditional', path: WORKSPACE_FILE,
      method: 'PUT', body: 'second', ifMatch: '1',
    });
    const mountedConditional = await rail.files({
      session: rail.ownerSession, workspace: 'upload-conditional', path: PC_FILE,
      method: 'PUT', body: 'device second', ifMatch: '1',
    });
    const malformed = await rail.files({
      session: rail.ownerSession, workspace: 'upload-conditional', path: WORKSPACE_FILE,
      method: 'PUT', body: 'third', ifMatch: 'W/"etag"',
    });

    expect(conditional.status).toBe(409);
    expect(await errorOf(conditional)).toContain('cannot protect an in-place edit');
    expect(mountedConditional.status).toBe(409);
    expect(await errorOf(mountedConditional)).toContain('cannot protect an in-place edit');
    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toBe('If-Match must be a non-negative integer revision');
    // Every refusal left its file as it was.
    expect(await bytesOf(await rail.files({
      session: rail.ownerSession, workspace: 'upload-conditional', path: WORKSPACE_FILE,
    }))).toBe('first');
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });
});
