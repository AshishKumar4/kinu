import { Effect } from 'effect';
import { settle, tolerateAsync } from '../obs/effect';
import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
import * as v from 'valibot';

import { KinuError } from '../obs/error';
import { sha256Hex } from '../safety/argument-digest';
import { JsonValueSchema, JsonObjectSchema, type JsonValue, type JsonObject } from '../utils/json';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { SPILL_DIRS } from '../context-budget';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';

export type SessionPayload =
  | { readonly json: string; readonly path: null; readonly digest: null }
  | { readonly json: null; readonly path: string; readonly digest: string };

export interface SessionFilePlane { readonly vfs: VFS; readonly artifactDirectory: string }

export function storedPayload(json: string | null, path: string | null, digest: string | null): Effect.Effect<SessionPayload, KinuError> {
  if (json !== null && path === null && digest === null) return Effect.succeed({ json, path: null, digest: null });

  if (json === null && path !== null && digest !== null) return Effect.succeed({ json: null, path, digest });

  return Effect.fail(new KinuError('io', 'invalid session payload reference'));
}

// Payload leaves half the platform row bound for keys/metadata; independent of model token policy.
const INLINE_BYTES = Math.floor(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value / 2);

const BinaryValue = v.object({ $binary: v.string(), bytes: v.number(), buffer: v.optional(v.boolean()) });

const StringAttachmentReference = v.object({ $sessionStringAttachment: v.object({ path: v.string(), digest: v.string() }) });

const AttachmentReference = v.object({ $sessionAttachment: v.object({ path: v.string(), digest: v.string(), bytes: v.number(), buffer: v.optional(v.boolean()) }) });

export class SessionPayloadReader {
  /** `null`: no file plane, so spilled payloads are unreadable; check {@link readsFiles} first. */
  constructor(private readonly readableFiles: (() => Promise<Pick<VFS, 'readFile'>>) | null) {}

  get readsFiles(): boolean {
    return this.readableFiles !== null;
  }

  read(payload: SessionPayload): Promise<JsonValue> {
    return settle(this.readJson(payload));
  }

  readStored(json: string | null, path: string | null, digest: string | null): Promise<JsonValue> {
    return settle(Effect.flatMap(storedPayload(json, path, digest), (payload) => this.readJson(payload)));
  }

  private readJson(payload: SessionPayload): Effect.Effect<JsonValue, KinuError> {
    if (payload.json !== null) return Effect.sync(() => v.parse(JsonValueSchema, JSON.parse(payload.json ?? '')));

    return Effect.map(this.readBytes(payload.path, payload.digest), (bytes) => v.parse(JsonValueSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
  }

  resolveMedia(descriptor: JsonObject): Promise<JsonObject> {
    return settle(Effect.gen({ self: this }, function* () {
      const result = { ...descriptor };

      for (const field of ['image', 'data']) {
        const text = v.safeParse(StringAttachmentReference, result[field]);

        if (text.success) {
          const ref = text.output.$sessionStringAttachment;
          result[field] = v.parse(v.string(), yield* this.readJson({ json: null, path: ref.path, digest: ref.digest }));
          continue;
        }

        const reference = v.safeParse(AttachmentReference, result[field]);

        if (!reference.success) continue;
        const ref = reference.output.$sessionAttachment;
        const bytes = yield* this.readBytes(ref.path, ref.digest);

        if (bytes.byteLength !== ref.bytes) return yield* new KinuError('io', 'retained attachment length differs');
        const binary: JsonObject = { $binary: bytesToBase64(bytes), bytes: bytes.byteLength };

        if (ref.buffer !== undefined) binary.buffer = ref.buffer;
        result[field] = binary;
      }

      return v.parse(JsonObjectSchema, result);
    }));
  }

  protected readBytes(path: string, digest: string): Effect.Effect<Uint8Array, KinuError> {
    const readable = this.readableFiles;

    if (readable === null) return Effect.fail(new KinuError('unavailable', `session payload ${path} is spilled to a file this reader has no plane for`));

    return Effect.flatMap(Effect.promise(async () => (await readable()).readFile(path)), (stored) => {
      const bytes = v.is(v.string(), stored) ? new TextEncoder().encode(stored) : stored;

      return sha256Hex(bytes) === digest ? Effect.succeed(bytes) : Effect.fail(new KinuError('io', `session payload digest differs at ${path}`));
    });
  }
}

/** File publication precedes SQL reference publication. This is not a cross-plane transaction. */
export class SessionPayloads extends SessionPayloadReader {
  constructor(private readonly files: () => Promise<SessionFilePlane>) {
    super(async () => (await files()).vfs);
  }

  prepare(value: JsonValue): Promise<SessionPayload> {
    return settle(Effect.gen({ self: this }, function* () {
      const json = JSON.stringify(value);
      const bytes = new TextEncoder().encode(json);

      if (bytes.byteLength <= INLINE_BYTES) return { json, path: null, digest: null };
      const digest = sha256Hex(bytes);
      const directory = `${(yield* Effect.promise(() => this.files())).artifactDirectory}/${SPILL_DIRS.eventContent}`;
      const path = `${directory}/${digest}.json`;
      yield* this.publish(path, bytes, directory);

      return { json: null, path, digest };
    }));
  }

  /** Only actual codec binary fields are externalized; existing URL/path references remain references. */
  externalizeMedia(descriptor: JsonObject): Promise<JsonObject> {
    return settle(Effect.gen({ self: this }, function* () {
      const stored = { ...descriptor };

      for (const field of ['image', 'data']) {
        const text = v.safeParse(v.string(), stored[field]);

        if (text.success && !/^https?:\/\//u.test(text.output) && !text.output.startsWith(`${SPILL_DIRS.attachments}/`)) {
          const bytes = new TextEncoder().encode(JSON.stringify(text.output));
          const digest = sha256Hex(bytes);
          const directory = `${(yield* Effect.promise(() => this.files())).artifactDirectory}/${SPILL_DIRS.attachments}`;
          const path = `${directory}/${digest}.json`;
          yield* this.publish(path, bytes, directory);
          stored[field] = { $sessionStringAttachment: { path, digest } };
          continue;
        }

        const binary = v.safeParse(BinaryValue, stored[field]);

        if (!binary.success) continue;
        const bytes = base64ToBytes(binary.output.$binary);

        if (bytes.byteLength !== binary.output.bytes) return yield* new KinuError('io', 'attachment byte length differs from its codec envelope');
        const digest = sha256Hex(bytes);
        const directory = `${(yield* Effect.promise(() => this.files())).artifactDirectory}/${SPILL_DIRS.attachments}`;
        const path = `${directory}/${digest}.bin`;
        yield* this.publish(path, bytes, directory);
        const reference: JsonObject = { path, digest, bytes: bytes.byteLength };

        if (binary.output.buffer !== undefined) reference.buffer = binary.output.buffer;
        stored[field] = { $sessionAttachment: reference };
      }

      return stored;
    }));
  }


  private publish(path: string, bytes: Uint8Array, directory: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const digest = sha256Hex(bytes);
      const { vfs } = yield* Effect.promise(() => this.files());

      if (!(yield* Effect.promise(() => exists(vfs, path)))) {
        yield* Effect.promise(() => tolerateAsync(async () => vfs.mkdir(directory, { recursive: true }), 'eexist'));
        yield* Effect.promise(async () => vfs.writeFile(path, bytes));
      }

      yield* this.readBytes(path, digest);
    });
  }

}
