import { Nimbus } from '@nimbus-sh/sdk';
import { SOUL_PATH, type ArchiveFileSource } from '@kinu/core';
import { createHash, createHmac } from 'node:crypto';
import { previewHostSuffix } from './lib/preview-origin';
import { timingSafeEqual } from './lib/crypto';
import { buildNimbusPreviewHost, encodeBase32, parseNimbusPreviewLabel } from './lib/nimbus-preview-host';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';

const NIMBUS_SUBJECT = 'workspace';

export function nimbusWorkspaceSessionId(ownerUserId: string, workspaceName: string): string {
  const digest = createHash('sha256')
    .update('kinu:nimbus-workspace:v1\0')
    .update(ownerUserId)
    .update('\0')
    .update(workspaceName)
    .digest('hex');
  return `p${digest.slice(0, 24)}`;
}

function nimbusWorkspaceStub(env: Env, ownerUserId: string, workspaceName: string) {
  const sessionId = nimbusWorkspaceSessionId(ownerUserId, workspaceName);
  const stubName = `${sessionId}:${NIMBUS_SUBJECT}:${sessionId}`;
  return env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(stubName));
}

export function nimbusSandboxConfig(origin: string) {
  return {
    endpoint: origin,
    sandboxes: {
      default: {
        root: "/home/user",
        runtimes: {
          onDemand: true,
          allow: ["node", "bun", "npm", "git", "python", "ruby", "clang", "shell"],
        },
        tools: { namespace: "workspace", kind: "workspace" },
      },
    },
  };
}

export function publicOriginForNimbus(env: Env): string {
  if (env.CLI_PUBLIC_ORIGIN && env.CLI_PUBLIC_ORIGIN.length > 0) {
    return env.CLI_PUBLIC_ORIGIN.replace(/\/+$/, '');
  }
  return 'https://kinu.local';
}

/** The single constructor for a hosted workspace's authoritative Nimbus
 * session. Runtime use, export, and destruction must derive exactly the same
 * Durable Object name from owner + workspace identity. */
export function createNimbusWorkspaceSandbox(env: Env, ownerUserId: string, workspaceName: string) {
  const sessionId = nimbusWorkspaceSessionId(ownerUserId, workspaceName);
  const origin = publicOriginForNimbus(env);
  const nimbusEnv = {
    NIMBUS_SESSION: env.NIMBUS_SESSION,
  };
  return Nimbus.fromEnv(
    nimbusEnv,
    nimbusSandboxConfig(origin),
    { binding: 'NIMBUS_SESSION' },
  ).sandbox(sessionId, {
    tenant: sessionId,
    subject: NIMBUS_SUBJECT,
    root: '/home/user',
  });
}

export async function writeNimbusWorkspaceSoul(
  env: Env,
  ownerUserId: string,
  workspaceName: string,
  content: string,
): Promise<void> {
  await nimbusWorkspaceStub(env, ownerUserId, workspaceName)
    ._rpcWriteProtectedRootFile('/home/user', `/home/user/${SOUL_PATH}`, content);
}

function previewSecrets(env: Env): string[] {
  const current = env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!current) return [];
  const retired = (env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [current, ...retired];
}

export function nimbusPreviewConfigured(env: Env): boolean {
  return previewHostSuffix(env) !== null && previewSecrets(env).length > 0;
}

function previewToken(secret: string, sessionId: string, port: number, capability: string): string {
  const digest = createHmac('sha256', secret)
    .update(`kinu:nimbus-preview:v2:${sessionId}:${port}:${capability}`)
    .digest();
  return encodeBase32(digest).slice(0, 15);
}

export function nimbusPreviewUrl(
  env: Env,
  ownerUserId: string,
  workspaceName: string,
  port: number,
  capability: string,
): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (!/^[a-f0-9]{24}$/.test(capability)) return undefined;
  const suffix = previewHostSuffix(env);
  const secret = previewSecrets(env)[0];
  if (!suffix || !secret) return undefined;
  const sessionId = nimbusWorkspaceSessionId(ownerUserId, workspaceName);
  const token = previewToken(secret, sessionId, port, capability);
  const host = buildNimbusPreviewHost(port, sessionId, token, capability, suffix);
  return `https://${host}/`;
}

export async function handleNimbusPreviewHostRequest(request: Request, env: Env): Promise<Response | null> {
  const suffix = previewHostSuffix(env);
  if (!suffix) return null;
  const url = new URL(request.url);
  const suffixWithDot = `.${suffix}`;
  if (!url.hostname.endsWith(suffixWithDot)) return null;
  const label = url.hostname.slice(0, -suffixWithDot.length);
  const preview = parseNimbusPreviewLabel(label);
  if (!preview) return null;
  const { port, sessionId, token, capability } = preview;
  const secrets = previewSecrets(env);
  if (secrets.length === 0) {
    return new Response('Preview authentication is unavailable.', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (!secrets.some((secret) => timingSafeEqual(token, previewToken(secret, sessionId, port, capability)))) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  const headers = sanitizePreviewRequestHeaders(request.headers);
  headers.delete('x-nimbus-base');
  const stub = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(
    `${sessionId}:${NIMBUS_SUBJECT}:${sessionId}`,
  ));
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: request.redirect,
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = 'half';
  }
  if (headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const target = new URL(request.url);
    target.pathname = `/port/${port}${url.pathname}`;
    headers.set('x-nimbus-preview-capability', capability);
    return stub.fetch(new Request(target, init));
  }
  return stub._rpcRouteCapabilityPort(port, capability, new Request(request.url, init), url.pathname);
}

/** Adapt the Nimbus SDK's authoritative workspace root to the archive stream.
 * Only metadata is accumulated; file bodies remain one-at-a-time reads in the
 * archive pager. Unsupported node kinds fail the backup instead of silently
 * producing an incomplete one. */
export function nimbusWorkspaceArchiveFiles(
  box: ReturnType<typeof createNimbusWorkspaceSandbox>,
): ArchiveFileSource {
  const root = '/home/user';
  return {
    async listEntries() {
      const entries: Array<{ path: string; type: 'file' | 'directory' }> = [];
      const walk = async (absolute: string, relative: string): Promise<void> => {
        const children = [...await box.files.list(absolute)].sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (!child.name || child.name === '.' || child.name === '..' || child.name.includes('/')) {
            throw new Error(`Workspace archive encountered an invalid Nimbus entry name: ${JSON.stringify(child.name)}.`);
          }
          const path = relative ? `${relative}/${child.name}` : child.name;
          if (child.type !== 'file' && child.type !== 'directory') {
            throw new Error(`Workspace archive cannot preserve ${child.type} entry ${JSON.stringify(path)}.`);
          }
          entries.push({ path, type: child.type });
          if (child.type === 'directory') await walk(`${absolute}/${child.name}`, path);
        }
      };
      await walk(root, '');
      return entries;
    },
    async readFile(path) {
      const bytes = await box.files.readBytes(`${root}/${path}`);
      if (bytes === null) throw new Error(`Workspace file disappeared during export: ${JSON.stringify(path)}.`);
      return bytes;
    },
  };
}
