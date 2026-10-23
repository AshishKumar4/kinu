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

const { execFile, spawn } = require('node:child_process');

/**
 * Runs a child to its exit and settles with `execFile`'s own answer:
 * `{ error, stdout, stderr }`, where a numeric `error.code` is the exit status.
 * Stdin is closed at once, as a synchronous spawn's `'ignore'` had it. The
 * daemon's one way to wait for a child: sandbox.js and index.js import it.
 */
function runToExit(file, args, options) {
  const { promise, resolve } = Promise.withResolvers();
  const child = execFile(file, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  child.stdin.end();

  return promise;
}

/** The version stamp beside the daemon file, written by the CLI at connect
 *  and by this module at update. The daemon ships no embedded version. */
const VERSION_STAMP = 'pc-agent.version';

/**
 * The release signing key, the operator's override of it, and the bytes a
 * signature covers: core's one definition, built into this daemon. An UPDATE
 * frame is a hub's words; the signature over its checksums is Kinu's, and only
 * a release that verifies against this key is downloaded at all
 * (SECURITY-devices C1: an unsigned frame gave a hostile hub persistent code
 * execution on every machine).
 */
const { artifactRefusal, readSignedRelease, releasePublicKey, verifyRelease } = require('../../core/src/http/release-message.ts');


/** Present from the moment a successor is started until a daemon connects:
 *  a stale pidfile beside it means the successor died before the hub saw it,
 *  and the CLI restarts from `.prev`. */
const UPDATE_PENDING_MARKER = 'pc-agent.update-pending';

/** The env the successor is started with, naming the daemon it replaces, so
 *  its machine claim can take over the pidfile that daemon still holds; no command inherits it. */
const { DAEMON_PREDECESSOR_ENV: PREDECESSOR_ENV } = require('../../core/src/cli/command-env.ts');

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

/** The frame's fields as this daemon needs them, or the reason it is refused: the signed release as every updater
 *  reads it (`readSignedRelease`), and the archive it names. */
function parseUpdateFrame(msg) {
  const release = readSignedRelease(msg);

  if ('error' in release) return release;
  const urls = Object(msg.urls) === msg.urls ? msg.urls : {};
  // The `.sha256` a hub names beside it is no authority (`downloadVerified`), so it is not read.
  const tarball = stringOrNull(urls.tarball);

  if (tarball === null) return { error: 'no urls' };

  if (!tarball.startsWith('/')) return { error: 'urls must be same-origin paths' };
  const sha256 = stringOrNull(msg.sha256);

  if (sha256 === null || !/^[0-9a-f]{64}$/i.test(sha256)) return { error: 'no sha256' };

  if (release.checksums[tarball] !== sha256.toLowerCase()) return { error: 'the checksum named is not the signed one' };

  return { ...release, tarball, sha256: sha256.toLowerCase() };
}

/** Whether the frame's signature verifies against the pinned key, as core verifies every release
 *  (`verifyRelease`): a malformed key or signature does not; WebCrypto's own refusal of the material it is
 *  handed is a failure of THIS machine's pin and propagates to the caller's `device.update_failed` line. */
function releaseSignatureHolds(frame, publicKeyHex = releasePublicKey(process.env)) {
  return verifyRelease(frame, publicKeyHex);
}

async function fetchBytes(fetchFn, url) {
  const res = await fetchFn(url, { cache: 'no-store' });

  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);

  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The archive, whole: its bytes are the ones the signed checksums name, as the CLI's are (release-message.ts). The
 * `.sha256` beside it is no authority: a frame from an earlier deploy than the archive now served fails that check.
 */
async function downloadVerified(fetchFn, origin, frame) {
  const bytes = await fetchBytes(fetchFn, origin + frame.tarball);
  const refusal = await artifactRefusal(frame.checksums, frame.tarball, bytes);

  if (refusal !== null) throw new Error(refusal);

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
 * requires it, the stamp after the daemon it describes. The siblings are the
 * files the new build ships beside its daemon, so a file the running build
 * never had lands too. The pre-landing `.new` files are written for every name
 * first, so a missing daemon is found before anything moves. Answers what
 * landed: the siblings, and those of them this home did not have before.
 */
function landDaemonFiles(layout, extracted, version) {
  const source = path.join(extracted, ARCHIVE_DAEMON_DIR);
  const daemon = path.basename(layout.daemonPath);

  if (!fs.existsSync(path.join(source, daemon))) throw new Error(`the archive carries no ${daemon} for the daemon`);
  const siblings = fs.readdirSync(source).filter((name) => name !== daemon && name !== VERSION_STAMP).sort();
  const fresh = siblings.filter((name) => !fs.existsSync(path.join(layout.deviceHome, name)));
  const names = [...siblings, daemon];

  const shipped = readVersionStamp(source);

  if (shipped !== version) throw new Error(`the archive is stamped ${shipped ?? 'nothing'}, not ${version}`);

  for (const name of names) {
    writeAtomically(`${path.join(layout.deviceHome, name)}.new`, fs.readFileSync(path.join(source, name)), 0o700);
  }

  writeAtomically(`${path.join(layout.deviceHome, VERSION_STAMP)}.new`, `${version}\n`, 0o600);

  for (const name of siblings) landFile(path.join(layout.deviceHome, name));
  landFile(layout.daemonPath);
  landFile(path.join(layout.deviceHome, VERSION_STAMP));
  syncDirectory(layout.deviceHome);

  return { siblings, fresh };
}

/** The landed daemon, run once: it loads its siblings and prints its stamp. */
async function selftest(layout) {
  const { error, stdout, stderr } = await runToExit(layout.runtime, [layout.daemonPath, '--selftest'], {
    cwd: layout.deviceHome,
    env: { ...process.env, KINU_HOME: layout.deviceHome },
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (error !== null && !Number.isInteger(error.code)) throw new Error('the landed daemon could not be run', { cause: error });

  if (error !== null) throw new Error(`the landed daemon failed its selftest (exit ${error.code}): ${String(stderr).trim()}`);

  return String(stdout).trim();
}

/** Undo a landing (`landed`, as landDaemonFiles answered it) whose daemon
 *  failed: daemon first, so no moment leaves a newer daemon beside older
 *  siblings; a sibling the build added is removed, the rest go back to `.prev`. */
function rollBack(layout, landed) {
  restoreFile(layout.daemonPath);

  for (const name of landed.siblings) {
    const file = path.join(layout.deviceHome, name);

    if (landed.fresh.includes(name)) fs.rmSync(file, { force: true });
    else restoreFile(file);
  }

  restoreFile(path.join(layout.deviceHome, VERSION_STAMP));
  syncDirectory(layout.deviceHome);
}

async function extractArchive(bytes, into) {
  const archive = path.join(into, 'cli.tar.gz');
  fs.writeFileSync(archive, bytes);
  const { error, stderr } = await runToExit('tar', ['-xzf', archive, '-C', into], { encoding: 'utf8' });

  if (error !== null && !Number.isInteger(error.code)) throw new Error('tar could not run', { cause: error });

  if (error !== null) throw new Error(`unpacking the archive failed: ${String(stderr).trim()}`);
}

/** A failure and its cause, one line, for the daemon log. */
function describeFailure(err) {
  if (!(err instanceof Error)) return String(err);

  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

/**
 * Settles once the process holding the other end of `stream` has exited. A successor's stdin is its
 * predecessor's pipe, and the OS closes the predecessor's end when it ends, however it ends: a clean exit, a
 * crash, SIGKILL. The event is the exit itself, not a clock's guess at it.
 */
function lifelineClosed(stream) {
  const { promise, resolve } = Promise.withResolvers();

  stream.once('end', resolve);
  stream.once('close', resolve);
  stream.once('error', resolve);
  stream.resume();

  return promise;
}

/**
 * The updater for one daemon process.
 *
 * `layout` names what this daemon is: its home, its file, the runtime it
 * runs on. `origin` is the HTTP origin the credentials trust.
 * `spawnFn` and `fetchFn` are the two seams: the process that starts the
 * successor and the origin that serves the archive.
 */
function createUpdater(opts) {
  const {
    layout, origin, log, fetchFn = fetch, spawnFn = spawn, reclaim,
  } = opts;

  let pending = false;
  let inProgress = false;
  // What the last landing put in place, for a rollback: the same build landed
  // again answers the same files.
  let landed = { siblings: [], fresh: [] };

  function startSuccessor(version) {
    writeAtomically(path.join(layout.deviceHome, UPDATE_PENDING_MARKER), `${version}\n`, 0o600);

    const child = spawnFn(layout.runtime, [layout.daemonPath], {
      cwd: layout.deviceHome,
      detached: true,
      // Stdin is the successor's lifeline (`lifelineClosed`): never written, closed by the OS when this process ends.
      stdio: ['pipe', 'inherit', 'inherit'],
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

      /** @param {unknown} error */
      function reportRollbackFailure(error) {
        log('device.update_rollback_failed', describeFailure(error));
      }

      (async () => {
        rollBack(layout, landed);
        clearPendingMarker(layout.deviceHome);
        await reclaim?.();
        log(`device.update_rolled_back version=${version}`);
      })().catch(reportRollbackFailure).finally(() => { pending = false; });
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
        await extractArchive(await downloadVerified(fetchFn, origin, frame), work);
        landed = landDaemonFiles(layout, work, frame.version);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }

    let reported;

    try {
      reported = await selftest(layout);
    } catch (err) {
      rollBack(layout, landed);
      throw new Error('the landed daemon failed its selftest; the previous build was restored', { cause: err });
    }

    if (reported !== frame.version) {
      rollBack(layout, landed);
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

/** The longest reason the hub is sent; it keeps the reason for the device row. */
const REFUSAL_REASON_MAX = 1000;

/**
 * Tells the hub this build refuses to run here, on which runtime, and why: the hub stops pushing it until another
 * build is served or the daemon runs on another runtime, and the owner's device row says why the machine is
 * behind. Resolves the hub's HTTP status.
 */
async function reportRefusal({ origin, cfg, version, runtime, reason, fetchFn = fetch }) {
  const res = await fetchFn(`${origin}/pc/update-refused`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: cfg.user, token: cfg.token, version, runtime, reason: reason.slice(0, REFUSAL_REASON_MAX) }),
  });

  return res.status;
}

module.exports = {
  VERSION_STAMP,
  UPDATE_PENDING_MARKER,
  PREDECESSOR_ENV,
  lifelineClosed,
  UPDATE_FRAME,
  readVersionStamp,
  updateOptedOut,
  clearPendingMarker,
  createUpdater,
  runToExit,
  reportRefusal,
};
