/**
 * How the credentialed session file plane PUBLISHES a file, and what survives
 * when it cannot.
 *
 * Every write on this plane stages bytes beside the target and then publishes
 * them in one step. Two properties follow from that shape, and both are
 * invisible to a test that only checks the file afterwards:
 *
 *   1. The unconditional publication is a same-directory rename. It moves what
 *      was staged; it never reads the staged file back, so a large write costs
 *      no whole-file buffer in the session process, and the target is either
 *      the old file or the new one at every instant.
 *   2. A publication that fails leaves the PREVIOUS bytes and no staging file.
 *
 * There is no compare-and-write arm at all, and the last describe below is why:
 * this session reports no path revision and its write carries no precondition,
 * so the plane declares none and the product states the refusal instead.
 *
 * The session here answers exactly like the runner program does — one process
 * per request, an in-memory filesystem behind it — so the assertions are about
 * the REQUESTS the plane issues, which is where both properties live.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { nimbusSessionFiles, type NimbusSandboxHandle } from '../src/execution/nimbus';
import { AGENT_FS_CHUNK_BYTES } from '../src/execution/nimbus-agent-files';
import {
  readExecutorFile, writeExecutorFileOp, type ExecutorFileLookup,
} from '../src/read-models/files';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { VFS } from '../src/types/primitives';

const CRED: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const TARGET = '/home/user/report.bin';

const RequestSchema = v.object({
  op: v.string(),
  path: v.optional(v.string()),
  temp: v.optional(v.string()),
  b64: v.optional(v.string()),
  off: v.optional(v.number()),
  len: v.optional(v.number()),
  recursive: v.optional(v.boolean()),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
});
type Request = v.InferOutput<typeof RequestSchema>;

/**
 * What the runner answers, in the shape `AnswerSchema` parses: `{ ok: true }`
 * with whatever the operation learned, or a refusal carrying the errno the
 * substrate raised.
 */
type RunnerAnswer =
  | {
    readonly ok: true;
    readonly size?: number;
    readonly mtimeMs?: number;
    readonly dir?: boolean;
    readonly names?: readonly string[];
    readonly b64?: string;
    readonly n?: number;
  }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** What the session was asked to do, and what it refuses. `refuse` answers the
 *  n-th call of an op the way the runner reports a failed syscall. */
interface SessionOptions {
  seed?: Record<string, string>;
  refuse?: { op: string; nth?: number; code: string; message: string };
}

interface Session {
  box: NimbusSandboxHandle;
  /** Every request the plane issued, in order. */
  requests: Request[];
  files: Map<string, Uint8Array>;
}

function bytesOf(file: Uint8Array | undefined): string {
  return file === undefined ? '<absent>' : new TextDecoder().decode(file);
}

/**
 * A session whose `exec` IS the runner: it takes the one request the plane put
 * in the environment and applies it to an in-memory filesystem with the same
 * semantics the program has — chiefly a rename that moves the cell rather than
 * copying its bytes.
 */
function session(options: SessionOptions = {}): Session {
  const files = new Map<string, Uint8Array>();
  const requests: Request[] = [];
  const seen = new Map<string, number>();
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(options.seed ?? {})) {
    files.set(path, encoder.encode(content));
  }
  const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

  const apply = (request: Request): RunnerAnswer => {
    const refuse = options.refuse;
    if (refuse && request.op === refuse.op) {
      const nth = (seen.get(refuse.op) ?? 0) + 1;
      seen.set(refuse.op, nth);
      if (nth === (refuse.nth ?? 1)) return { ok: false, code: refuse.code, message: refuse.message };
    }
    const temp = request.temp ?? '';
    const path = request.path ?? '';
    switch (request.op) {
      case 'stat': {
        const file = files.get(path);
        if (!file) return { ok: false, code: 'ENOENT', message: `no such file: ${path}` };
        return { ok: true, size: file.byteLength, mtimeMs: 1, dir: false };
      }
      case 'read': {
        const file = files.get(path);
        if (!file) return { ok: false, code: 'ENOENT', message: `no such file: ${path}` };
        const slice = file.subarray(request.off ?? 0, (request.off ?? 0) + (request.len ?? 0));
        return { ok: true, b64: encode(slice), n: slice.byteLength };
      }
      case 'stage': {
        files.set(temp, decode(request.b64 ?? ''));
        return { ok: true };
      }
      case 'append': {
        const held = files.get(temp) ?? new Uint8Array(0);
        const added = decode(request.b64 ?? '');
        const joined = new Uint8Array(held.byteLength + added.byteLength);
        joined.set(held, 0);
        joined.set(added, held.byteLength);
        files.set(temp, joined);
        return { ok: true };
      }
      case 'commit': {
        const staged = files.get(temp);
        if (!staged) return { ok: false, code: 'ENOENT', message: `no such file: ${temp}` };
        files.set(path, staged);
        files.delete(temp);
        return { ok: true };
      }
      case 'discard': {
        files.delete(temp);
        return { ok: true };
      }
      case 'unlink': {
        files.delete(path);
        return { ok: true };
      }
      default:
        return { ok: false, code: 'EIO', message: `unknown operation ${request.op}` };
    }
  };

  const unreached = (member: string) => async (): Promise<never> => {
    throw new Error(`the credentialed plane reached box.files.${member}, which it must not`);
  };
  const box: NimbusSandboxHandle = {
    ready: async () => {},
    exec: async (command, execOptions) => {
      // The plane hands the runner exactly one request, in the environment.
      const [raw] = Object.values(execOptions?.env ?? {});
      const request = v.parse(v.pipe(v.string(), v.parseJson(), RequestSchema), raw ?? '');
      requests.push(request);
      return {
        command, success: true, stdout: JSON.stringify(apply(request)), stderr: '', exitCode: 0,
      };
    },
    // The credentialed plane speaks to the session ONLY through `exec` — every
    // file operation is the runner program. These are here so that claim is
    // enforced rather than asserted: reaching one fails the test that did.
    files: {
      read: unreached('read'),
      write: unreached('write'),
      list: unreached('list'),
      exists: unreached('exists'),
      delete: unreached('delete'),
    },
  };
  return { box, requests, files };
}

/** The UNcredentialed session: the SDK's own `files.*` surface, which is what
 *  the origin plane reads and writes through. */
interface OriginSession {
  box: NimbusSandboxHandle;
  files: Map<string, Uint8Array>;
}

function originSession(): OriginSession {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const box: NimbusSandboxHandle = {
    ready: async () => {},
    exec: async (command) => ({ command, success: false, stdout: '', stderr: 'no shell here', exitCode: 1 }),
    files: {
      read: async (path) => {
        const held = files.get(path);
        return held === undefined ? null : new TextDecoder().decode(held);
      },
      readBytes: async (path) => files.get(path)?.slice() ?? null,
      // The SDK's shape exactly: no options, no answer. That IS the reason this
      // plane cannot offer a conditional write.
      write: async (path, content) => {
        files.set(path, content instanceof Uint8Array ? content.slice() : encoder.encode(content));
      },
      // And its stat's shape exactly: no revision to compare against.
      stat: async (path) => {
        const held = files.get(path);
        return held === undefined ? null : { type: 'file', size: held.byteLength, mtime: 1 };
      },
      list: async () => [],
      exists: async (path) => files.has(path),
      delete: async (path) => { files.delete(path); },
    },
  };
  return { box, files };
}

/** The one-provider router the read model looks a plane up through. */
function lookupFor(vfs: VFS): ExecutorFileLookup {
  return { getProvider: () => ({ files: vfs, homeDir: async () => '/home/user' }) };
}

/** A payload that cannot cross in one call, so the staging loop is real. */
function payload(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let at = 0; at < bytes; at++) out[at] = at % 251;
  return out;
}

describe('an unconditional write publishes with a rename', () => {
  test('the staged bytes are moved, never read back', async () => {
    const rail = session({ seed: { [TARGET]: 'the previous file' } });
    const vfs = nimbusSessionFiles(rail.box, CRED);

    await vfs.writeFile(TARGET, payload(AGENT_FS_CHUNK_BYTES + 7));

    // stage, one append for the tail, then the publication — and no `read`:
    // the session process never materializes the staged file to publish it.
    expect(rail.requests.map((request) => request.op)).toEqual(['stage', 'append', 'commit']);
    expect(rail.requests.at(-1)).toEqual({ op: 'commit', path: TARGET, temp: rail.requests[0]?.temp });
  });

  test('the temp is a sibling of the target, because a rename is atomic in one directory', async () => {
    const rail = session();
    const vfs = nimbusSessionFiles(rail.box, CRED);

    await vfs.writeFile(TARGET, new TextEncoder().encode('one chunk'));

    const staged = rail.requests[0]?.temp ?? '';
    expect(staged.startsWith(`${TARGET}.kinu-`)).toBe(true);
    expect(staged.endsWith('.part')).toBe(true);
    expect(staged.slice(0, staged.lastIndexOf('/'))).toBe(TARGET.slice(0, TARGET.lastIndexOf('/')));
  });

  test('a file larger than one call crosses in bounded chunks and lands byte-exact', async () => {
    const rail = session();
    const vfs = nimbusSessionFiles(rail.box, CRED);
    const big = payload(AGENT_FS_CHUNK_BYTES * 2 + 11);

    await vfs.writeFile(TARGET, big);

    expect(rail.requests.map((request) => request.op)).toEqual(['stage', 'append', 'append', 'commit']);
    // Every call stays under the wire bound, which is what the loop is for.
    for (const request of rail.requests) {
      if (request.b64 === undefined) continue;
      expect(atob(request.b64).length).toBeLessThanOrEqual(AGENT_FS_CHUNK_BYTES);
    }
    expect([...(rail.files.get(TARGET) ?? [])]).toEqual([...big]);
    expect([...rail.files.keys()]).toEqual([TARGET]);
  });
});

describe('a publication that never happens leaves the previous file', () => {
  test('a session that dies mid-transfer publishes nothing and drops the staging file', async () => {
    const rail = session({
      seed: { [TARGET]: 'the previous file' },
      refuse: { op: 'append', code: 'EIO', message: 'the session went away' },
    });
    const vfs = nimbusSessionFiles(rail.box, CRED);

    await expect(vfs.writeFile(TARGET, payload(AGENT_FS_CHUNK_BYTES + 7)))
      .rejects.toThrow('the session went away');

    expect(bytesOf(rail.files.get(TARGET))).toBe('the previous file');
    expect([...rail.files.keys()]).toEqual([TARGET]);
    expect(rail.requests.map((request) => request.op)).toEqual(['stage', 'append', 'discard']);
  });

  test('a publication step that fails is not a half-written file', async () => {
    const rail = session({
      seed: { [TARGET]: 'the previous file' },
      refuse: { op: 'commit', code: 'EIO', message: 'the rename failed' },
    });
    const vfs = nimbusSessionFiles(rail.box, CRED);

    await expect(vfs.writeFile(TARGET, new TextEncoder().encode('the replacement')))
      .rejects.toThrow('the rename failed');

    expect(bytesOf(rail.files.get(TARGET))).toBe('the previous file');
    expect([...rail.files.keys()]).toEqual([TARGET]);
  });
});

/**
 * What a Nimbus session answers an in-place editor save.
 *
 * Neither plane can offer compare-and-write: the SDK's `files.write` takes no
 * precondition and returns nothing, its `stat` reports no revision, and the
 * credentialed runner's `fs` drops the option and reports no revision either.
 * So both DECLARE nothing, and the read model — the seam the files route and
 * the viewer both go through — turns that absence into a stated refusal instead
 * of a race nobody can see.
 */
describe('a plane with no compare-and-write says so, once, in one voice', () => {
  const CANNOT_PROTECT =
    'This file plane cannot protect an in-place edit from a newer write. Download it to edit safely.';

  test('neither session plane declares a conditional write', () => {
    const rail = session();
    expect(nimbusSessionFiles(rail.box, CRED).writeFileIfRevision).toBeUndefined();
    expect(nimbusSessionFiles(originSession().box).writeFileIfRevision).toBeUndefined();
  });

  test('an in-place save is refused as unsupported, and writes nothing', async () => {
    const origin = originSession();
    const router = lookupFor(nimbusSessionFiles(origin.box));
    origin.files.set(TARGET, new TextEncoder().encode('the previous file'));

    const refused = await writeExecutorFileOp(
      router, 'workspace', TARGET, new TextEncoder().encode('the replacement'), 3,
    );

    expect(refused).toEqual({ unsupported: true, error: CANNOT_PROTECT });
    expect(bytesOf(origin.files.get(TARGET))).toBe('the previous file');
  });

  test('an unconditional save still goes through, so the plane is not read-only', async () => {
    const origin = originSession();
    const router = lookupFor(nimbusSessionFiles(origin.box));

    expect(await writeExecutorFileOp(
      router, 'workspace', TARGET, new TextEncoder().encode('the replacement'),
    )).toEqual({ ok: true });
    expect(bytesOf(origin.files.get(TARGET))).toBe('the replacement');
  });

  test('the viewer is handed the reason rather than an edit token', async () => {
    // The credentialed plane, because a preview READS: this file's session
    // answers the runner's own ranged read, which is the path the viewer takes.
    const rail = session({ seed: { '/home/user/notes.md': 'editable text' } });
    const router = lookupFor(nimbusSessionFiles(rail.box, CRED));

    const viewed = await readExecutorFile(router, 'workspace', '/home/user/notes.md');

    expect(viewed.content).toBe('editable text');
    expect(viewed.revision).toBeUndefined();
    expect(viewed.readOnlyReason).toBe(CANNOT_PROTECT);
  });
});

/**
 * The runner program, taken out of the command the plane actually sends and
 * executed against a recording `fs`.
 *
 * The publication step's cost and its atomicity are properties of the PROGRAM,
 * not of the request stream: a commit that read its staging file back and wrote
 * the bytes over the target would issue the same one request and answer the
 * same `{ ok: true }`. So the program is run here, with `require('fs')` stubbed
 * at the only boundary it has.
 */
function runnerOf(command: string): string {
  const program = command.slice('node -e '.length);
  if (!program.startsWith("'") || !program.endsWith("'")) {
    throw new Error(`the plane no longer sends a quoted program: ${command.slice(0, 40)}`);
  }
  return program.slice(1, -1).replaceAll("'\\''", "'");
}

/** One filesystem call the program made: the syscall's name and the path it
 *  named. */
interface FsCall {
  readonly name: string;
  readonly path: string;
}

/** What one run of the program did: the answer it wrote, and the filesystem
 *  calls it made to get there. */
interface RunnerRun {
  readonly answer: RunnerAnswer;
  readonly calls: readonly FsCall[];
}

const RunnerAnswerSchema = v.union([
  v.object({
    ok: v.literal(true),
    size: v.optional(v.number()),
    mtimeMs: v.optional(v.number()),
    dir: v.optional(v.boolean()),
    names: v.optional(v.array(v.string())),
    b64: v.optional(v.string()),
    n: v.optional(v.number()),
  }),
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
]);

/** Run the program for one request and report what it asked of the filesystem. */
function driveRunner(
  command: string,
  env: Record<string, string>,
  files: Map<string, Uint8Array>,
): RunnerRun {
  const calls: FsCall[] = [];
  const fs = {
    readFileSync: (path: string) => {
      calls.push({ name: 'readFileSync', path });
      return Buffer.from(files.get(path) ?? new Uint8Array(0));
    },
    writeFileSync: (path: string, data: Uint8Array) => {
      calls.push({ name: 'writeFileSync', path });
      files.set(path, new Uint8Array(data));
    },
    appendFileSync: (path: string, data: Uint8Array) => {
      calls.push({ name: 'appendFileSync', path });
      const held = files.get(path) ?? new Uint8Array(0);
      const joined = new Uint8Array(held.byteLength + data.byteLength);
      joined.set(held, 0);
      joined.set(data, held.byteLength);
      files.set(path, joined);
    },
    unlinkSync: (path: string) => {
      calls.push({ name: 'unlinkSync', path });
      files.delete(path);
    },
    renameSync: (from: string, to: string) => {
      calls.push({ name: 'renameSync', path: from });
      const held = files.get(from);
      if (held === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      files.set(to, held);
      files.delete(from);
    },
    statSync: (path: string) => {
      calls.push({ name: 'statSync', path });
      return { size: files.get(path)?.byteLength ?? 0, mtimeMs: 1, isDirectory: () => false };
    },
  };
  const stdout: string[] = [];
  // The program is a `node -e` body: `require`, `process` and `Buffer` are the
  // whole of its world, and each is supplied here rather than inherited.
  const body = new Function('require', 'process', 'Buffer', runnerOf(command));
  body(
    (name: string) => {
      if (name !== 'fs') throw new Error(`the runner now requires ${name}`);
      return fs;
    },
    { env, stdout: { write: (chunk: string) => stdout.push(chunk) } },
    Buffer,
  );
  return {
    answer: v.parse(v.pipe(v.string(), v.parseJson(), RunnerAnswerSchema), stdout.join('')),
    calls,
  };
}

/** The one exec the plane issued for its publication step: the command carrying
 *  the program, and the environment carrying the request. */
interface PublicationCall {
  readonly command: string;
  readonly env: Record<string, string>;
  readonly files: Map<string, Uint8Array>;
}

async function publicationCall(
  write: (vfs: VFS) => Promise<void>,
  seed: Record<string, string> = {},
): Promise<PublicationCall> {
  const sent: Array<{ command: string; env: Record<string, string> }> = [];
  const rail = session({ seed });
  const recorded: NimbusSandboxHandle = {
    ...rail.box,
    exec: async (command, options) => {
      sent.push({ command, env: { ...options?.env } });
      return rail.box.exec(command, options);
    },
  };
  await write(nimbusSessionFiles(recorded, CRED));
  const publication = sent.at(-1);
  if (!publication) throw new Error('the plane issued no request');
  return { ...publication, files: rail.files };
}

describe('the runner program, executed', () => {
  test('an unconditional publication is one rename, and reads no bytes', async () => {
    const call = await publicationCall(
      (vfs) => vfs.writeFile(TARGET, new TextEncoder().encode('the replacement')),
      { [TARGET]: 'the previous file' },
    );
    const files = new Map([[`${TARGET}.staged`, new TextEncoder().encode('the replacement')]]);
    files.set(TARGET, new TextEncoder().encode('the previous file'));
    const env = { ...call.env };
    const request = v.parse(v.pipe(v.string(), v.parseJson(), RequestSchema), Object.values(env)[0] ?? '');
    files.set(request.temp ?? '', new TextEncoder().encode('the replacement'));

    const run = driveRunner(call.command, env, files);

    expect(run.answer).toEqual({ ok: true });
    expect(run.calls.map((entry) => entry.name)).toEqual(['renameSync']);
    expect(bytesOf(files.get(TARGET))).toBe('the replacement');
    expect(files.has(request.temp ?? '')).toBe(false);
  });

  test('a publication onto a staging file that is gone refuses instead of emptying the target', async () => {
    const call = await publicationCall(
      (vfs) => vfs.writeFile(TARGET, new TextEncoder().encode('the replacement')),
      { [TARGET]: 'the previous file' },
    );
    const files = new Map([[TARGET, new TextEncoder().encode('the previous file')]]);

    const run = driveRunner(call.command, { ...call.env }, files);

    expect(run.answer).toMatchObject({ ok: false, code: 'ENOENT' });
    expect(bytesOf(files.get(TARGET))).toBe('the previous file');
  });
});
