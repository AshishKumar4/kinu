/**
 * A Nimbus session's files AS ONE AGENT — the same session, the same bytes, one
 * credential.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A SECOND FILESYSTEM. A hosted session's file
 * RPCs are pid-less, and the worker resolves a pid-less caller to the session
 * user (`session/rpc.js` `callerCred`); the SDK's `files.*` surface carries no
 * pid and no credential to change that. So an agent whose HOME is its own uid
 * could not write its own home through the file tools at all — measured `EACCES`
 * on `/home/node-aX9` — while its commands could. One tree reached by two
 * identities is the bug; this module removes the second identity, never the
 * second tree.
 *
 * THE CREDENTIAL RIDES `exec`, the one hosted surface that accepts one. What
 * runs is the session's own `node` (`/usr/local/bin/node`, v20, measured
 * present) executing ONE fixed program, as the agent. That program is the whole
 * protocol:
 *
 *   - The REQUEST is JSON in one environment variable. Not the command line,
 *     because a path or a payload there would be shell text; not `stdin`,
 *     because this runtime's `fs.readFileSync(0)` refuses (measured).
 *   - The RESPONSE is JSON on stdout, carrying the substrate's OWN errno code.
 *     So there is no prose matching anywhere: `EACCES` arrives as `EACCES`.
 *   - Names round-trip as JSON strings, so a filename holding a newline, a
 *     quote or a leading dash lists, reads, renames and deletes exactly. `ls`
 *     cannot express those and this does.
 *
 * It reaches the same rows the agent's shell does: node's `fs` inside the
 * session is the session filesystem at the process credential — a write here is
 * visible to the uid-0 view immediately, and a sibling's write is refused
 * (both measured).
 *
 * BYTES ARE CHUNKED, and the chunk is the wire bound rather than a file-size
 * limit. A read loops until short-read EOF; a write stages into a temp file in
 * the SAME directory, appends chunk by chunk, then renames onto the target, so a
 * failure mid-write leaves the old target byte-exact and removes the temp. There
 * is no total-size cap: this plane is the workspace's own file surface, and a
 * cap here would refuse files the uncredentialed plane accepts.
 *
 * NO COMPARE-AND-WRITE, and the absence is deliberate. This session reports no
 * path revision — its `stat` carries size and mtime — and no write it offers
 * carries a precondition, so there is nothing to compare against and nothing to
 * enforce with. The plane therefore declares no `writeFileIfRevision` at all: an
 * in-place editor save is REFUSED with a reason rather than raced
 * (`writeExecutorFileOp` answers `unsupported`, the files route turns that into
 * 409, and the viewer stays read-only pointing at download-and-edit). Emulating
 * the guarantee with a read/compare/write sequence here would claim to have
 * closed a window this plane cannot even see.
 *
 * COST, stated because it is not free: one session call per chunk, plus one to
 * commit a write. A small file is 1 call to read and 2 to write.
 *
 * The uncredentialed plane stays exactly as it was — `box.files.*`, the fast
 * path, and the identity the ORIGIN reads and writes with.
 */

import * as v from 'valibot';
import type { VFS, VfsEntryStat } from '../types/primitives';
import type { VfsNativeMutations, VfsNativeReads } from '../vfs/mounts';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { makeVfsError, type VfsErrorCode } from '../vfs/errno';
import { workspacePath } from '../vfs/workspace-path';
import { shellQuote } from '../utils/shell';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { FILE_CHUNK_BYTES } from '../read-models/files';
import { diagnostics, toKinuError } from '../obs/index';
import type { NimbusSandboxHandle } from './nimbus';

/** Where the request JSON travels. One variable, module-private by convention
 *  and by the fact that only the program below reads it. */
const REQUEST_ENV = 'KINU_AGENT_FS_REQUEST';

/**
 * Raw bytes per session call, derived from the catalogued per-RPC payload bound
 * and base64's 4/3 expansion, then rounded down to a multiple of 3 so an encoded
 * chunk never carries padding into the middle of a stream.
 *
 * A WIRE BOUND, not a file-size limit: a read loops to EOF and a write appends,
 * so a file larger than this crosses in several calls rather than being refused.
 * Exported because the boundary is the interesting case to test.
 */
export const AGENT_FS_CHUNK_BYTES = Math.floor(FILE_CHUNK_BYTES * 3 / 4 / 3) * 3;

/**
 * The runner. One program, no interpolation, and deliberately synchronous: this
 * runtime delivers no `end` event on `stdin`, and a synchronous body cannot exit
 * before its answer is written.
 *
 * Every branch answers `{ ok: true, ... }` or `{ ok: false, code }` with the
 * errno the substrate raised — the reason this module needs no error prose.
 */
const RUNNER = `
const fs = require('fs');
// Depth-first rather than \`fs.rmSync(..., { recursive: true })\`, which this
// runtime does not implement (measured: "fs.rmSync is not a function").
function removeTree(path) {
  let stat;
  try { stat = fs.lstatSync(path); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(path)) removeTree(path + '/' + name);
    fs.rmdirSync(path);
    return;
  }
  fs.unlinkSync(path);
}
let out;
try {
  const req = JSON.parse(process.env.${REQUEST_ENV} || '');
  if (req.op === 'stat') {
    const s = fs.statSync(req.path);
    out = { ok: true, size: s.size, mtimeMs: s.mtimeMs || 0, dir: s.isDirectory() };
  } else if (req.op === 'list') {
    out = { ok: true, names: fs.readdirSync(req.path) };
  } else if (req.op === 'read') {
    const fd = fs.openSync(req.path, 'r');
    try {
      const buf = Buffer.alloc(req.len);
      const n = fs.readSync(fd, buf, 0, req.len, req.off);
      out = { ok: true, b64: buf.subarray(0, n).toString('base64'), n: n };
    } finally { fs.closeSync(fd); }
  } else if (req.op === 'stage') {
    fs.writeFileSync(req.temp, Buffer.from(req.b64, 'base64'));
    out = { ok: true };
  } else if (req.op === 'append') {
    fs.appendFileSync(req.temp, Buffer.from(req.b64, 'base64'));
    out = { ok: true };
  } else if (req.op === 'commit') {
    fs.renameSync(req.temp, req.path);
    out = { ok: true };
  } else if (req.op === 'discard') {
    try { fs.unlinkSync(req.temp); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    out = { ok: true };
  } else if (req.op === 'mkdir') {
    fs.mkdirSync(req.path, { recursive: !!req.recursive });
    out = { ok: true };
  } else if (req.op === 'unlink') {
    fs.unlinkSync(req.path);
    out = { ok: true };
  } else if (req.op === 'rmrf') {
    removeTree(req.path);
    out = { ok: true };
  } else if (req.op === 'rename') {
    fs.renameSync(req.from, req.to);
    out = { ok: true };
  } else {
    out = { ok: false, code: 'EIO', message: 'unknown operation' };
  }
} catch (e) {
  out = { ok: false, code: (e && e.code) || 'EIO', message: String((e && e.message) || e) };
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * THE REQUEST HALF OF THE PROTOCOL, as a closed union.
 *
 * One variant per operation, so the runner's contract is stated in types rather
 * than in an open dictionary: a `read` carries an offset and a length, a `stage`
 * carries a temp and bytes, and neither can be built with the other's fields.
 */
type AgentFsRequest =
  | { readonly op: 'stat' | 'list' | 'unlink' | 'rmrf'; readonly path: string }
  | { readonly op: 'read'; readonly path: string; readonly off: number; readonly len: number }
  | { readonly op: 'stage' | 'append'; readonly temp: string; readonly b64: string }
  | { readonly op: 'commit'; readonly temp: string; readonly path: string }
  | { readonly op: 'discard'; readonly temp: string }
  | { readonly op: 'mkdir'; readonly path: string; readonly recursive: boolean }
  | { readonly op: 'rename'; readonly from: string; readonly to: string };

/**
 * THE ANSWER HALF, parsed rather than trusted.
 *
 * The runner is a program in another process: its stdout is raw JSON, and a
 * type assertion over raw JSON asserts nothing. The schema also does the errno
 * narrowing, because `v.fallback` states exactly the rule this plane needs — a
 * code it speaks passes through, anything else is an environment failure.
 */
const RefusedSchema = v.object({
  ok: v.literal(false),
  code: v.fallback(
    v.picklist([
      'EPERM', 'ENOENT', 'EIO', 'ENXIO', 'EACCES',
      'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EROFS',
    ] satisfies readonly VfsErrorCode[]),
    'EIO',
  ),
  message: v.optional(v.string()),
});
const AnsweredSchema = v.object({
  ok: v.literal(true),
  size: v.optional(v.number()),
  mtimeMs: v.optional(v.number()),
  dir: v.optional(v.boolean()),
  names: v.optional(v.array(v.string())),
  b64: v.optional(v.string()),
  n: v.optional(v.number()),
});
const AnswerSchema = v.union([AnsweredSchema, RefusedSchema]);
type Answer = v.InferOutput<typeof AnsweredSchema>;

/** A typed refusal, kept as a value so `stat` can read the code before deciding
 *  whether an absent path is an answer or an error. */
class AgentFsRefusal extends Error {
  constructor(readonly code: VfsErrorCode, readonly detail: string) {
    super(detail);
    this.name = 'AgentFsRefusal';
  }
}

export function agentSessionFiles(
  box: NimbusSandboxHandle, cred: VfsCred,
): VFS & VfsNativeMutations & Pick<VfsNativeReads, 'readRange'> {
  const command = `node -e ${shellQuote(RUNNER)}`;
  const ask = async (request: AgentFsRequest): Promise<Answer> => {
    const result = await box.exec(command, {
      cred,
      env: { [REQUEST_ENV]: JSON.stringify(request) },
    });
    if (result.exitCode !== 0) {
      throw new AgentFsRefusal('EIO', result.stderr.trim() || `the session runner exited ${result.exitCode}`);
    }
    const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), AnswerSchema), result.stdout);
    if (!parsed.success) {
      throw new AgentFsRefusal(
        'EIO', `the session runner answered ${JSON.stringify(result.stdout.slice(0, 200))}`,
      );
    }
    const answer = parsed.output;
    // The refusal's code is already narrowed by the schema, which falls back to
    // `EIO` for anything this plane does not speak.
    if (!answer.ok) throw new AgentFsRefusal(answer.code, answer.message ?? 'refused');
    return answer;
  };
  /**
   * The refusal as the file plane raises it, with the operation and path the
   * caller used rather than the substrate's own storage key.
   *
   * `cause` is a MEMBER because there is no honest union to name here: a
   * `catch` binding is genuinely unknown, and this is the house shape for that
   * seam already (`renderThrownChain({ cause })`, `toKinuError({ doing, cause })`).
   */
  const raise = (
    failure: { readonly cause: unknown; readonly doing: string; readonly path: string },
  ): never => {
    if (failure.cause instanceof AgentFsRefusal) {
      throw makeVfsError(
        failure.cause.code,
        `${failure.cause.detail}, ${failure.doing} '${failure.path}'`,
        failure.path,
      );
    }
    throw failure.cause;
  };
  const run = async (
    request: AgentFsRequest,
    doing: string,
    path: string,
  ): Promise<Answer> => {
    try {
      return await ask(request);
    } catch (cause) {
      return raise({ cause, doing, path });
    }
  };
  /**
   * Stage the bytes beside the target, then publish them with the step the
   * caller names.
   *
   * Both write arms share everything up to that step — the staging path, the
   * bounded chunk loop, and the rule that a failure anywhere takes the staging
   * file with it — and differ only in how the staged bytes become the file. The
   * temp sits BESIDE the target because a rename is only atomic within one
   * directory, and because a temp under `/tmp` would be a second place a
   * failure could leave bytes the agent cannot see.
   */
  const publish = async (
    path: string,
    bytes: Uint8Array,
    doing: string,
    commit: (temp: string) => AgentFsRequest,
  ): Promise<Answer> => {
    const temp = `${workspacePath(path)}.kinu-${Math.random().toString(36).slice(2, 10)}.part`;
    try {
      for (let sent = 0; sent === 0 || sent < bytes.byteLength; sent += AGENT_FS_CHUNK_BYTES) {
        await run({
          op: sent === 0 ? 'stage' : 'append',
          temp,
          b64: bytesToBase64(bytes.subarray(sent, sent + AGENT_FS_CHUNK_BYTES)),
        }, doing, path);
      }
      return await run(commit(temp), doing, path);
    } catch (cause) {
      // THE CALLER'S FAILURE IS THE ONE THAT MATTERS, so the cleanup cannot
      // replace it — but a temp that survived is a stray file in an agent's
      // home, so it is RECORDED rather than dropped. Diagnostics, not a
      // rethrow: a failed cleanup after a failed write is a second fact about
      // the same call, and the first one is what the caller must see.
      try {
        await ask({ op: 'discard', temp });
      } catch (swept) {
        diagnostics.failure(
          'agent_fs.temp_left_behind',
          toKinuError({
            doing: `remove staging file ${temp}`, cause: swept, otherwise: 'unavailable',
          }),
        );
      }
      throw cause;
    }
  };
  const self: VFS & VfsNativeMutations & Pick<VfsNativeReads, 'readRange'> = {
    async readFile(path, opts) {
      const target = workspacePath(path);
      // UNTIL A ZERO-LENGTH READ, never until a short one: a short read is a
      // legitimate answer from a runtime that hands back less than it was asked
      // for, and treating it as the end is how a large file loses its tail.
      // The cost is one extra call at EOF; a lost tail costs the file.
      const parts: Uint8Array[] = [];
      let read = 0;
      for (;;) {
        const chunk = await run(
          { op: 'read', path: target, off: read, len: AGENT_FS_CHUNK_BYTES }, 'open', path,
        );
        const bytes = base64ToBytes(chunk.b64 ?? '');
        if (bytes.byteLength === 0) break;
        read += bytes.byteLength;
        parts.push(bytes);
      }
      const whole = parts.length === 1 && parts[0] ? parts[0] : join(parts, read);
      return opts?.encoding === 'utf8' ? new TextDecoder().decode(whole) : whole;
    },
    /**
     * The protocol's own offset/length read, stopped at `length`.
     *
     * The same `op:'read'` loop `readFile` walks, minus the part that made it
     * unbounded: a caller that wants a prefix — the file viewer's preview —
     * gets exactly that many bytes off the wire instead of the whole file
     * followed by a slice. A short read is still not the end (see above), so
     * this stops on `length` reached or a zero-length answer, whichever comes
     * first.
     */
    async readRange(path, offset, length) {
      const target = workspacePath(path);
      if (length <= 0) return new Uint8Array(0);
      const parts: Uint8Array[] = [];
      let read = 0;
      while (read < length) {
        const chunk = await run({
          op: 'read', path: target, off: offset + read,
          len: Math.min(AGENT_FS_CHUNK_BYTES, length - read),
        }, 'open', path);
        const bytes = base64ToBytes(chunk.b64 ?? '');
        if (bytes.byteLength === 0) break;
        read += bytes.byteLength;
        parts.push(bytes);
      }
      return parts.length === 1 && parts[0] ? parts[0] : join(parts, read);
    },
    async writeFile(path, data) {
      const target = workspacePath(path);
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      // ONE atomic step onto the target, and no byte of the staged file is read
      // back to take it: a same-directory rename publishes what was staged.
      // Until it lands the old file is whatever it was, byte for byte.
      await publish(path, bytes, 'write', (temp) => ({ op: 'commit', temp, path: target }));
    },
    // NO `writeFileIfRevision`, and its absence is the contract: this session
    // exposes no path revision to compare against and no write that carries a
    // precondition (see the header). A caller that finds the method missing is
    // told so — `writeExecutorFileOp` answers `unsupported`, the route turns
    // that into 409, and the editor stays read-only with the reason. Emulating
    // it with read/compare/write here would be a lie about a race this plane
    // cannot see.
    async readdir(path) {
      return (await run({ op: 'list', path: workspacePath(path) }, 'read directory', path)).names ?? [];
    },
    async stat(path) {
      try {
        const answer = await ask({ op: 'stat', path: workspacePath(path) });
        const result: VfsEntryStat = {
          size: answer.size ?? 0,
          mtimeMs: answer.mtimeMs ?? 0,
          isDir: answer.dir === true,
        };
        return result;
      } catch (cause) {
        if (cause instanceof AgentFsRefusal && cause.code === 'ENOENT') return null;
        return raise({ cause, doing: 'stat', path });
      }
    },
    async unlink(path) {
      await run({ op: 'unlink', path: workspacePath(path) }, 'unlink', path);
    },
    async mkdir(path, opts) {
      await run(
        { op: 'mkdir', path: workspacePath(path), recursive: opts?.recursive === true }, 'mkdir', path,
      );
    },
    async exists(path) {
      return (await self.stat(path)) !== null;
    },
    async removeRecursive(path) {
      await run({ op: 'rmrf', path: workspacePath(path) }, 'remove tree', path);
    },
    async rename(from, to) {
      await run(
        { op: 'rename', from: workspacePath(from), to: workspacePath(to) }, 'rename', from,
      );
    },
  };
  return self;
}

/** One buffer out of the chunks a read collected. Separate because the
 *  single-chunk case — every small file — must not copy at all. */
function join(parts: readonly Uint8Array[], total: number): Uint8Array {
  const whole = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}
