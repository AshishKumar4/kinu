import * as v from 'valibot';
import { Effect } from 'effect';
import type { ListFilesOptions, ListedFile } from './contracts';
import { attempt, attemptSync, DevboxError } from './errors';

const Entry = v.object({
  name: v.string(), path: v.string(), absolutePath: v.string(),
  type: v.picklist(['file', 'directory', 'symlink', 'blockDevice', 'characterDevice', 'fifo', 'socket']),
  size: v.number(), mode: v.number(), mtimeMs: v.number(), uid: v.number(), gid: v.number(),
  atimeMs: v.number(), ctimeMs: v.number(), isDirectory: v.boolean(),
});

const Reply = v.union([
  v.object({ files: v.array(Entry) }),
  v.object({ error: v.object({ code: v.string(), path: v.string(), operation: v.picklist(['readDirectory', 'lstat']), detail: v.string() }) }),
]);

/** One guest process enumerates and lstats the entries; no child metadata crosses the exec boundary alone. */
export function listFiles(container: Pick<Container, 'exec'>, path: string, options: ListFilesOptions = {}): Effect.Effect<{ files: ListedFile[] }, DevboxError> {
  return Effect.gen(function* () {
    if (typeof path !== 'string') return yield* Effect.fail(new DevboxError('file', 'path must be a string', { cause: new TypeError('path must be a string') }));

    if (path.length === 0) return yield* Effect.fail(new DevboxError('file', 'path must not be empty', { cause: new TypeError('path must not be empty') }));

    if (path.includes('\0')) return yield* Effect.fail(new DevboxError('file', 'path cannot contain NUL characters', { cause: new TypeError('path cannot contain NUL characters') }));

    if (!path.startsWith('/')) return yield* Effect.fail(new DevboxError('file', 'cwd is required when path is relative', { cause: new TypeError('cwd is required when path is relative') }));

    const output = yield* attempt('io', async () => await (await container.exec(['python3', '-c', LIST_FILES, path, options.recursive === true ? '1' : '0'])).output());

    const decoder = new TextDecoder();

    if (output.exitCode !== 0) {
      return yield* Effect.fail(new DevboxError('io', `directory metadata read exited ${String(output.exitCode)}: ${decoder.decode(output.stderr)}`));
    }

    const reply = yield* attemptSync('io', () => v.parse(v.pipe(v.string(), v.parseJson(), Reply), decoder.decode(output.stdout)),
      'the directory metadata read answered outside its contract');

    if ('error' in reply) {
      const error = reply.error;

      return yield* Effect.fail(new DevboxError('file', `${error.operation} '${error.path}': ${error.detail}`, {
        cause: { kind: 'devbox.file', code: error.code, path: error.path, operation: error.operation },
      }));
    }

    return reply;
  });
}

const LIST_FILES = `
import errno, json, os, stat, sys
for name in ('EAGAIN', 'EDEADLK', 'EOPNOTSUPP'):
    errno.errorcode[getattr(errno, name)] = name
kinds = {stat.S_IFREG: 'file', stat.S_IFDIR: 'directory', stat.S_IFLNK: 'symlink',
         stat.S_IFBLK: 'blockDevice', stat.S_IFCHR: 'characterDevice', stat.S_IFIFO: 'fifo', stat.S_IFSOCK: 'socket'}
files = []
operation, path = 'readDirectory', sys.argv[1]
def visit(directory):
    global operation, path
    operation, path = 'readDirectory', directory
    with os.scandir(os.fsencode(directory)) as entries:
        for entry in entries:
            name = entry.name.decode('utf-8')
            absolute = directory.removesuffix('/') + '/' + name
            operation, path = 'lstat', absolute
            metadata = entry.stat(follow_symlinks=False)
            kind = kinds[stat.S_IFMT(metadata.st_mode)]
            files.append({'name': name, 'path': absolute, 'absolutePath': absolute, 'type': kind,
                          'size': metadata.st_size, 'mode': metadata.st_mode, 'mtimeMs': metadata.st_mtime_ns // 1000000,
                          'uid': metadata.st_uid, 'gid': metadata.st_gid, 'atimeMs': metadata.st_atime_ns // 1000000,
                          'ctimeMs': metadata.st_ctime_ns // 1000000, 'isDirectory': kind == 'directory'})
            if sys.argv[2] == '1' and kind == 'directory':
                visit(absolute)
            operation, path = 'readDirectory', directory
try:
    visit(sys.argv[1])
    print(json.dumps({'files': files}, ensure_ascii=True))
except OSError as error:
    print(json.dumps({'error': {'code': errno.errorcode.get(error.errno, 'UNKNOWN'), 'path': path,
                               'operation': operation, 'detail': error.strerror}}, ensure_ascii=True))
`;
