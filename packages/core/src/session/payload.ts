import { Effect } from 'effect';
import { settle } from '../obs/effect';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import * as v from 'valibot';

import { KinuError, toKinuError } from '../obs/error';
import { publishContent } from '../utils/vfs-helpers';
import { sha256Hex } from '../safety/argument-digest';
import { JsonObjectSchema, type JsonValue, type JsonObject } from '../utils/json';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { SPILL_DIRS } from '../context-budget';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { BinaryEnvelopeSchema } from './message-codec';

/** Inline JSON, or the file it spilled to; a spilled file is named by its bytes' digest, so the path is its whole address. */
export type SessionPayload =
  | { readonly json: string; readonly path: null }
  | { readonly json: null; readonly path: string };

export interface SessionFilePlane { readonly vfs: VFS; readonly artifactDirectory: string }

/** A stored payload's columns as the reference they hold: its JSON inline, or its file; null for both or neither, which
 *  every table that holds one refuses by its CHECK save for both empty, an absent payload. */
export function payloadReference(json: string | null, path: string | null): SessionPayload | null {
  if (json !== null && path === null) return { json, path: null };

  if (json === null && path !== null) return { json: null, path };

  return null;
}

/** The digest a spilled payload's file is named by, which its bytes must still have. */
export function spilledDigest(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/u, '');
}

/** A payload that must be there: one its columns do not reference fails. */
export function storedPayload(json: string | null, path: string | null): Effect.Effect<SessionPayload, KinuError> {
  const payload = payloadReference(json, path);

  return payload === null ? Effect.fail(new KinuError('io', 'invalid session payload reference')) : Effect.succeed(payload);
}

// Payload leaves half the platform row bound for keys/metadata; independent of model token policy.
const INLINE_BYTES = Math.floor(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value / 2);

const StringAttachmentReference = v.object({ $sessionStringAttachment: v.object({ path: v.string(), digest: v.string() }) });

const AttachmentReference = v.object({ $sessionAttachment: v.object({ path: v.string(), digest: v.string(), bytes: v.number(), buffer: v.optional(v.boolean()) }) });

/** A restored archive can hold a literal past float range (`1e400`); it parses to Infinity, which no JSON value holds. */
function storedJson(text: string): Effect.Effect<JsonValue, KinuError> {
  let outOfRange = false;

  const value: JsonValue = JSON.parse(text, (_key, item: JsonValue) => {
    if (typeof item === 'number' && !Number.isFinite(item)) outOfRange = true;

    return item;
  });

  return outOfRange ? Effect.fail(new KinuError('bad_input', 'a stored message holds a number out of JSON range')) : Effect.succeed(value);
}

export class SessionPayloadReader {
  /** `null`: no file plane, so spilled payloads are unreadable; check {@link readsFiles} first. */
  constructor(private readonly readableFiles: (() => Promise<Pick<VFS, 'readFile'>>) | null) {}

  get readsFiles(): boolean {
    return this.readableFiles !== null;
  }

  read(payload: SessionPayload): Promise<JsonValue> {
    return settle(this.readJson(payload));
  }

  readStored(json: string | null, path: string | null): Promise<JsonValue> {
    return settle(Effect.flatMap(storedPayload(json, path), (payload) => this.readJson(payload)));
  }

  private readJson(payload: SessionPayload): Effect.Effect<JsonValue, KinuError> {
    if (payload.json !== null) return Effect.suspend(() => storedJson(payload.json ?? ''));

    return this.readJsonFile(payload.path, spilledDigest(payload.path));
  }

  private readJsonFile(path: string, digest: string): Effect.Effect<JsonValue, KinuError> {
    return Effect.flatMap(this.readBytes(path, digest), (bytes) => storedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }

  resolveMedia(descriptor: JsonObject): Promise<JsonObject> {
    return settle(Effect.gen({ self: this }, function* () {
      const result = { ...descriptor };

      for (const field of ['image', 'data']) {
        const text = v.safeParse(StringAttachmentReference, result[field]);

        if (text.success) {
          const ref = text.output.$sessionStringAttachment;
          result[field] = v.parse(v.string(), yield* this.readJsonFile(ref.path, ref.digest));
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
    const json = JSON.stringify(value);

    // Most payloads are inline: they need no file and no runner, nor an encoding, as a UTF-16 unit is three bytes at most.
    if (json.length * 3 <= INLINE_BYTES) return Promise.resolve({ json, path: null });
    const bytes = new TextEncoder().encode(json);

    if (bytes.byteLength <= INLINE_BYTES) return Promise.resolve({ json, path: null });

    return settle(Effect.gen({ self: this }, function* () {
      const digest = sha256Hex(bytes);
      const directory = `${(yield* Effect.promise(() => this.files())).artifactDirectory}/${SPILL_DIRS.eventContent}`;
      const path = `${directory}/${digest}.json`;
      yield* this.publish(path, bytes, directory);

      return { json: null, path };
    }));
  }

  /** Only actual codec binary fields are externalized; existing URL/path references remain references. */
  externalizeMedia(descriptor: JsonObject): Promise<JsonObject> {
    return settle(Effect.gen({ self: this }, function* () {
      const stored = { ...descriptor };

      for (const field of ['image', 'data']) {
        const text = v.safeParse(v.string(), stored[field]);

        if (text.success && !/^https?:\/\//u.test(text.output) && !text.output.startsWith(`${SPILL_DIRS.offloaded}/`)) {
          const bytes = new TextEncoder().encode(JSON.stringify(text.output));
          const digest = sha256Hex(bytes);
          const directory = `${(yield* Effect.promise(() => this.files())).artifactDirectory}/${SPILL_DIRS.offloaded}`;
          const path = `${directory}/${digest}.json`;
          yield* this.publish(path, bytes, directory);
          stored[field] = { $sessionStringAttachment: { path, digest } };
          continue;
        }

        const binary = v.safeParse(BinaryEnvelopeSchema, stored[field]);

        if (!binary.success) continue;
        const bytes = base64ToBytes(binary.output.$binary);

        if (bytes.byteLength !== binary.output.bytes) return yield* new KinuError('io', 'attachment byte length differs from its codec envelope');
        const digest = sha256Hex(bytes);
        const directory = `${(yield* Effect.promise(() => this.files())).artifactDirectory}/${SPILL_DIRS.offloaded}`;
        const path = `${directory}/${digest}.bin`;
        yield* this.publish(path, bytes, directory);
        const reference: JsonObject = { path, digest, bytes: bytes.byteLength };

        if (binary.output.buffer !== undefined) reference.buffer = binary.output.buffer;
        stored[field] = { $sessionAttachment: reference };
      }

      return stored;
    }));
  }


  /** A payload's bytes at their path, read back before the reference to them is: other bytes there are a fault. */
  private publish(path: string, bytes: Uint8Array, directory: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { vfs } = yield* Effect.promise(() => this.files());

      yield* Effect.tryPromise({
        try: () => publishContent(vfs, { directory, path, bytes, otherBytes: 'refuse' }),
        catch: (cause) => toKinuError({ doing: 'publishing a session payload', cause, otherwise: 'io' }),
      });
      yield* this.readBytes(path, sha256Hex(bytes));
    });
  }

}
