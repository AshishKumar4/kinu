/**
 * `/api/drive/*`: the owner's Mossaic tenant, mounted at `/shared` in every workspace.
 * The tenant is never named on the wire; bytes cross in bounded chunks as in `files-routes.ts`.
 */
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import {
  err, ERROR_STATUS, FILE_CHUNK_BYTES, FILE_TRANSFER_MAX_BYTES, fileResponseHeaders, json,
  pumpUploadChunks, retryTransientDO, safeJson, type DriveFailure, type DriveUploadTarget, type UserCaller,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import type { DriveAnswer, UserDO } from '../user/user-do';
import { ownerGate, type ApiVariables, type FamilyEnv } from '../api/context';

export type DriveRouteObject = Pick<UserDO,
  | 'ensureProfile'
  | 'drive_list' | 'drive_mkdir' | 'drive_rename' | 'drive_delete' | 'drive_markAsSkill' | 'drive_addSkill'
  | 'drive_writeChunk' | 'drive_abortUpload' | 'drive_startDownload' | 'drive_readChunk' | 'drive_abortDownload'>;

interface DriveContext {
  readonly object: DriveRouteObject;
  readonly owner: UserCaller;
}

interface DriveVariables extends ApiVariables {
  owner: UserCaller;
  drive: DriveContext;
}

function failed(failure: DriveFailure): Response {
  return err(ERROR_STATUS[failure.code], failure.error);
}

function answered<Value>(answer: DriveAnswer<Value>): Response {
  return answer.ok ? json({ body: answer.value ?? { ok: true } }) : failed(answer);
}

const PathBody = v.strictObject({ path: v.string() });

const RenameBody = v.strictObject({ from: v.string(), to: v.string() });

const SkillBody = v.strictObject({ skill: v.string() });

function pathAction<Value>(act: (drive: DriveContext, path: string) => Promise<DriveAnswer<Value>>) {
  return async (c: Context<FamilyEnv<Env, DriveVariables>>): Promise<Response> => {
    const body = await safeJson(c.req.raw, PathBody);

    return body === null ? err(400, 'expected { path }') : answered(await act(c.get('drive'), body.path));
  };
}

export const driveRoutes = new Hono<FamilyEnv<Env, DriveVariables>>();

// The tenant derives from the profile row, so upsert it before any Drive call, known path or not.
driveRoutes.use('/api/drive/*', ownerGate(), async (c, next) => {
  const identity = c.get('identity');
  const owner = c.get('owner');
  const object: DriveRouteObject = c.env.UserDO.get(c.env.UserDO.idFromName(identity.userId));
  await retryTransientDO('ensureProfile', () => object.ensureProfile(owner, identity.email, identity.displayName ?? undefined));
  c.set('drive', { object, owner });
  await next();
});

driveRoutes.get('/api/drive', async (c) => {
  const { object, owner } = c.get('drive');

  return answered(await object.drive_list(owner, new URL(c.req.url).searchParams.get('path') ?? '/'));
});

driveRoutes.delete('/api/drive', async (c) => {
  const { object, owner } = c.get('drive');
  const target = new URL(c.req.url).searchParams.get('path');

  return target === null ? err(400, 'path query parameter required') : answered(await object.drive_delete(owner, target));
});

driveRoutes.post('/api/drive/folders', pathAction(({ object, owner }, path) => object.drive_mkdir(owner, path)));

driveRoutes.post('/api/drive/rename', async (c) => {
  const { object, owner } = c.get('drive');
  const body = await safeJson(c.req.raw, RenameBody);

  return body === null ? err(400, 'expected { from, to }') : answered(await object.drive_rename(owner, body.from, body.to));
});

driveRoutes.post('/api/drive/skills/mark', pathAction(({ object, owner }, path) => object.drive_markAsSkill(owner, path)));

driveRoutes.post('/api/drive/skills', async (c) => {
  const { object, owner } = c.get('drive');
  const body = await safeJson(c.req.raw, SkillBody);

  return body === null ? err(400, 'expected { skill }') : answered(await object.drive_addSkill(owner, body.skill));
});

driveRoutes.put('/api/drive/skills', async (c) =>
  upload(c.req.raw, c.get('drive'), { kind: 'skill', name: new URL(c.req.url).searchParams.get('name') }));

driveRoutes.put('/api/drive/files', async (c) => {
  const target = uploadTarget(new URL(c.req.url));

  return target === null ? err(400, 'path, or folder with unpack=zip, query parameter required') : upload(c.req.raw, c.get('drive'), target);
});

driveRoutes.get('/api/drive/files', async (c) => {
  const url = new URL(c.req.url);
  const target = url.searchParams.get('path');

  return target === null ? err(400, 'path query parameter required') : download(c.get('drive'), target, url.searchParams.get('download') !== null);
});

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

    if (cause instanceof KinuError) return err(ERROR_STATUS[cause.code], cause.message);
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
