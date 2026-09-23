/**
 * Who may move bytes through the files route, driven through the real Worker `fetch`, UserDO consent chokepoint and a
 * daemon-shaped device socket. Each refusal is checked twice: the caller's answer and that no frame reached the machine
 * nor a byte changed. The transfer contract and the 412 conflict live in `unit-files-routes.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type TestUserDO,
} from './helpers/user-do';
import { CAPABLE_HELLO } from './helpers/device-harness';
import { chatSessionTurns, orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import { makeKv } from './helpers/kv';
import { workerContext } from './helpers/bindings';
import type { UserCaller } from '@kinu.run/core';
import type { JsonValue } from '@kinu.run/core';

// Dynamic: the helpers above install the agents-SDK mock at load, and `agents` imports workerd-only
// `cloudflare:*` modules that crash bun's loader.
const { createSession, deriveUserId } = await import('../src/auth/store');

const { SESSION_COOKIE_NAME } = await import('../src/auth/session');

const worker = (await import('../src/server')).default;

const ORIGIN = 'https://kinu.example.com';

const OWNER_EMAIL = 'owner@kinu.example.com';

const STRANGER_EMAIL = 'stranger@kinu.example.com';

const DEVICE_HOME = '/home/dev';

const DEVICE_FILE = `${DEVICE_HOME}/notes.md`;

const PC_FILE = `/pc/ashish@studio${DEVICE_FILE}`;

const WORKSPACE_FILE = '/home/user/report.bin';

/** `which` and the exec ack are consent-free hub bookkeeping; counting them would make every refusal look like a leak. */
const FILE_METHODS = {
  readFile: true, readRange: true, writeFile: true, listFiles: true,
  statPath: true, unlinkPath: true, mkdirPath: true, exists: true,
} as const;

const Base64WriteSchema = v.object({ encoding: v.literal('base64') });

const ErrorReplySchema = v.object({ error: v.string() });

const OkReplySchema = v.object({ ok: v.literal(true) });

/** The far end has to answer, or a call that passed consent could not be told from one that was stopped. */
function daemon(files: Map<string, string>) {
  return (frame: DeviceFrame): JsonValue => {
    const path = v.parse(v.string(), frame.params[0] ?? '');
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
      case 'unlinkPath': files.delete(path);

        return { success: true };
      case 'writeFile': {
        const raw = v.parse(v.string(), frame.params[1] ?? '');
        files.set(path, v.is(Base64WriteSchema, frame.params[2]) ? atob(raw) : raw);

        return { success: true };
      }

      default: return { stdout: DEVICE_HOME, stderr: '', exitCode: 0 };
    }
  };
}

interface Seam {
  readonly user: TestUserDO;
  readonly stranger: TestUserDO;
  readonly owner: UserCaller;
  readonly deviceId: string;
  readonly device: Map<string, string>;
  readonly ownerSession: string;
  readonly strangerSession: string;
  actorFor(workspace: string): HarnessOrchestratorAgent;
  fileFrames(): DeviceFrame[];
  files(input: {
    session: string;
    workspace: string;
    path: string;
    executor?: string;
    method?: 'GET' | 'PUT';
    body?: BodyInit;
    ifMatch?: string;
  }): Promise<Response>;
  fetch(url: string, session: string, init?: RequestInit): Promise<Response>;
  removeWorkspace(name: string): Promise<void>;
  /** Ends sessions at the owner's DO only, leaving the KV record in place. */
  signOutAtAuthority(): Promise<void>;
  close(): Promise<void>;
}

const open: Seam[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

/**
 * `strangerWorkspaces` live in the other user's registry, so a name can be claimed by two people at once.
 * Actors hold the token the owner's UserDO really minted, so the device plane answers to real consent.
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
  // Without the reported cwd the file view reaches nothing (F2's rule), which is not what these tests are about.
  await user.sendDeviceHello({ ...CAPABLE_HELLO, root: DEVICE_HOME, home: DEVICE_HOME });

  const actors = new Map<string, ActorHarness<HarnessOrchestratorAgent>>();

  for (const workspace of options.workspaces) {
    const token = await provisionTestWorkspace(user, workspace, workspace);
    const actor = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId });
    actor.agent.harnessHoldsCapability(token);
    // A turn's start reads the device hub, which makes a device visible to the mount table.
    await chatSessionTurns(actor.agent).prepare({ messages: [{ role: 'user', content: 'list my files' }] });
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
  // SAFETY: the Worker path under test reads exactly the bindings constructed above.
  const env = partial as Env;
  const ctx = workerContext();

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
    fetch: (url, session, init) => {
      const headers = new Headers(init?.headers);

      headers.set('cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`);
      headers.set('origin', ORIGIN);

      return worker.fetch(new Request(url, { ...init, headers }), env, ctx);
    },
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
    close: async () => {
      await Promise.all([user.joinFibers(), stranger.joinFibers()]);
      user.close();
      stranger.close();
    },
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

const MOVED = `/pc/ashish@studio${DEVICE_HOME}/moved.md`;

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
    expect(rail.fileFrames()).toEqual([]);
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });

  test('a name someone else owns is refused by the workspace, not by the path', async () => {
    // The object of that name belongs to the owner and settles it: a roster row is only a claim about a name.
    const rail = await seam({ workspaces: ['authority-own'], strangerWorkspaces: ['authority-own'] });

    const read = await rail.files({ session: rail.strangerSession, workspace: 'authority-own', path: PC_FILE });

    expect(read.status).toBe(403);
    expect(await errorOf(read)).toContain('owned by a different user');
    expect(rail.fileFrames()).toEqual([]);
  });

  test('the same gate stands in front of the transport rename and delete ride', async () => {
    const rail = await seam({ workspaces: ['authority-own'] });

    const transport = (workspace: string) =>
      `${ORIGIN}/agents/orchestrator-agent/${workspace}/get-messages`;

    const foreign = await rail.fetch(transport('authority-other'), rail.ownerSession);
    const owned = await rail.fetch(transport('authority-own'), rail.ownerSession);

    // Refused before dispatch for a name the caller does not hold; dispatched for one they do. The difference is the gate.
    expect(foreign.status).toBe(404);
    expect(await errorOf(foreign)).toContain('not in your registry');
    expect(await owned.text()).toContain('the app');
  });
});

describe('a device the workspace has no grant on', () => {
  test('read, write, rename and delete are all refused, and no frame reaches the machine', async () => {
    const rail = await seam({ workspaces: ['device-a'] });
    // An unanswered prompt is not a grant.
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

    // Consent is keyed on the proven workspace behind the capability token, never the name a caller passes.
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

  test('an unbound workspace reaches no file on the device, and is asked once', async () => {
    // Paths arrive on HELLO and there is one binding, no shell tier: refuse the binding and no frame reaches the machine.
    const rail = await seam({ workspaces: ['device-base'] });
    rail.user.consentDecision = 'deny';

    const read = await rail.files({ session: rail.ownerSession, workspace: 'device-base', path: PC_FILE });

    expect(await errorOf(read)).toContain('device use was not approved');
    expect(rail.user.consentPrompts.map((prompt) => prompt.workspaceName)).toEqual(['device-base']);
    expect(rail.fileFrames()).toEqual([]);
  });
});

describe('an executor id the caller made up', () => {
  test('names no plane, on either verb, and nothing is asked of any machine', async () => {
    const rail = await seam({ workspaces: ['executor-forged'] });
    rail.user.consentDecision = 'always';

    for (const executor of ['device-2', 'workspace/../device', 'ashish@studio', '']) {
      const read = await rail.files({
        session: rail.ownerSession, workspace: 'executor-forged', path: DEVICE_FILE, executor,
      });

      const write = await rail.files({
        session: rail.ownerSession, workspace: 'executor-forged', path: DEVICE_FILE,
        executor, method: 'PUT', body: 'overwritten',
      });

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

    expect(await agent.renameExecutorFile('device-2', DEVICE_FILE, `${DEVICE_HOME}/moved.md`))
      .toEqual({ error: 'Executor "device-2" has no file plane' });
    expect(await agent.deleteExecutorFile('device-2', DEVICE_FILE))
      .toEqual({ error: 'Executor "device-2" has no file plane' });
    expect(rail.fileFrames()).toEqual([]);
  });
});

describe('a request the authority behind it has since withdrawn', () => {
  test('a workspace removed from the registry closes behind the isolate that proved it', async () => {
    const rail = await seam({ workspaces: ['stale-workspace'] });
    rail.user.consentDecision = 'always';
    // Membership is answered once and remembered for the life of the isolate (workspace-ownership.ts).
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

    // The user plane refuses the stale token too, not just the route's 404. The message is whichever refusal came first,
    // so pinning one sentence would pin the order rather than the boundary.
    const before = rail.fileFrames().length;
    const stale = await rail.actorFor('stale-capability').readExecutorFile('workspace', PC_FILE);
    expect(stale).toMatchObject({ error: expect.any(String) });
    expect(stale).not.toHaveProperty('content');
    expect(rail.fileFrames()).toHaveLength(before);
  });

  test('a cookie the owner signed out of buys nothing, even where the KV delete has not landed', async () => {
    const rail = await seam({ workspaces: ['stale-session'] });
    rail.user.consentDecision = 'always';

    // Sign-out at the authority only, as a colo the KV delete has not reached sees it: a route trusting the record would honour this cookie.
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
    // No half file: bytes are held until the final chunk.
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
    expect(await errorOf(malformed)).toBe('If-Match must encode a numeric or string revision');
    expect(await bytesOf(await rail.files({
      session: rail.ownerSession, workspace: 'upload-conditional', path: WORKSPACE_FILE,
    }))).toBe('first');
    expect(rail.device.get(DEVICE_FILE)).toBe('hello');
  });
});
