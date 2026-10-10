import * as v from 'valibot';
import { Effect } from 'effect';
import { attempt, attemptSync, DevboxError } from './errors';

const Reply = v.variant('ok', [
  v.object({ ok: v.literal(true), sha256: v.string() }),
  v.object({ ok: v.literal(false), sha256: v.nullable(v.string()) }),
]);

export type DigestWrite = v.InferOutput<typeof Reply>;

/** A write's name across its sends: a UUID, safe as a file name in the guest. */
const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Writes `data` at `path` only if the file's bytes hash to `expected` (null: only if no file is there). One guest
 * process reads the new bytes from stdin, compares, and replaces through a temp file and a rename, so the compare and
 * the write are the guest's own instant, and a reader never sees half a file.
 */
export function writeFileIfDigest(
  container: Pick<Container, 'exec'>,
  { path, data, expected, operation }: { readonly path: string; readonly data: Uint8Array; readonly expected: string | null; readonly operation: string },
): Effect.Effect<DigestWrite, DevboxError> {
  return Effect.gen(function* () {
    if (!path.startsWith('/') || path.includes('\0')) return yield* Effect.fail(new DevboxError('file', `a digest write needs an absolute path, not ${JSON.stringify(path)}`));

    if (!OPERATION.test(operation)) return yield* Effect.fail(new DevboxError('file', `a digest write is named by a UUID, not ${JSON.stringify(operation)}`));
    const writer = yield* attempt('io', () => container.exec(['python3', '-c', WRITE_IF_DIGEST, path, expected ?? '', operation], { stdin: 'pipe' }));
    const stdin = writer.stdin;

    if (stdin === null) return yield* Effect.fail(new DevboxError('io', 'the digest write took no stdin'));
    yield* attempt('io', () => new Blob([new Uint8Array(data)]).stream().pipeTo(stdin), `writing ${path}`);
    const output = yield* attempt('io', () => writer.output());
    const decoder = new TextDecoder();

    if (output.exitCode !== 0) {
      return yield* Effect.fail(new DevboxError('file', `the digest write of ${path} exited ${String(output.exitCode)}: ${decoder.decode(output.stderr)}`));
    }

    return yield* attemptSync('io', () => v.parse(v.pipe(v.string(), v.parseJson(), Reply), decoder.decode(output.stdout)),
      'the digest write answered outside its contract');
  });
}

const WRITE_IF_DIGEST = `
import hashlib, json, os, secrets, sys
path, expected = sys.argv[1], sys.argv[2] or None
data = sys.stdin.buffer.read()
try:
    with open(path, 'rb') as held:
        found = hashlib.sha256(held.read()).hexdigest()
    mode = os.stat(path).st_mode & 0o7777
except FileNotFoundError:
    found, mode = None, None
if found != expected:
    print(json.dumps({'ok': False, 'sha256': found}))
    sys.exit(0)
directory = os.path.dirname(path) or '/'
os.makedirs(directory, exist_ok=True)
temporary = os.path.join(directory, '.' + os.path.basename(path) + '.' + secrets.token_hex(6) + '.kinu-write')
try:
    # Created with the replaced file's mode and given the bits the umask cut before any byte is written.
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666 if mode is None else mode)
    with os.fdopen(descriptor, 'wb') as out:
        if mode is not None:
            os.fchmod(descriptor, mode)
        out.write(data)
    os.rename(temporary, path)
except BaseException:
    if os.path.exists(temporary):
        os.unlink(temporary)
    raise
print(json.dumps({'ok': True, 'sha256': hashlib.sha256(data).hexdigest()}))
`;
