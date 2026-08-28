import { Nimbus } from '@nimbus-sh/sdk';
import {
  SOUL_PATH, summarizeSoulBytes, workspacePath, NativeSinkPlan,
  type ArchiveFileSource, type ForkFileSink, type ForkFileSource, type ForkNativeFilePort,
} from '@kinu.run/core';
import { createHash, createHmac } from 'node:crypto';
import { previewHostSuffix } from './lib/preview-origin';
import { timingSafeEqual } from './lib/crypto';
import { buildNimbusPreviewHost, encodeBase32, parseNimbusPreviewLabel } from './lib/nimbus-preview-host';
import { sanitizePreviewRequestHeaders } from './lib/preview-request';
import { reoriginateRequest } from './lib/http';

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

/** The owner-protected SOUL write: kernel-owned, read-only, whole content in
 *  one argument. Bytes as well as text, so a fork publishes the exact frame it
 *  received without decoding it first. */
export async function writeNimbusWorkspaceSoul(
  env: Env,
  ownerUserId: string,
  workspaceName: string,
  content: string | Uint8Array,
): Promise<void> {
  await nimbusWorkspaceStub(env, ownerUserId, workspaceName)
    ._rpcWriteProtectedRootFile('/home/user', `/home/user/${SOUL_PATH}`, content);
}

/** The fork receiver's only direct Nimbus filesystem authority. It is kept
 * outside the general sandbox file handle because range writes are staging-only. */
export function createNimbusWorkspaceForkSink(
  env: Env, ownerUserId: string, workspaceName: string, transferId: string,
): ForkFileSink {
  const stub = nimbusWorkspaceStub(env, ownerUserId, workspaceName);
  const native: ForkNativeFilePort = {
    async truncate(path, size) { await stub._rpcFsTruncate(workspacePath(path), size); },
    async writeRange(path, offset, bytes) {
      await stub._rpcFsWriteRange(workspacePath(path), offset, bytes);
    },
    // The staged temp read back for the whole-file digest. Ranged, and through
    // the same typed read the source half streams with: the isolate that
    // finishes a file need not be the one that wrote its first range, so the
    // check has to come off the staging rather than out of memory.
    async readRange(path, offset, length) {
      const bytes = await stub._rpcFsReadRange(workspacePath(path), offset, length);
      if (bytes === null) {
        throw new Error(`fork staging lost ${JSON.stringify(path)} before it could be verified`);
      }
      return bytes;
    },
    async rename(from, to) { await stub._rpcRename(workspacePath(from), workspacePath(to)); },
    async unlink(path) { await stub._rpcUnlink(workspacePath(path)); },
  };
  return new NativeSinkPlan(native, transferId, {
    // Ordinary files publish by rename. SOUL cannot: the owner's protected
    // write chowns the file to the kernel and takes whole content
    // (`_rpcWriteProtectedRootFile`), and renaming a session-user temp over
    // SOUL would publish the identity document without that ownership.
    owns: (targetPath) => targetPath === SOUL_PATH,
    // Published from the ONE frame SOUL arrived in — the same bytes the sink
    // was handed, sent straight into the protected write. Nothing is staged on
    // disk for it, and the mission is read from the head of those bytes rather
    // than by decoding the document into a second whole copy.
    async publish(_targetPath, bytes) {
      await writeNimbusWorkspaceSoul(env, ownerUserId, workspaceName, bytes);
      return { mission: summarizeSoulBytes(bytes) };
    },
  });
}

/** The source half of a hosted fork: the workspace plane's own walk, with each
 * inherited file read one range at a time through the session's typed ranged
 * read rather than materialized whole. */
export function createNimbusWorkspaceForkSource(
  env: Env, ownerUserId: string, workspaceName: string, plane: ForkFileSource,
): ForkFileSource {
  const stub = nimbusWorkspaceStub(env, ownerUserId, workspaceName);
  return {
    ...plane,
    async readRange(path, offset, length) {
      const bytes = await stub._rpcFsReadRange(workspacePath(path), offset, length);
      if (bytes === null) {
        throw new Error(`fork source lost ${JSON.stringify(path)} while streaming it`);
      }
      return bytes;
    },
  };
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
  // One construction policy, shared with container egress: `request.body` is
  // handed over unwrapped so a fixed-length upload stays fixed-length across
  // the hop. The headers are the SANITIZED set — a preview is agent-controlled
  // guest code, so the browser's Kinu session and every `x-kinu-*` header are
  // already gone by here, and this must never become a path that puts them
  // back.
  if (headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const target = new URL(request.url);
    target.pathname = `/port/${port}${url.pathname}`;
    headers.set('x-nimbus-preview-capability', capability);
    return stub.fetch(reoriginateRequest(request, target.toString(), {
      headers, redirect: request.redirect,
    }));
  }
  return stub._rpcRouteCapabilityPort(
    port,
    capability,
    reoriginateRequest(request, request.url, { headers, redirect: request.redirect }),
    url.pathname,
  );
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
