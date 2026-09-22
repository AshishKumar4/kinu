/**
 * `/api/drive/*`: the owner's Mossaic tenant, mounted at `/shared` in every workspace.
 * The tenant is never named on the wire; bytes cross in bounded chunks as in `files-routes.ts`.
 */
import * as v from 'valibot';
import {
  err, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, fileResponseHeaders, json, ownerCaller, OwnerCapabilityUnavailableError,
  pumpUploadChunks, retryTransientDO, safeJson, type DriveFailure, type DriveUploadTarget, type UserCaller,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError, type ErrorCode } from '@kinu.run/core/obs';
import type { AuthIdentity } from '../auth/session';
import type { DriveAnswer, UserDO } from '../user/user-do';

const FAILURE_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_input: 400,
  denied: 403,
  missing: 404,
  unsupported: 415,
  budget: 413,
  unavailable: 503,
  timeout: 504,
  cancelled: 400,
  oom: 507,
  io: 500,
};

export type DriveRouteObject = Pick<UserDO,
  | 'drive_list' | 'drive_mkdir' | 'drive_rename' | 'drive_delete' | 'drive_markAsSkill' | 'drive_addSkill'
  | 'drive_writeChunk' | 'drive_abortUpload' | 'drive_startDownload' | 'drive_readChunk' | 'drive_abortDownload'>;

interface DriveContext {
  readonly object: DriveRouteObject;
  readonly owner: UserCaller;
}

function failed(failure: DriveFailure): Response {
  return err(FAILURE_STATUS[failure.code], failure.error);
}

function answered<Value>(answer: DriveAnswer<Value>): Response {
  return answer.ok ? json({ body: answer.value ?? { ok: true } }) : failed(answer);
}

const PathBody = v.strictObject({ path: v.string() });

const RenameBody = v.strictObject({ from: v.string(), to: v.string() });

const SkillBody = v.strictObject({ skill: v.string() });

async function resolveObject(env: Env, identity: AuthIdentity): Promise<DriveRouteObject> {
  const stub = env.UserDO.get(env.UserDO.idFromName(identity.userId));
  const owner = await ownerCaller(env);
  // The tenant derives from the profile row, so upsert it before any Drive call.
  await retryTransientDO('ensureProfile', () => stub.ensureProfile(owner, identity.email, identity.displayName ?? undefined));

  return stub;
}

export async function handleDriveRequest(
  request: Request,
  env: Env,
  identity: AuthIdentity,
  resolve: (env: Env, identity: AuthIdentity) => Promise<DriveRouteObject> = resolveObject,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== '/api/drive' && !url.pathname.startsWith('/api/drive/')) return null;
  let owner: UserCaller;

  try { owner = await ownerCaller(env); }
  catch (cause) {
    if (cause instanceof OwnerCapabilityUnavailableError) return err(503, cause.message);
    throw cause;
  }

  const ctx: DriveContext = { object: await resolve(env, identity), owner };
  const path = url.pathname.slice('/api/drive'.length);
  const method = request.method;

  if (path === '' && method === 'GET') return answered(await ctx.object.drive_list(owner, url.searchParams.get('path') ?? '/'));

  if (path === '' && method === 'DELETE') {
    const target = url.searchParams.get('path');

    return target === null ? err(400, 'path query parameter required') : answered(await ctx.object.drive_delete(owner, target));
  }

  if (path === '/folders' && method === 'POST') {
    const body = await safeJson(request, PathBody);

    return body === null ? err(400, 'expected { path }') : answered(await ctx.object.drive_mkdir(owner, body.path));
  }

  if (path === '/rename' && method === 'POST') {
    const body = await safeJson(request, RenameBody);

    return body === null ? err(400, 'expected { from, to }') : answered(await ctx.object.drive_rename(owner, body.from, body.to));
  }

  if (path === '/skills/mark' && method === 'POST') {
    const body = await safeJson(request, PathBody);

    return body === null ? err(400, 'expected { path }') : answered(await ctx.object.drive_markAsSkill(owner, body.path));
  }

  if (path === '/skills' && method === 'POST') {
    const body = await safeJson(request, SkillBody);

    return body === null ? err(400, 'expected { skill }') : answered(await ctx.object.drive_addSkill(owner, body.skill));
  }

  if (path === '/skills' && method === 'PUT') {
    return upload(request, ctx, { kind: 'skill', name: url.searchParams.get('name') });
  }

  if (path === '/files' && method === 'PUT') {
    const target = uploadTarget(url);

    return target === null ? err(400, 'path, or folder with unpack=zip, query parameter required') : upload(request, ctx, target);
  }

  if (path === '/files' && method === 'GET') {
    const target = url.searchParams.get('path');

    return target === null ? err(400, 'path query parameter required') : download(ctx, target, url.searchParams.get('download') !== null);
  }

  return null;
}

function uploadTarget(url: URL): DriveUploadTarget | null {
  const folder = url.searchParams.get('folder');

  if (folder !== null && url.searchParams.get('unpack') === 'zip') return { kind: 'zip', folder };
  const path = url.searchParams.get('path');

  return path === null ? null : { kind: 'file', path };
}

async function upload(request: Request, ctx: DriveContext, target: DriveUploadTarget): Promise<Response> {
  if (request.body === null) return err(400, 'request body required');
  const transferId = crypto.randomUUID();

  const abandon = async (): Promise<void> => {
    try {
      await ctx.object.drive_abortUpload(ctx.owner, transferId);
    } catch (abortCause) {
      diagnostics.failure('drive.upload_abort_failed', toKinuError({
        doing: 'aborting a failed chunked Drive upload',
        cause: abortCause,
        otherwise: 'unavailable',
      }), { kind: target.kind });
    }
  };

  try {
    const outcome = await pumpUploadChunks(request, async (offset, chunk, final) => {
      const written = await ctx.object.drive_writeChunk(ctx.owner, { target, transferId, offset, chunk, final });

      if (!final && !written.ok) throw new KinuError(written.code, written.error);

      return written;
    });

    if (outcome === 'too_large') {
      await abandon();

      return err(413, `the upload exceeds the ${String(Math.floor(FILE_TRANSFER_MAX_BYTES / (1024 * 1024)))} MiB transfer limit`);
    }

    if (outcome instanceof KinuError) {
      await abandon();
      diagnostics.failure('drive.upload_body_unreadable', outcome, { kind: target.kind });

      return err(400, 'the upload stopped before the whole file arrived');
    }

    return answered(outcome.result);
  } catch (cause) {
    await abandon();

    if (cause instanceof KinuError) return err(FAILURE_STATUS[cause.code], cause.message);
    diagnostics.failure('drive.upload_failed', toKinuError({
      doing: 'streaming an upload to the Drive',
      cause,
      otherwise: 'unavailable',
    }), { kind: target.kind });

    return err(500, cause instanceof Error ? cause.message : 'upload failed');
  }
}

async function download(ctx: DriveContext, path: string, asAttachment: boolean): Promise<Response> {
  const transferId = crypto.randomUUID();
  const opened = await ctx.object.drive_startDownload(ctx.owner, path, transferId);

  if (!opened.ok) return failed(opened);
  const { size, name } = opened.value;
  let offset = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) {
        await ctx.object.drive_abortDownload(ctx.owner, transferId);
        controller.close();

        return;
      }

      const chunk = await ctx.object.drive_readChunk(ctx.owner, transferId, offset, Math.min(FILE_CHUNK_BYTES, size - offset));

      if (!chunk.ok) {
        await ctx.object.drive_abortDownload(ctx.owner, transferId);
        controller.error(new KinuError(chunk.code, chunk.error));

        return;
      }

      offset += chunk.value.bytes.byteLength;
      controller.enqueue(chunk.value.bytes);
    },
    async cancel() {
      await ctx.object.drive_abortDownload(ctx.owner, transferId);
    },
  });

  return new Response(stream, { headers: fileResponseHeaders(`/${name}`, asAttachment || name.endsWith('.zip')) });
}
