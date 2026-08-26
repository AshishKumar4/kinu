#!/usr/bin/env bun
/**
 * The CaptureSound capability probe. Runs INSIDE the target container; prints
 * ONE JSON document (the CaptureCapabilityReport shape from
 * @kinu.run/devbox's capture module) on stdout. Diagnostics go to stderr.
 *
 * DOCTRINE: this probe MEASURES primitives, and where a primitive cannot be
 * measured it says `unknown` rather than guessing. It never emulates a missing
 * primitive to produce a prettier report, because the decision downstream —
 * which capture mechanism is sound here, or whether none is — is only as good
 * as these measurements are honest. An `unknown` gates fail-closed exactly
 * like an `absent`.
 *
 * Every check is independently fallible and every check cleans up after
 * itself. Exit code is always 0 when the JSON printed; a crash before printing
 * is the only failure mode.
 *
 *   bun probe.ts                       # inside the container under test
 *   PROBE_PLATFORM_LABEL=cloudflare-sandbox bun probe.ts
 */

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { CaptureCapabilityId, CaptureCheckStatus } from '../../../packages/devbox/src/capture/capabilities';

/** Closed-set order from capabilities.ts keeps reports comparable across runs. */
const CHECK_ORDER: readonly CaptureCapabilityId[] = [
  'process-freeze',
  'cgroup-freezer',
  'fork-proof-window',
  'syncfs',
  'fanotify-cap-sys-admin',
  'fuse-mount',
  'inotify-overflow-visible',
  'pid-namespace',
];

interface CheckOutcome {
  readonly id: CaptureCapabilityId;
  readonly status: CaptureCheckStatus;
  readonly detail: string;
}

interface ShellResult {
  readonly ok: boolean;
  readonly out: string;
}

function sh(command: string): ShellResult {
  try {
    const out = execFileSync('sh', ['-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
}

/** A live child we can signal, used by three checks. */
interface Sleeper {
  pid: number;
  stop(): void;
  cont(): void;
  kill(): void;
}

function startSleeper(): Sleeper {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('could not start the probe sleeper');
  return {
    pid,
    stop: () => process.kill(pid, 'SIGSTOP'),
    cont: () => process.kill(pid, 'SIGCONT'),
    kill: () => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        console.error(`[capture-probe] cleanup could not kill ${pid}: ${String(error)}`);
      }
    },
  };
}

/** Process state character from /proc/<pid>/stat, robust to spaced comms. */
function procState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    return afterComm.trim().split(/\s+/)[0] ?? null;
  } catch (error) {
    console.error(`[capture-probe] cannot read /proc/${pid}/stat: ${String(error)}`);
    return null;
  }
}

function listPids(): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

function checkProcessFreeze(): CheckOutcome {
  const sleeper = startSleeper();
  try {
    sleeper.stop();
    const state = procState(sleeper.pid);
    if (state === null) return { id: 'process-freeze', status: 'unknown', detail: `/proc/${sleeper.pid}/stat unreadable` };
    if (state !== 'T') return { id: 'process-freeze', status: 'absent', detail: `state after SIGSTOP was '${state}', not 'T'` };
    sleeper.cont();
    const resumed = procState(sleeper.pid);
    if (resumed === null || resumed === 'T') {
      return { id: 'process-freeze', status: 'absent', detail: `SIGCONT did not resume (state '${resumed}')` };
    }
    return { id: 'process-freeze', status: 'present', detail: 'SIGSTOP parks a writer at state T and SIGCONT releases it' };
  } finally {
    sleeper.kill();
  }
}

const CGROUP_ROOT = '/sys/fs/cgroup';

/**
 * cgroup v2 freezer, proven by actually freezing a moved-in child: writing
 * cgroup.freeze=1 and reading `frozen 1` back from cgroup.events.
 */
function checkCgroupFreezer(): CheckOutcome {
  let controllers: string;
  try {
    controllers = readFileSync(join(CGROUP_ROOT, 'cgroup.controllers'), 'utf8').trim();
  } catch (error) {
    return { id: 'cgroup-freezer', status: 'unknown', detail: `no readable cgroup root: ${String(error)}` };
  }
  if (!controllers.split(/\s+/).includes('freezer')) {
    return { id: 'cgroup-freezer', status: 'absent', detail: `cgroup.controllers = '${controllers}'` };
  }

  const dir = join(CGROUP_ROOT, `capture-probe-${process.pid}`);
  const sleeper = startSleeper();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), `${sleeper.pid}\n`);
    writeFileSync(join(dir, 'cgroup.freeze'), '1\n');
    const events = readFileSync(join(dir, 'cgroup.events'), 'utf8');
    if (!/^frozen 1$/m.test(events)) {
      return { id: 'cgroup-freezer', status: 'absent', detail: `subgroup accepted the freeze write but cgroup.events shows: ${events.replace(/\n/g, '; ')}` };
    }
    return { id: 'cgroup-freezer', status: 'present', detail: 'v2 freezer froze a moved-in child (cgroup.events: frozen 1)' };
  } catch (error) {
    return { id: 'cgroup-freezer', status: 'absent', detail: `freezer controller advertised but subgroup failed: ${String(error)}` };
  } finally {
    try {
      writeFileSync(join(dir, 'cgroup.freeze'), '0\n');
    } catch (error) {
      console.error(`[capture-probe] cleanup could not thaw ${dir}: ${String(error)}`);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`[capture-probe] cleanup could not remove ${dir}: ${String(error)}`);
    }
    sleeper.kill();
  }
}

/**
 * SIGSTOP sampling does NOT prove fork closure: a stopped process may have
 * forked in the enumeration race. A frozen cgroup does, because descendants
 * inherit their parent's cgroup. Prove the primitive directly by enrolling a
 * new writer after the cgroup has frozen and requiring it to enter T state.
 */
function checkForkProofWindow(): CheckOutcome {
  const controllers = sh(`cat '${CGROUP_ROOT}/cgroup.controllers'`);
  if (!controllers.ok || !controllers.out.split(/\s+/).includes('freezer')) {
    return {
      id: 'fork-proof-window',
      status: 'absent',
      detail: 'SIGSTOP alone cannot prove a fork-closed writer set; usable cgroup freezer absent',
    };
  }

  const dir = join(CGROUP_ROOT, `capture-probe-born-frozen-${process.pid}`);
  const sleeper = startSleeper();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.freeze'), '1\n');
    writeFileSync(join(dir, 'cgroup.procs'), `${sleeper.pid}\n`);
    const state = procState(sleeper.pid);
    if (state !== 'T') {
      return {
        id: 'fork-proof-window',
        status: 'absent',
        detail: `a writer enrolled after freeze had state '${state}', not T`,
      };
    }
    return {
      id: 'fork-proof-window',
      status: 'present',
      detail: 'a writer enrolled after cgroup.freeze=1 entered T; descendants inherit that frozen cgroup',
    };
  } catch (error) {
    return { id: 'fork-proof-window', status: 'absent', detail: `born-frozen probe failed: ${String(error)}` };
  } finally {
    try {
      writeFileSync(join(dir, 'cgroup.freeze'), '0\n');
    } catch (error) {
      console.error(`[capture-probe] cleanup could not thaw ${dir}: ${String(error)}`);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`[capture-probe] cleanup could not remove ${dir}: ${String(error)}`);
    }
    sleeper.kill();
  }
}

function checkSyncFs(): CheckOutcome {
  const probeDir = mkdtempSync(join(tmpdir(), 'capture-probe-sync-'));
  try {
    const coreutils = sh(`sync -f '${probeDir}'`);
    if (coreutils.ok) {
      return { id: 'syncfs', status: 'present', detail: 'coreutils `sync -f` flushed the filesystem holding the work tree' };
    }
    const python = sh(`python3 -c "import os; f=os.open('${probeDir}', os.O_RDONLY); os.syncfs(f); os.close(f)"`);
    if (python.ok) {
      return { id: 'syncfs', status: 'present', detail: 'python3 os.syncfs flushed the filesystem holding the work tree' };
    }
    return { id: 'syncfs', status: 'absent', detail: `sync -f: ${coreutils.out.slice(0, 120)}; python3 syncfs: ${python.out.slice(0, 120)}` };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const CAP_SYS_ADMIN_BIT = 21n;

function checkFanotify(): CheckOutcome {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(status)?.[1];
    if (!capEff) {
      return { id: 'fanotify-cap-sys-admin', status: 'unknown', detail: 'CapEff not found in /proc/self/status' };
    }
    const holds = ((BigInt(`0x${capEff}`) >> CAP_SYS_ADMIN_BIT) & 1n) === 1n;
    if (!holds) {
      return { id: 'fanotify-cap-sys-admin', status: 'absent', detail: `CapEff=${capEff} lacks CAP_SYS_ADMIN (bit ${CAP_SYS_ADMIN_BIT})` };
    }
    if (!sh('command -v python3').ok) {
      return { id: 'fanotify-cap-sys-admin', status: 'unknown', detail: 'CAP_SYS_ADMIN is present but no probe runtime can call fanotify_init' };
    }
    const init = sh(`python3 - <<'PYEOF'
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.fanotify_init(0, 0)
if fd < 0:
    raise OSError(ctypes.get_errno(), "fanotify_init")
os.close(fd)
PYEOF`);
    return init.ok
      ? { id: 'fanotify-cap-sys-admin', status: 'present', detail: 'CAP_SYS_ADMIN and a successful fanotify_init prove the permission-event primitive is available' }
      : { id: 'fanotify-cap-sys-admin', status: 'absent', detail: `fanotify_init failed despite CAP_SYS_ADMIN: ${init.out.slice(0, 160)}` };
  } catch (error) {
    return { id: 'fanotify-cap-sys-admin', status: 'unknown', detail: String(error) };
  }
}

function checkFuseMount(): CheckOutcome {
  if (!existsSync('/dev/fuse')) {
    return { id: 'fuse-mount', status: 'absent', detail: '/dev/fuse does not exist in this container' };
  }
  if (!sh('command -v fusermount3 || command -v fusermount').ok) {
    return { id: 'fuse-mount', status: 'unknown', detail: '/dev/fuse exists but no mount helper resolved' };
  }
  return {
    id: 'fuse-mount',
    status: 'unknown',
    detail: 'FUSE prerequisites exist, but this probe ships no FUSE daemon; a prerequisite is not a successful mount',
  };
}

/**
 * The python3 half of the overflow check. It NEVER changes the global inotify
 * sysctl: that would perturb an unrelated workload. Instead it creates one
 * more event than the actual queue limit, bounded at 65,536 operations; a
 * larger configured queue reports UNAVAILABLE rather than turning a probe into
 * an unbounded workload.
 */
const OVERFLOW_PY = `
import ctypes, os, shutil, tempfile
IN_Q_OVERFLOW = 0x4000
limit_path = "/proc/sys/fs/inotify/max_queued_events"
try:
    with open(limit_path) as f:
        limit = int(f.read().strip())
except OSError as e:
    print("UNAVAILABLE queue_limit:" + str(e))
    raise SystemExit
if limit > 65536:
    print("UNAVAILABLE queue_limit_too_large:" + str(limit))
    raise SystemExit
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(0o4000)  # IN_NONBLOCK
if fd < 0:
    print("ERR inotify_init")
    raise SystemExit
d = tempfile.mkdtemp()
try:
    wd = libc.inotify_add_watch(fd, d.encode(), 0x100)  # IN_CREATE
    if wd < 0:
        print("ERR add_watch")
        raise SystemExit
    for i in range(limit + 1024):
        os.mkdir(os.path.join(d, "e%d" % i))
    data = os.read(fd, 1048576)
    masks = []
    off = 0
    while off + 16 <= len(data):
        mask = int.from_bytes(data[off + 4:off + 8], "little")
        length = int.from_bytes(data[off + 12:off + 16], "little")
        masks.append(mask)
        off += 16 + length
    if IN_Q_OVERFLOW in masks:
        print("OVERFLOW")
    else:
        print("QUIET:" + ",".join(hex(m) for m in masks[:8]))
finally:
    os.close(fd)
    shutil.rmtree(d)
`;

function checkInotifyOverflow(): CheckOutcome {
  const python = sh(`python3 - <<'PYEOF'\n${OVERFLOW_PY}\nPYEOF`);
  if (!python.ok) {
    return {
      id: 'inotify-overflow-visible',
      status: 'unknown',
      detail: `no python3 consumer available to exercise inotify overflow (${python.out.slice(0, 120)})`,
    };
  }
  const verdict = python.out.trim();
  if (verdict.startsWith('OVERFLOW')) return { id: 'inotify-overflow-visible', status: 'present', detail: 'watch queue overflow surfaced as IN_Q_OVERFLOW on read' };
  if (verdict.startsWith('QUIET')) return { id: 'inotify-overflow-visible', status: 'absent', detail: `storm produced no Q_OVERFLOW event (${verdict})` };
  return { id: 'inotify-overflow-visible', status: 'unknown', detail: `probe could not bound and exercise overflow: ${verdict}` };
}

function checkPidNamespace(): CheckOutcome {
  try {
    const self = readlinkSync('/proc/self/ns/pid');
    const init = readlinkSync('/proc/1/ns/pid');
    const pids = listPids();
    if (pids.length === 0) {
      return { id: 'pid-namespace', status: 'absent', detail: '/proc exposes no pids; the writer set is not enumerable' };
    }
    if (self !== init) {
      return { id: 'pid-namespace', status: 'unknown', detail: `self pid namespace ${self} differs from visible pid 1 ${init}` };
    }
    return { id: 'pid-namespace', status: 'present', detail: `${pids.length} pids enumerable in the same namespace as pid 1` };
  } catch (error) {
    return { id: 'pid-namespace', status: 'unknown', detail: String(error) };
  }
}

const RUNNERS = {
  'process-freeze': checkProcessFreeze,
  'cgroup-freezer': checkCgroupFreezer,
  'fork-proof-window': checkForkProofWindow,
  syncfs: checkSyncFs,
  'fanotify-cap-sys-admin': checkFanotify,
  'fuse-mount': checkFuseMount,
  'inotify-overflow-visible': checkInotifyOverflow,
  'pid-namespace': checkPidNamespace,
} satisfies Record<CaptureCapabilityId, () => CheckOutcome | Promise<CheckOutcome>>;

async function main(): Promise<void> {
  const checks: Array<{ id: CaptureCapabilityId; status: CaptureCheckStatus; detail: string }> = [];
  for (const id of CHECK_ORDER) {
    let outcome: CheckOutcome;
    const runner = RUNNERS[id];
    if (!runner) {
      outcome = { id, status: 'unknown', detail: `probe has no runner for ${id}` };
    } else {
      try {
        outcome = await runner();
      } catch (error) {
        outcome = { id, status: 'unknown', detail: `probe check crashed: ${String(error)}` };
      }
    }
    console.error(`[capture-probe] ${id}: ${outcome.status} — ${outcome.detail}`);
    checks.push({ id: outcome.id, status: outcome.status, detail: outcome.detail });
  }
  let kernel = 'unknown';
  try {
    kernel = execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim();
  } catch (error) {
    console.error(`[capture-probe] could not read kernel release: ${String(error)}`);
  }

  const report = {
    probeVersion: 1,
    platform: process.env.PROBE_PLATFORM_LABEL ?? 'unlabeled-container',
    kernel,
    checks,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.main) await main();
