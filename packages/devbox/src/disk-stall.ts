/**
 * Whether a stop the box is still making waits on a disk that stopped answering (2026-10-17): a container started from
 * a snapshot can leave a read of its root, a btrfs on a block device the platform serves, never completed. Every
 * process that then reads a block it does not yet hold sleeps uninterruptibly (`D`) for good, a kill of it never
 * lands, and the guest kernel says nothing. A FUSE daemon that stopped answering (s3fs, fuse-overlayfs) sleeps its
 * callers interruptibly instead, with no read of the root in flight (both measured; `kinu-logs/container-btrfs-wedge-2026-10-17`).
 *
 * The reading is bash builtins alone: a program not yet read from that disk would itself wait on it.
 */

/** Each process not a kernel thread, as `process <pid> <state> <ppid> <kernel wait, read only in D> <name>`, then the
 *  root's block device and its reads and writes in flight, as `root <device> <reads> <writes>`. */
export const DISK_PROBE = `for d in /proc/[0-9]*; do read -r line < $d/stat 2>/dev/null || continue; read -r c < $d/comm; r=\${line##*) }; set -- $r; [ "$2" = 2 ] && continue; w=-; [ "$1" = D ] && read -r w < $d/wchan; echo "process \${d#/proc/} $1 $2 $w $c"; done
while read -r line; do set -- $line; [ "$5" = / ] || continue; rest=\${line#* - }; set -- $rest; read -r f < /sys/class/block/\${2##*/}/inflight 2>/dev/null && echo "root $2 $f"; done < /proc/self/mountinfo`;

export interface DiskStall {
  /** The processes of the stopped trees that wait on the disk, by name and kernel wait: `Xkasmvnc (folio_wait_bit_common)`. */
  readonly waiting: readonly string[];
  readonly device: string;
  /** The root's reads in flight. */
  readonly reads: number;
}

interface ProcessRow { readonly pid: number; readonly state: string; readonly ppid: number; readonly wait: string; readonly name: string }

/** The stall `read` shows for the trees under `roots`, or with none for the whole box, or null: a process of them in `D`
 *  while the root has reads in flight. A root that is no block device, as an overlay, is never read as stalled. */
export function diskStallOf(read: string, roots?: readonly number[]): DiskStall | null {
  const rows: ProcessRow[] = [];
  let root: { readonly device: string; readonly reads: number } | undefined;

  for (const line of read.split('\n')) {
    const process = /^process (\d+) (\S) (\d+) (\S+) (.*)$/u.exec(line);

    if (process !== null) rows.push({ pid: Number(process[1]), state: process[2] ?? '', ppid: Number(process[3]), wait: process[4] ?? '', name: process[5] ?? '' });
    const device = /^root (\S+) (\d+)\s+\d+$/u.exec(line);

    if (device !== null) root = { device: device[1] ?? '', reads: Number(device[2]) };
  }

  // Every process with none: the container's own exec starts its runs outside init's tree (parent 0).
  const tree = new Set(roots ?? rows.map((row) => row.pid));

  // Parents come before children in /proc's order but not always, so the walk repeats until it adds none.
  for (let grew = true; grew;) {
    grew = false;

    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }

  const waiting = rows.filter((row) => tree.has(row.pid) && row.state === 'D').map((row) => `${row.name} (${row.wait})`);

  return root === undefined || root.reads === 0 || waiting.length === 0 ? null : { waiting, device: root.device, reads: root.reads };
}

/** What the owner reads while a stop waits on it. */
export const DISK_STALLED = 'the computer\'s disk stopped answering reads, so its last stop is still waiting';

/** What the operations a restart for it ends answer. */
export const DISK_STALL_RESTARTED = 'the computer\'s disk stopped answering reads, so Stop restarted the computer';
