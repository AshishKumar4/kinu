// Kinu PC agent — self-update on the hub's UPDATE frame.
//
// The hub pushes `{ type: 'UPDATE', version, urls, sha256 }` when the build
// this daemon's HELLO named is not the served one. This module downloads the
// CLI's own platform archive over the daemon's origin, proves it against the
// published checksum, takes the daemon files it carries, lands them beside
// the running daemon (siblings first, then the daemon, then its stamp, each
// keeping a `.prev`), runs the new daemon once with `--selftest`, and starts it
// as this daemon's successor. This daemon keeps serving until the hub replaces
// its socket with the successor's; the caller exits on that close.
//
// No timers and no deadline: a successor that never connects leaves this
// daemon the owner, and the landed files wait for the next UPDATE.
'use strict';

const fs = require('node:fs');

const os = require('node:os');

const path = require('node:path');

const crypto = require('node:crypto');

const { spawn, spawnSync } = require('node:child_process');

/** The version stamp beside the daemon file, written by the CLI at connect
 *  and by this module at update. The daemon ships no embedded version. */
const VERSION_STAMP = 'pc-agent.version';

/**
 * The public half of the release signing key, pinned into this daemon at
 * build; held equal to core's `RELEASE_SIGNING_PUBLIC_KEY` by
 * `unit-release-signing.test.ts`. An UPDATE frame is a hub's words; the
 * signature over its checksums is Kinu's, and only a release that verifies
 * against this key is downloaded at all (SECURITY-devices C1: an unsigned
 * frame gave a hostile hub persistent code execution on every machine).
 */
const RELEASE_SIGNING_PUBLIC_KEY = '232098b9f5cc9b300b903bb9f3347ecb2b62115b2711438ab7fab12d30bfbaef';

/** A machine's OWN operator may pin another key through the environment —
 *  the test harness signs with a key of its own. A hub cannot reach this. */
const RELEASE_SIGNING_PUBLIC_KEY_ENV = 'KINU_RELEASE_SIGNING_PUBLIC_KEY';

const RELEASE_MESSAGE_PREFIX = 'kinu-release-v1';

/** Present from the moment a successor is started until a daemon connects:
 *  a stale pidfile beside it means the successor died before the hub saw it,
 *  and the CLI restarts from `.prev`. */
const UPDATE_PENDING_MARKER = 'pc-agent.update-pending';

/** The env the successor is started with, naming the daemon it replaces, so
 *  its machine claim can take over the pidfile that daemon still holds. */
const PREDECESSOR_ENV = 'KINU_DAEMON_PREDECESSOR';

/** Where the CLI archive carries the daemon files. */
const ARCHIVE_DAEMON_DIR = path.join('kinu', 'pc-agent');

const UPDATE_FRAME = 'UPDATE';

function readVersionStamp(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, VERSION_STAMP), 'utf8').trim();

    return text === '' ? null : text;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`read the daemon version stamp in ${dir}`, { cause: err });
  }
}

/** The owner's `updateCheck: false` in the CLI's config.json beside the
 *  device config: one switch for the CLI's own refresh and this push. */
function updateOptedOut(deviceHome) {
  let text;

  try {
    text = fs.readFileSync(path.join(deviceHome, 'config.json'), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw new Error('read the CLI config beside the device config', { cause: err });
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;

    // A config the CLI cannot parse either. The owner's answer is unknown,
    // and an unknown answer is not consent to replace their install.
    return true;
  }

  return Object(parsed) === parsed && parsed.updateCheck === false;
}

function clearPendingMarker(deviceHome) {
  fs.rmSync(path.join(deviceHome, UPDATE_PENDING_MARKER), { force: true });
}

function isUpdateFrame(msg) {
  return Boolean(msg) && msg.type === UPDATE_FRAME;
}

/** `value` as the string it is, or null for anything that is not one. */
function stringOrNull(value) {
  return Object(value) instanceof String ? String(value) : null;
}

/** The frame's fields as this daemon needs them, or the reason it is refused. */
function parseUpdateFrame(msg) {
  const version = (stringOrNull(msg.version) ?? '').trim();

  if (version === '') return { error: 'no version' };
  const urls = Object(msg.urls) === msg.urls ? msg.urls : {};
  const tarball = stringOrNull(urls.tarball);
  const checksum = stringOrNull(urls.checksum);

  if (tarball === null || checksum === null) return { error: 'no urls' };

  if (!tarball.startsWith('/') || !checksum.startsWith('/')) return { error: 'urls must be same-origin paths' };
  const sha256 = stringOrNull(msg.sha256);

  if (sha256 === null || !/^[0-9a-f]{64}$/i.test(sha256)) return { error: 'no sha256' };
  const rawChecksums = Object(msg.checksums) === msg.checksums ? msg.checksums : null;
  const signature = stringOrNull(msg.signature);

  if (rawChecksums === null || signature === null || !/^[A-Za-z0-9+/]+=*$/.test(signature)) return { error: 'no signature' };
  /** @type {Record<string, string>} */
  const checksums = {};

  for (const [artifact, raw] of Object.entries(rawChecksums)) {
    const digest = stringOrNull(raw);

    if (!artifact.startsWith('/') || digest === null || !/^[0-9a-f]{64}$/i.test(digest)) return { error: 'malformed checksums' };
    checksums[artifact] = digest.toLowerCase();
  }

  if (checksums[tarball] !== sha256.toLowerCase()) return { error: 'the checksum named is not the signed one' };

  return { version, tarball, checksum, sha256: sha256.toLowerCase(), checksums, signature };
}

/** The key this machine verifies a release against: the environment's when it
 *  names one, else the key pinned in this source. */
function pinnedPublicKey() {
  const fromEnv = process.env[RELEASE_SIGNING_PUBLIC_KEY_ENV] ?? '';

  return fromEnv === '' ? RELEASE_SIGNING_PUBLIC_KEY : fromEnv;
}

/** Byte order over artifact paths; a different order is a different message. */
function byArtifactPath([a], [b]) {
  if (a < b) return -1;

  return a > b ? 1 : 0;
}

/** The canonical bytes a release signature covers — the same text
 *  `core/src/http/release-signing.ts` builds: prefix, version, then every
 *  artifact with its checksum, sorted by path, one per line. */
function releaseMessage(version, checksums) {
  const lines = Object.entries(checksums)
    .sort(byArtifactPath)
    .map(([artifact, digest]) => `${artifact} ${digest.toLowerCase()}`);

  return new TextEncoder().encode([RELEASE_MESSAGE_PREFIX, version, ...lines, ''].join('\n'));
}

/** Whether the frame's signature verifies against the pinned key. A key
 *  that is not 32 bytes of hex, or a signature that is not 64 bytes, is
 *  refused before WebCrypto is asked; WebCrypto's own refusal of the
 *  material it is handed is a failure of THIS machine's pin and propagates
 *  to the caller's `device.update_failed` line with its cause. */
async function releaseSignatureHolds(frame, publicKeyHex = pinnedPublicKey()) {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  const publicKey = Uint8Array.from(publicKeyHex.match(/../g), (pair) => Number.parseInt(pair, 16));
  const signature = Uint8Array.from(Buffer.from(frame.signature, 'base64'));

  if (signature.byteLength !== 64) return false;
  const key = await crypto.webcrypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);

  return crypto.webcrypto.subtle.verify('Ed25519', key, signature, releaseMessage(frame.version, frame.checksums));
}

async function fetchBytes(fetchFn, url) {
  const res = await fetchFn(url, { cache: 'no-store' });

  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);

  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The archive, whole: its bytes hash to the published checksum, and that
 * checksum is the one the frame named — a frame from an earlier deploy than
 * the archive now served is refused rather than installed by surprise.
 */
async function downloadVerified(fetchFn, origin, frame) {
  const bytes = await fetchBytes(fetchFn, origin + frame.tarball);
  const published = new TextDecoder().decode(await fetchBytes(fetchFn, origin + frame.checksum)).trim().split(/\s+/)[0] || '';

  if (published.toLowerCase() !== frame.sha256) throw new Error('the published checksum is not the one the UPDATE frame named');
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');

  if (actual !== published.toLowerCase()) throw new Error(`checksum mismatch for ${frame.tarball}`);

  return bytes;
}

/** Write `content` to `file` through a fresh temporary, fsynced, then renamed. */
function writeAtomically(file, content, mode) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const descriptor = fs.openSync(temporary, 'wx', mode);

  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  fs.renameSync(temporary, file);
}

function syncDirectory(dir) {
  if (os.platform() === 'win32') return;
  const descriptor = fs.openSync(dir, 'r');

  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

/**
 * Land one file: the current one becomes `.prev`, the `.new` one becomes
 * current. Two renames; a crash between them leaves `.new` and `.prev`, both
 * complete, and the next UPDATE stages afresh.
 */
function landFile(target) {
  if (fs.existsSync(target)) fs.renameSync(target, `${target}.prev`);
  fs.renameSync(`${target}.new`, target);
}

/** Put `.prev` back over a landed file, when there is one. */
function restoreFile(target) {
  if (!fs.existsSync(`${target}.prev`)) return;
  fs.renameSync(`${target}.prev`, target);
}

/**
 * Take the daemon files out of the unpacked archive and land them, in the
 * order the CLI's own install uses: every sibling before the daemon that
 * requires it, the stamp after the daemon it describes. The pre-landing `.new`
 * files are written for every name first, so a missing file is found before
 * anything moves.
 */
function landDaemonFiles(layout, extracted, version) {
  const source = path.join(extracted, ARCHIVE_DAEMON_DIR);
  const names = [...layout.siblings, path.basename(layout.daemonPath)];

  for (const name of names) {
    const file = path.join(source, name);

    if (!fs.existsSync(file)) throw new Error(`the archive carries no ${name} for the daemon`);
  }

  const shipped = readVersionStamp(source);

  if (shipped !== version) throw new Error(`the archive is stamped ${shipped ?? 'nothing'}, not ${version}`);

  for (const name of names) {
    writeAtomically(`${path.join(layout.deviceHome, name)}.new`, fs.readFileSync(path.join(source, name)), 0o700);
  }

  writeAtomically(`${path.join(layout.deviceHome, VERSION_STAMP)}.new`, `${version}\n`, 0o600);

  for (const name of layout.siblings) landFile(path.join(layout.deviceHome, name));
  landFile(layout.daemonPath);
  landFile(path.join(layout.deviceHome, VERSION_STAMP));
  syncDirectory(layout.deviceHome);
}

/** The landed daemon, run once: it loads its siblings and prints its stamp. */
function selftest(layout) {
  const run = spawnSync(layout.runtime, [layout.daemonPath, '--selftest'], {
    cwd: layout.deviceHome,
    env: { ...process.env, KINU_HOME: layout.deviceHome },
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (run.error) throw new Error('the landed daemon could not be run', { cause: run.error });

  if (run.status !== 0) throw new Error(`the landed daemon failed its selftest (exit ${run.status}): ${String(run.stderr).trim()}`);

  return String(run.stdout).trim();
}

/** Undo a landing whose daemon failed its selftest: daemon first, so no
 *  moment leaves a newer daemon beside older siblings. */
function rollBack(layout) {
  restoreFile(layout.daemonPath);

  for (const name of layout.siblings) restoreFile(path.join(layout.deviceHome, name));
  restoreFile(path.join(layout.deviceHome, VERSION_STAMP));
  syncDirectory(layout.deviceHome);
}

function extractArchive(bytes, into) {
  const archive = path.join(into, 'cli.tar.gz');
  fs.writeFileSync(archive, bytes);
  const unpack = spawnSync('tar', ['-xzf', archive, '-C', into], { encoding: 'utf8' });

  if (unpack.error) throw new Error('tar could not run', { cause: unpack.error });

  if (unpack.status !== 0) throw new Error(`unpacking the archive failed: ${String(unpack.stderr).trim()}`);
}

/** A failure and its cause, one line, for the daemon log. */
function describeFailure(err) {
  if (!(err instanceof Error)) return String(err);

  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

/**
 * The updater for one daemon process.
 *
 * `layout` names what this daemon is: its home, its file, its siblings, the
 * runtime it runs on. `origin` is the HTTP origin the credentials trust.
 * `spawnFn` and `fetchFn` are the two seams: the process that starts the
 * successor and the origin that serves the archive.
 */
function createUpdater(opts) {
  const {
    layout, origin, log, fetchFn = fetch, spawnFn = spawn, reclaim,
  } = opts;

  let pending = false;
  let inProgress = false;

  function startSuccessor(version) {
    writeAtomically(path.join(layout.deviceHome, UPDATE_PENDING_MARKER), `${version}\n`, 0o600);

    const child = spawnFn(layout.runtime, [layout.daemonPath], {
      cwd: layout.deviceHome,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, KINU_HOME: layout.deviceHome, [PREDECESSOR_ENV]: String(process.pid) },
    });

    pending = true;
    child.once('exit', (code) => {
      // The successor is gone before the hub replaced this daemon's socket:
      // this daemon is still the daemon, and it owns the outcome. The
      // successor took the pidfile in its claim, so the file names a dead
      // process now — re-taken here, or the next `kinu desktop` start finds a
      // stale claim and starts a second daemon beside this one. The landed
      // files go back to `.prev`, the build this process runs, so the stamp
      // beside it and the HELLO agree; the marker goes with them. The next
      // UPDATE for the same version lands and tries again.
      log(`device.update_successor_exited pid=${child.pid} code=${code}`);

      try {
        rollBack(layout);
        clearPendingMarker(layout.deviceHome);
        reclaim?.();
        log(`device.update_rolled_back version=${version}`);
      } catch (err) {
        log('device.update_rollback_failed', describeFailure(err));
      }

      pending = false;
    });
    child.unref();
    log(`device.update_successor_started pid=${child.pid} version=${version}`);
  }

  async function apply(frame) {
    // The files on disk may already be this build: a successor that died
    // before connecting, and the next UPDATE for the same version. Nothing is
    // downloaded again, and `.prev` — the last build that ran — is kept.
    if (readVersionStamp(layout.deviceHome) !== frame.version) {
      const work = fs.mkdtempSync(path.join(layout.deviceHome, 'pc-agent.update-'));

      try {
        extractArchive(await downloadVerified(fetchFn, origin, frame), work);
        landDaemonFiles(layout, work, frame.version);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }

    let reported;

    try {
      reported = selftest(layout);
    } catch (err) {
      rollBack(layout);
      throw new Error('the landed daemon failed its selftest; the previous build was restored', { cause: err });
    }

    if (reported !== frame.version) {
      rollBack(layout);
      throw new Error(`the landed daemon reports ${reported}, not ${frame.version}; the previous build was restored`);
    }

    startSuccessor(frame.version);
  }

  return {
    /** Whether a successor has been started and this daemon awaits replacement. */
    pending: () => pending,
    /**
     * Handle a frame. Answers whether it was an UPDATE frame — one this
     * module owns, whatever it then decided — so the caller passes nothing
     * else on. The work itself runs on its own promise: the socket keeps
     * serving while the archive downloads.
     */
    handle(msg) {
      if (!isUpdateFrame(msg)) return false;

      if (pending || inProgress) {
        log('device.update_ignored reason=already_pending');

        return true;
      }

      if (updateOptedOut(layout.deviceHome)) {
        log('device.update_ignored reason=updateCheck_false');

        return true;
      }

      const frame = parseUpdateFrame(msg);

      if (frame.error) {
        log(`device.update_ignored reason=malformed_frame detail=${frame.error}`);

        return true;
      }

      /** @param {unknown} error */
      function reportUpdateFailure(error) {
        log('device.update_failed', describeFailure(error));
      }

      // The signature is checked BEFORE anything is downloaded, let alone
      // written: a hub's frame names bytes, and only Kinu's signature over
      // their checksums makes them Kinu's.
      inProgress = true;
      releaseSignatureHolds(frame).then((holds) => {
        if (!holds) {
          log(`device.update_ignored reason=bad_signature version=${frame.version}`);

          return;
        }

        log(`device.update_started version=${frame.version}`);

        return apply(frame);
      }).catch(reportUpdateFailure).finally(() => { inProgress = false; });

      return true;
    },
  };
}

module.exports = {
  RELEASE_SIGNING_PUBLIC_KEY,
  VERSION_STAMP,
  UPDATE_PENDING_MARKER,
  PREDECESSOR_ENV,
  UPDATE_FRAME,
  readVersionStamp,
  updateOptedOut,
  clearPendingMarker,
  createUpdater,
};
