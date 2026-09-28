// The shipped daemon, spawned as itself, relays through a real UserDO to "chatgpt.com": a TLS proxy with a
// throwaway CA (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`) answering a recorded stream.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync, type Subprocess } from 'bun';
import { createRequire } from 'node:module';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  CODEX_CRED_KEY, DEVICE_CONNECT_PATH, DEVICE_RELAY,
  codexEgressAllowed,
} from '@kinu.run/core';
import { scratchDir } from '../../test-utils/src/scratch';
import { createTestUserDO, testOwner, type AcceptedSocket, type TestUserDO } from './helpers/user-do';

const require_ = createRequire(import.meta.url);

const DAEMON_PATH = join(import.meta.dir, '../../pc-agent/src/index.js');

const RelayModuleSchema = v.object({
  RELAY_METHOD: v.string(),
  RELAY_HEAD_FRAME: v.string(),
  RELAY_BODY_FRAME: v.string(),
  RELAY_CANCEL_FRAME: v.string(),
  RELAY_HOST: v.string(),
  RELAY_ROUTES: v.array(v.string()),
  relayRefusal: v.pipe(v.function(), v.args(v.tuple([v.string(), v.string()])), v.returns(v.nullable(v.string()))),
});

const pcAgent = v.parse(RelayModuleSchema, require_(DAEMON_PATH));

const ACCESS_TOKEN = 'codex-access-token-held-by-the-account';

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** A throwaway CA and the `chatgpt.com` leaf it signed. */
interface TestCertificates {
  readonly ca: string;
  readonly key: string;
  readonly cert: string;
}

function mintCertificates(dir: string): TestCertificates {
  const run = (args: string[]): void => {
    const result = spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe' });

    if (result.exitCode !== 0) throw new Error(`openssl ${args[0] ?? ''} failed: ${result.stderr.toString()}`);
  };

  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Kinu relay test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=keyCertSign']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=chatgpt.com']);
  writeFileSync(join(dir, 'leaf.ext'), 'subjectAltName=DNS:chatgpt.com\nextendedKeyUsage=serverAuth\n');
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '1', '-extfile', 'leaf.ext']);

  return { ca: join(dir, 'ca.pem'), key: readFileSync(join(dir, 'leaf.key'), 'utf8'), cert: readFileSync(join(dir, 'leaf.pem'), 'utf8') };
}

interface UpstreamCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
  readonly dropped: Promise<void>;
}

/** "chatgpt.com", holding every answer open until the test ends it. */
function startUpstream(tls: { key: string; cert: string }) {
  const calls: UpstreamCall[] = [];
  const answers: ServerResponse[] = [];

  const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const dropped = Promise.withResolvers<void>();
      res.on('close', () => { if (!res.writableFinished) dropped.resolve(); });
      calls.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, body, dropped: dropped.promise });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '41' });
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      answers.push(res);
    });
  });

  const proxy: NetServer = createNetServer((socket) => {
    socket.once('data', (head: Buffer) => {
      if (!head.toString().startsWith('CONNECT chatgpt.com:443 ')) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');

        return;
      }

      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      http.emit('connection', new TLSSocket(socket, { isServer: true, key: tls.key, cert: tls.cert }));
    });
  });

  return {
    calls, answers,
    listen: () => new Promise<number>((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve(v.parse(v.object({ port: v.number() }), proxy.address()).port));
    }),
    close: () => { proxy.close(); http.close(); },
  };
}

/** The hub the daemon dials, bridged to the real UserDO. */
function startHubBridge(harness: TestUserDO) {
  const connected = Promise.withResolvers<AcceptedSocket>();

  const server = Bun.serve<{ accepted: AcceptedSocket }>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req, bun) {
      const url = new URL(req.url);

      if (url.pathname === '/pc/connect-ticket') {
        const { token } = v.parse(v.object({ token: v.string() }), await req.json());
        const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);

        return issued.ok ? Response.json({ ticket: issued.ticket, expiresAt: issued.expiresAt }) : new Response('refused', { status: 401 });
      }

      if (url.pathname === DEVICE_CONNECT_PATH) {
        const upgraded = await harness.userDO.fetch(new Request(`https://kinu.example.com${DEVICE_CONNECT_PATH}${url.search}`, { headers: { Upgrade: 'websocket' } }));

        if (upgraded.status !== 101) return upgraded;
        const accepted = harness.acceptedSockets.at(-1);

        if (accepted === undefined) throw new Error('the UserDO upgraded without accepting a socket');

        return bun.upgrade(req, { data: { accepted } }) ? undefined : new Response('upgrade failed', { status: 500 });
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data.accepted.forward((data) => { ws.send(data); });
        connected.resolve(ws.data.accepted);
      },
      async message(ws, message) {
        await harness.userDO.webSocketMessage(ws.data.accepted.ws, String(message));
      },
    },
  });

  return { origin: `http://127.0.0.1:${String(server.port)}`, connected: connected.promise, stop: () => server.stop(true) };
}

describe('the daemon relays Codex calls from the owner\'s machine', () => {
  let harness: TestUserDO;
  let upstream: ReturnType<typeof startUpstream>;
  let hub: ReturnType<typeof startHubBridge>;
  let daemon: Subprocess;
  let logPath: string;
  let deviceId: string;

  beforeAll(async () => {
    const root = scratchDir('codex-relay');
    const certs = mintCertificates(root);
    harness = createTestUserDO();
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: ACCESS_TOKEN, refreshToken: 'refresh-never-sent' });
    const registered = await harness.userDO.registerDevice(owner, 'studio');
    deviceId = registered.deviceId;
    upstream = startUpstream(certs);
    const proxyPort = await upstream.listen();
    hub = startHubBridge(harness);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'device.json'), JSON.stringify({ user: 'user-1', token: registered.token, origin: hub.origin }), { mode: 0o600 });
    logPath = join(root, 'pc-agent.log');
    const log = openSync(logPath, 'a');

    daemon = Bun.spawn({
      cmd: [process.execPath, DAEMON_PATH],
      env: {
        ...process.env, KINU_HOME: home, KINU_INFLIGHT_ROOT: join(home, 'inflight'),
        HTTPS_PROXY: `http://127.0.0.1:${String(proxyPort)}`, NO_PROXY: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: certs.ca,
      },
      stdout: log, stderr: log, stdin: 'ignore',
    });

    await hub.connected;
  });

  afterAll(async () => {
    daemon.kill();
    await daemon.exited;
    await hub.stop();
    upstream.close();
    await harness.joinFibers();
    harness.close();
  });

  test('the machine is picked while it is online', async () => {
    expect(await harness.userDO.codexRelayDevice(await testOwner())).toEqual({ id: deviceId, label: 'studio' });
  });

  test('the answer streams back as chatgpt.com sends it, with the login\'s token and nothing logged', async () => {
    const owner = await testOwner();
    const before = upstream.calls.length;

    const response = await harness.userDO.relayCodex(owner, deviceId, 'call-stream', new Request(RESPONSES_URL, {
      method: 'POST', body: '{"model":"gpt-5.5"}',
      headers: { authorization: `Bearer ${ACCESS_TOKEN}`, 'content-type': 'application/json', 'x-kinu-target': 'dropped' },
    }));

    const call = upstream.calls[before];
    expect(call).toMatchObject({ method: 'POST', path: '/backend-api/codex/responses', authorization: `Bearer ${ACCESS_TOKEN}`, body: '{"model":"gpt-5.5"}' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-codex-primary-used-percent')).toBe('41');

    if (response.body === null) throw new Error('the relayed answer has no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Arrives while chatgpt.com still holds the answer open.
    expect(decoder.decode((await reader.read()).value)).toContain('response.created');

    const answer = upstream.answers[before];

    if (answer === undefined) throw new Error('the upstream answer is not held');
    answer.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    let rest = '';

    for (let next = await reader.read(); !next.done; next = await reader.read()) rest += decoder.decode(next.value);
    expect(rest).toContain('response.completed');
    expect(readFileSync(logPath, 'utf8')).not.toContain(ACCESS_TOKEN);
  });

  test('a Stop drops the call to chatgpt.com, not just the answer', async () => {
    const owner = await testOwner();
    const before = upstream.calls.length;

    const response = await harness.userDO.relayCodex(owner, deviceId, 'call-stop', new Request(RESPONSES_URL, {
      method: 'POST', body: '{}', headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    }));

    await harness.userDO.cancelCodexRelay(owner, 'call-stop');
    await expect(response.text()).rejects.toThrow('the caller stopped the request');

    const call = upstream.calls[before];

    if (call === undefined) throw new Error('the relay never reached chatgpt.com');
    await call.dropped;
  });
});

describe('the daemon carries only what core allows', () => {
  test('its frame names are core\'s', () => {
    expect([pcAgent.RELAY_METHOD, pcAgent.RELAY_HEAD_FRAME, pcAgent.RELAY_BODY_FRAME, pcAgent.RELAY_CANCEL_FRAME])
      .toEqual([DEVICE_RELAY.method, DEVICE_RELAY.head, DEVICE_RELAY.body, DEVICE_RELAY.cancel]);
  });

  test('its allow-list and core\'s agree on every route, host and method', () => {
    const urls = [
      ...pcAgent.RELAY_ROUTES.map((route) => `https://${pcAgent.RELAY_HOST}${route.split(' ')[1] ?? ''}`),
      'https://chatgpt.com/backend-api/codex/other', 'https://chatgpt.com:8443/backend-api/codex/responses',
      'http://chatgpt.com/backend-api/codex/responses', 'https://evil.example/backend-api/codex/responses',
    ];

    for (const url of urls) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        expect({ method, url, carried: pcAgent.relayRefusal(method, url) === null }).toEqual({ method, url, carried: codexEgressAllowed({ method, url }) });
      }
    }

    // Stricter than core, as the container is.
    expect(pcAgent.relayRefusal('GET', 'https://user:pass@chatgpt.com/backend-api/wham/usage')).not.toBeNull();
  });
});
