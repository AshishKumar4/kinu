import * as v from 'valibot';
import type { VFS } from '../types/primitives';
import { KinuError } from '../obs/error';
import { classify } from '../obs/index';
import { sha256Hex } from '../safety/argument-digest';
import { JsonValueSchema, JsonObjectSchema, type JsonValue, type JsonObject } from '../utils/json';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { SPILL_DIRS } from '../context-budget';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';

export type SessionPayload =
  | { readonly json: string; readonly path: null; readonly digest: null }
  | { readonly json: null; readonly path: string; readonly digest: string };

export interface SessionFilePlane { readonly vfs: VFS; readonly artifactDirectory: string }

// Payload leaves half the platform row bound for keys/metadata; independent of model token policy.
const INLINE_BYTES = Math.floor(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value / 2);

const BinaryValue = v.object({ $binary: v.string(), bytes: v.number(), buffer: v.optional(v.boolean()) });

const StringAttachmentReference = v.object({ $sessionStringAttachment: v.object({ path: v.string(), digest: v.string() }) });

const AttachmentReference = v.object({ $sessionAttachment: v.object({ path: v.string(), digest: v.string(), bytes: v.number(), buffer: v.optional(v.boolean()) }) });

export class SessionPayloadReader {
  /** `null` is a reader with no file plane: a spilled payload is unreadable
   *  through it, so a caller asks {@link readsFiles} before reading one. */
  constructor(private readonly readableFiles: (() => Promise<Pick<VFS, 'readFile'>>) | null) {}

  get readsFiles(): boolean {
    return this.readableFiles !== null;
  }

  async read(payload: SessionPayload): Promise<JsonValue> {
    if (payload.json !== null) return v.parse(JsonValueSchema, JSON.parse(payload.json));
    const bytes = await this.readBytes(payload.path, payload.digest);

    return v.parse(JsonValueSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }

  async resolveMedia(descriptor: JsonObject): Promise<JsonObject> {
    const result = { ...descriptor };

    for (const field of ['image', 'data']) {
      const text = v.safeParse(StringAttachmentReference, result[field]);

      if (text.success) {
        const ref = text.output.$sessionStringAttachment;
        result[field] = v.parse(v.string(), await this.read({ json: null, path: ref.path, digest: ref.digest }));
        continue;
      }

      const reference = v.safeParse(AttachmentReference, result[field]);

      if (!reference.success) continue;
      const ref = reference.output.$sessionAttachment;
      const bytes = await this.readBytes(ref.path, ref.digest);

      if (bytes.byteLength !== ref.bytes) throw new KinuError('io', 'retained attachment length differs');
      const binary: JsonObject = { $binary: bytesToBase64(bytes), bytes: bytes.byteLength };

      if (ref.buffer !== undefined) binary.buffer = ref.buffer;
      result[field] = binary;
    }

    return v.parse(JsonObjectSchema, result);
  }

  protected async readBytes(path: string, digest: string): Promise<Uint8Array> {
    if (this.readableFiles === null) throw new KinuError('unavailable', `session payload ${path} is spilled to a file this reader has no plane for`);
    const stored = await (await this.readableFiles()).readFile(path);
    const bytes = v.is(v.string(), stored) ? new TextEncoder().encode(stored) : stored;

    if (sha256Hex(bytes) !== digest) throw new KinuError('io', `session payload digest differs at ${path}`);

    return bytes;
  }
}

/** File publication precedes SQL reference publication. This is not a cross-plane transaction. */
export class SessionPayloads extends SessionPayloadReader {
  constructor(private readonly files: () => Promise<SessionFilePlane>) {
    super(async () => (await files()).vfs);
  }

  async prepare(value: JsonValue): Promise<SessionPayload> {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);

    if (bytes.byteLength <= INLINE_BYTES) return { json, path: null, digest: null };
    const digest = sha256Hex(bytes);
    const directory = `${(await this.files()).artifactDirectory}/${SPILL_DIRS.eventContent}`;
    const path = `${directory}/${digest}.json`;
    await this.publish(path, bytes, directory);

    return { json: null, path, digest };
  }

  /** Only actual codec binary fields are externalized; existing URL/path references remain references. */
  async externalizeMedia(descriptor: JsonObject): Promise<JsonObject> {
    const stored = { ...descriptor };

    for (const field of ['image', 'data']) {
      const text = v.safeParse(v.string(), stored[field]);

      if (text.success && !/^https?:\/\//u.test(text.output) && !text.output.startsWith(`${SPILL_DIRS.attachments}/`)) {
        const bytes = new TextEncoder().encode(JSON.stringify(text.output));
        const digest = sha256Hex(bytes);
        const directory = `${(await this.files()).artifactDirectory}/${SPILL_DIRS.attachments}`;
        const path = `${directory}/${digest}.json`;
        await this.publish(path, bytes, directory);
        stored[field] = { $sessionStringAttachment: { path, digest } };
        continue;
      }

      const binary = v.safeParse(BinaryValue, stored[field]);

      if (!binary.success) continue;
      const bytes = base64ToBytes(binary.output.$binary);

      if (bytes.byteLength !== binary.output.bytes) throw new KinuError('io', 'attachment byte length differs from its codec envelope');
      const digest = sha256Hex(bytes);
      const directory = `${(await this.files()).artifactDirectory}/${SPILL_DIRS.attachments}`;
      const path = `${directory}/${digest}.bin`;
      await this.publish(path, bytes, directory);
      const reference: JsonObject = { path, digest, bytes: bytes.byteLength };

      if (binary.output.buffer !== undefined) reference.buffer = binary.output.buffer;
      stored[field] = { $sessionAttachment: reference };
    }

    return stored;
  }


  private async publish(path: string, bytes: Uint8Array, directory: string): Promise<void> {
    const digest = sha256Hex(bytes);
    const { vfs } = await this.files();

    if (!(await vfs.exists(path))) {
      try { await vfs.mkdir(directory, { recursive: true }); }
      catch (cause) { if (classify({ cause }) !== 'eexist') throw cause; }

      await vfs.writeFile(path, bytes);
    }

    await this.readBytes(path, digest);
  }

}
