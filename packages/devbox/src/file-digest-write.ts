import * as v from 'valibot';
import { Effect } from 'effect';
import { attempt, attemptSync, DevboxError } from './errors';

const Reply = v.variant('ok', [
  v.object({ ok: v.literal(true), sha256: v.string() }),
  v.object({ ok: v.literal(false), sha256: v.nullable(v.string()) }),
]);

export type DigestWrite = v.InferOutput<typeof Reply>;

/** One digest write as a caller sends it: the new bytes as base64, the digest they replace, and its sends' names. */
export interface DigestWriteRequest {
  readonly path: string;
  readonly contentBase64: string;
  readonly expected: string | null;
  /** This write's name across every send of it. */
  readonly operation: string;
  /** The caller's earlier writes whose answers it holds. */
  readonly settled: readonly string[];
}

/** A write's name across its sends: a UUID, safe as a file name in the guest. */
const OPERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Writes `data` at `path` only if the file's bytes hash to `expected` (null: only if no file is there). One guest
 * process reads the new bytes from stdin, compares the file `path` leads to and writes over it in place, as a plain write
 * does: the file keeps its inode, owner, group, mode, extended attributes and every other link to it, and a file this
 * user may not write is refused. Writers of one name take turns on its directory and writers of one file under other
 * names (hard links) on the file, so a compare and its write are one step under every name.
 *
 * The guest keeps each `operation`'s answer, so a resend after a lost reply gets the first send's outcome rather than a
 * second compare; a send cut after its bytes landed is answered that its write stands, unless the file changed again
 * before the resend. `settled` names the operations whose answers the caller holds: no send of them is left, so their
 * answers go. What the caller never acknowledges goes with the container's `/tmp`.
 */
export function writeFileIfDigest(
  container: Pick<Container, 'exec'>,
  { path, data, expected, operation, settled }: {
    readonly path: string; readonly data: Uint8Array; readonly expected: string | null; readonly operation: string; readonly settled: readonly string[];
  },
): Effect.Effect<DigestWrite, DevboxError> {
  return Effect.gen(function* () {
    if (!path.startsWith('/') || path.includes('\0')) return yield* Effect.fail(new DevboxError('file', `a digest write needs an absolute path, not ${JSON.stringify(path)}`));

    for (const named of [operation, ...settled]) {
      if (!OPERATION.test(named)) return yield* Effect.fail(new DevboxError('file', `a digest write is named by a UUID, not ${JSON.stringify(named)}`));
    }

    const writer = yield* attempt('io', () => container.exec(['python3', '-c', WRITE_IF_DIGEST, path, expected ?? '', operation, ...settled], { stdin: 'pipe' }));
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
import fcntl, hashlib, json, os, secrets, sys
path, expected, operation, settled = sys.argv[1], sys.argv[2] or None, sys.argv[3], sys.argv[4:]
data = sys.stdin.buffer.read()
digest = hashlib.sha256(data).hexdigest()
# Each operation's answer, kept for its resends: a resend after a lost reply is answered what the first send did, and
# one that arrives while the first still runs waits for it.
journal = '/tmp/kinu-digest-writes'
os.makedirs(journal, mode=0o700, exist_ok=True)
for done in settled:
    for kept in (done + '.json', done + '.lock'):
        try:
            os.unlink(os.path.join(journal, kept))
        except FileNotFoundError:
            pass
answered = os.path.join(journal, operation + '.json')
# Recorded before the write starts and dropped with its answer: a resend that finds it was cut while it wrote.
intent = os.path.join(journal, operation + '.intent')
lock = os.open(os.path.join(journal, operation + '.lock'), os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(lock, fcntl.LOCK_EX)
if os.path.exists(answered):
    with open(answered) as first:
        sys.stdout.write(first.read())
    sys.exit(0)
def record(target, content):
    pending = target + '.' + secrets.token_hex(6)
    with open(pending, 'w') as out:
        out.write(content)
    os.rename(pending, target)
def answer(reply):
    text = json.dumps(reply)
    record(answered, text)
    if os.path.exists(intent):
        os.unlink(intent)
    print(text)
if expected is None:
    os.makedirs(os.path.dirname(path) or '/', exist_ok=True)
# The file every link in path leads to, as the read that hashed expected followed them: it is compared and written and
# the links stay, and a dangling link's file is created, as a plain write creates it.
directory, name = os.path.split(os.path.realpath(path))
try:
    folder = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
except FileNotFoundError:
    # No directory, so no file. A create gets here through a link into a missing directory, which a plain write refuses.
    if expected is None:
        raise
    answer({'ok': False, 'sha256': None})
    sys.exit(0)
fcntl.flock(folder, fcntl.LOCK_EX)
try:
    held = os.open(name, os.O_RDONLY, dir_fd=folder)
except FileNotFoundError:
    held, found = None, None
else:
    fcntl.flock(held, fcntl.LOCK_EX)
    with open(held, 'rb', closefd=False) as reading:
        found = hashlib.sha256(reading.read()).hexdigest()
if os.path.exists(intent):
    # The first send passed its compare and was cut while it wrote: if its bytes are there, its write stands.
    if found == digest:
        answer({'ok': True, 'sha256': digest})
        sys.exit(0)
    os.unlink(intent)
if found != expected:
    answer({'ok': False, 'sha256': found})
    sys.exit(0)
record(intent, digest)
try:
    # A create only where nothing is yet; a write over a file still there.
    written = os.open(name, os.O_WRONLY | (os.O_CREAT | os.O_EXCL if held is None else os.O_TRUNC), 0o666, dir_fd=folder)
    with open(written, 'wb') as out:
        out.write(data)
except BaseException:
    os.unlink(intent)
    raise
answer({'ok': True, 'sha256': digest})
`;
