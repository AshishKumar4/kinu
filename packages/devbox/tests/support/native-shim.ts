import * as v from 'valibot';
import { createHash } from 'node:crypto';
import type { StoredValue } from '../../src/storage';

interface Disk {
  readonly files: Map<string, string>;
  readonly binaryFiles: ReadonlyMap<string, Uint8Array>;
  readonly directories: Set<string>;
  readonly fileFaults: Map<string, { readonly errno: number; readonly message: string }>;
  /** What `/proc/self/mountinfo` reports mounted by s3fs, which the shim's inspection reads. */
  readonly s3fsMounts: ReadonlySet<string>;
  writeFile(path: string, contents: string): Promise<{ readonly success: true }>;
  deleteFile(path: string): Promise<void>;
  mountBucket(name: string, path: string, options: { prefix: string; readOnly: boolean; s3fsOptions: string[] }): Promise<void>;
  unmountBucket(path: string): Promise<void>;
}

interface ShimIO {
  readonly stdout: ReadableStreamDefaultController<Uint8Array>;
  readonly stderr: ReadableStreamDefaultController<Uint8Array>;
  end(code?: number): void;
  fail(errno: number, message: string): void;
  input(stream: WritableStream<Uint8Array>): void;
}

/** One `sandbox-shim` invocation: its operation, its two path operands and the whole argv. */
interface ShimCall {
  readonly op: string;
  readonly path: string;
  readonly destination: string;
  readonly argv: readonly string[];
}

/** What a shim reply carries in its data frame. */
type ShimValue = { readonly [key: string]: StoredValue } | null;

const encode = new TextEncoder();

const decode = new TextDecoder();

const Configuration = v.object({
  source: v.object({ type: v.literal('s3'), endpoint: v.string(), region: v.string(), bucket: v.string() }),
  keyPrefix: v.optional(v.string()),
  access: v.picklist(['read-only', 'read-write']),
  s3fsOptions: v.array(v.object({ name: v.string(), value: v.optional(v.string()) })),
});

const Mount = v.object({ protocolVersion: v.literal(1), candidateRouteId: v.string(), mountPath: v.string(), configuration: Configuration });

const Marker = v.object({ protocolVersion: v.literal(1), routeId: v.string(), mountPath: v.string(), configuration: Configuration });

const markerPath = (path: string): string => '/run/sandbox/s3-mounts/markers/' + createHash('sha256').update(path).digest('hex') + '.json';

// sandbox-shim rc.1's wire contract: SBXF v1, little-endian payload length, then data.
function frame(kind: number, payload = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(10 + payload.length);

  bytes.set([0x53, 0x42, 0x58, 0x46, 1, kind]);
  new DataView(bytes.buffer).setUint32(6, payload.length, true);
  bytes.set(payload, 10);

  return bytes;
}

const json = (value: ShimValue) => frame(2, encode.encode(JSON.stringify({ ok: true, value })));

const failure = (errno: number, message: string) => {
  const text = encode.encode(message);
  const payload = new Uint8Array(4 + text.length);

  new DataView(payload.buffer).setInt32(0, errno, true);
  payload.set(text, 4);

  return frame(1, payload);
};

export class NativeShim {
  constructor(readonly disk: Disk) {}

  exec(argv: string[]): ExecProcess {
    const [op = '', path = '', destination = ''] = argv.slice(1);
    const exit = Promise.withResolvers<number>();
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    const out = new ReadableStream<Uint8Array>({ start(c) { stdout = c; } });
    const err = new ReadableStream<Uint8Array>({ start(c) { stderr = c; } });
    let ended = false;

    let input: WritableStream<Uint8Array> | null = op === 'write'
      ? new WritableStream({ write() { throw new Error('shim already exited'); } })
      : null;

    const end = (code = 0) => {
      if (ended) return;
      ended = true;
      stdout.close();
      stderr.close();
      exit.resolve(code);
    };

    const io: ShimIO = {
      stdout,
      stderr,
      end,
      fail(errno, message) {
        (op === 'read' ? stderr : stdout).enqueue(failure(errno, message));
        end();
      },
      input(stream) { input = stream; },
    };

    void this.#run({ op, path, destination, argv }, io).catch((...rejection: [unknown]) => {
      const [error] = rejection;

      stdout.error(error);
      stderr.error(error);
      exit.reject(error);
    });

    return {
      pid: 999,
      isPty: false,
      get stdin() { return input; },
      stdout: out,
      stderr: err,
      exitCode: exit.promise,
      kill() { end(137); },
      resize() { throw new Error('file shim has no PTY'); },
      async output() {
        const [sent, logged, exitCode] = await Promise.all([new Response(out).arrayBuffer(), new Response(err).arrayBuffer(), exit.promise]);

        return { stdout: sent, stderr: logged, exitCode };
      },
    };
  }

  async #run({ op, path, destination, argv }: ShimCall, io: ShimIO): Promise<void> {
    if (op === 's3-mount') return this.#mount(path, destination, io);
    const fault = this.disk.fileFaults.get(path);

    if (fault !== undefined) return io.fail(fault.errno, fault.message);
    const exists = this.disk.files.has(path) || this.disk.binaryFiles.has(path) || this.disk.directories.has(path);
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';

    if (op === 'write') return this.#write(path, parent, io);

    if (op === 'mkdir') return this.#mkdir(path, { exists, parent, recursive: argv.includes('--recursive') }, io);

    if (!exists) return io.fail(2, 'No such file or directory');

    switch (op) {
      case 'read':
        if (this.disk.directories.has(path)) return io.fail(21, 'Is a directory');
        io.stderr.enqueue(frame(0));
        io.stdout.enqueue(this.#bytes(path));
        io.stderr.enqueue(frame(0));
        break;
      case 'stat':
      case 'lstat':
        io.stdout.enqueue(this.#stat(path));
        break;
      case 'read-directory':
        if (!this.disk.directories.has(path)) return io.fail(20, 'Not a directory');
        io.stdout.enqueue(this.#directory(path));
        break;
      case 'rename':
        if (!this.disk.directories.has(destination.slice(0, destination.lastIndexOf('/')) || '/')) return io.fail(2, 'No such file or directory');
        this.#rename(path, destination);
        io.stdout.enqueue(frame(0));
        break;
      case 'remove':
        await this.disk.deleteFile(path);
        this.disk.directories.delete(path);
        io.stdout.enqueue(frame(0));
        break;
      default:
        throw new Error(`unmodelled file shim command ${op}`);
    }

    io.end();
  }

  #mkdir(path: string, at: { readonly exists: boolean; readonly parent: string; readonly recursive: boolean }, io: ShimIO): void {
    if (!at.recursive && at.exists) return io.fail(17, 'File exists');

    if (!at.recursive && !this.disk.directories.has(at.parent)) return io.fail(2, 'No such file or directory');
    let current = '';

    for (const part of path.split('/').filter(Boolean)) {
      current += '/' + part;
      this.disk.directories.add(current);
    }

    io.stdout.enqueue(frame(0));
    io.end();
  }

  #write(path: string, parent: string, io: ShimIO): void {
    if (!this.disk.directories.has(parent)) return io.fail(2, 'No such file or directory');

    if (this.disk.directories.has(path)) return io.fail(21, 'Is a directory');
    io.stdout.enqueue(frame(0));
    const chunks: Uint8Array[] = [];

    io.input(new WritableStream<Uint8Array>({
      write(bytes) { chunks.push(bytes.slice()); },
      close: async () => {
        const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
        let at = 0;

        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }

        await this.disk.writeFile(path, decode.decode(bytes));
        io.stdout.enqueue(frame(0));
        io.end();
      },
    }));
  }

  #stat(path: string): Uint8Array {
    const directory = this.disk.directories.has(path);
    const payload = new Uint8Array(45);
    const view = new DataView(payload.buffer);

    payload[0] = directory ? 1 : 0;
    view.setBigUint64(1, BigInt(this.#bytes(path).length), true);
    view.setUint32(9, directory ? 0o40755 : 0o100644, true);

    return frame(2, payload);
  }

  #bytes(path: string): Uint8Array {
    return this.disk.binaryFiles.get(path) ?? encode.encode(this.disk.files.get(path) ?? '');
  }

  #directory(path: string): Uint8Array {
    const entries = new Map<string, number>();
    const prefix = path.endsWith('/') ? path : path + '/';

    for (const file of [...this.disk.files.keys(), ...this.disk.binaryFiles.keys()]) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) entries.set(file.slice(prefix.length), 0);
    }

    for (const dir of this.disk.directories) {
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) entries.set(dir.slice(prefix.length), 1);
    }

    const rows = [...entries].map(([name, kind]) => ({ name: encode.encode(name), kind }));
    const payload = new Uint8Array(4 + rows.reduce((n, row) => n + 3 + row.name.length, 0));
    const view = new DataView(payload.buffer);
    let offset = 4;

    view.setUint32(0, rows.length, true);

    for (const row of rows) {
      payload[offset] = row.kind;
      view.setUint16(offset + 1, row.name.length, true);
      payload.set(row.name, offset + 3);
      offset += 3 + row.name.length;
    }

    return frame(2, payload);
  }

  #rename(path: string, destination: string): void {
    const content = this.disk.files.get(path);

    if (content !== undefined) {
      this.disk.files.set(destination, content);
      this.disk.files.delete(path);

      return;
    }

    for (const dir of Array.from(this.disk.directories)) {
      if (dir !== path && !dir.startsWith(path + '/')) continue;
      this.disk.directories.delete(dir);
      this.disk.directories.add(destination + dir.slice(path.length));
    }

    for (const [file, contents] of Array.from(this.disk.files)) {
      if (!file.startsWith(path + '/')) continue;
      this.disk.files.delete(file);
      this.disk.files.set(destination + file.slice(path.length), contents);
    }
  }

  async #mount(operation: string, destination: string, io: ShimIO): Promise<void> {
    const request = operation === 'mount' ? v.parse(Mount, JSON.parse(destination)) : undefined;
    const at = request?.mountPath ?? destination;
    const stored = this.disk.files.get(markerPath(at));
    const previous = stored === undefined ? undefined : v.parse(Marker, JSON.parse(stored));

    if (request !== undefined && previous !== undefined && JSON.stringify(previous.configuration) === JSON.stringify(request.configuration)) {
      io.stdout.enqueue(json(null));

      return io.end();
    }

    // `observation.rs:17-47`: no marker is `absent` unless something is mounted at the path.
    if (operation === 'inspect') {
      const unmarked = this.disk.s3fsMounts.has(at) ? { kind: 'unmanaged', filesystemType: 'fuse.s3fs' } : { kind: 'absent' };

      io.stdout.enqueue(json(previous === undefined
        ? { state: unmarked }
        : { state: { kind: 'managed', marker: previous, fuse: { status: 'connected' } }, gateway: { kind: 'usable' } }));

      return io.end();
    }

    if (operation === 'unmount' && previous === undefined) {
      io.stdout.enqueue(json(null));

      return io.end();
    }

    const routeId = previous?.routeId ?? request?.candidateRouteId;

    if (routeId === undefined) throw new Error(`unmodelled mount operation ${operation}`);
    io.stdout.enqueue(json({ kind: 'route', routeId }));

    io.input(new WritableStream<Uint8Array>({
      close: async () => {
        if (request === undefined) {
          await this.disk.unmountBucket(at);
          this.disk.files.delete(markerPath(at));
        } else {
          await this.disk.mountBucket(request.configuration.source.bucket, at, {
            prefix: request.configuration.keyPrefix ?? '',
            readOnly: request.configuration.access === 'read-only',
            s3fsOptions: request.configuration.s3fsOptions.map(({ name, value }) => value === undefined ? name : `${name}=${value}`),
          });
          this.disk.files.set(markerPath(at), JSON.stringify({ protocolVersion: 1, routeId, mountPath: at, configuration: request.configuration }));
        }

        io.stdout.enqueue(json(null));
        io.end();
      },
    }));
  }
}
