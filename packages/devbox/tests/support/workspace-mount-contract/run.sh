#!/bin/sh
# One mount, two probes, one line of evidence per probe.
#
#   $1 = overlay    the workspace mount the product attaches: fuse-overlayfs
#                   over a lower and a fresh writable upper.
#   $1 = direct-io  the same probes over a filesystem that refuses exactly one
#                   capability, so a green overlay case is known to be able to
#                   go red.
#
# Output is two lines the suite parses: `mmap <VERDICT>` and `wal <VERDICT>`.
# Every diagnostic goes to stderr, so a parse cannot swallow a failure.
set -u

kind="${1:?usage: run.sh overlay|direct-io}"
root=/var/tmp/devbox
mnt="$root/workspace"
mkdir -p "$root/lower" "$root/upper" "$root/work" "$mnt"

case "$kind" in
  overlay)
    /usr/bin/fuse-overlayfs \
      -o "lowerdir=$root/lower,upperdir=$root/upper,workdir=$root/work" "$mnt" >&2 || {
      echo "mmap MOUNT-FAILED"; echo "wal MOUNT-FAILED"; exit 1; }
    ;;
  direct-io)
    /usr/local/bin/direct-io-fs "$mnt" >&2 || {
      echo "mmap MOUNT-FAILED"; echo "wal MOUNT-FAILED"; exit 1; }
    ;;
  *)
    echo "mmap UNKNOWN-KIND"; echo "wal UNKNOWN-KIND"; exit 2 ;;
esac

# The mount has to be the one being tested, or both probes are about the disk.
grep -q " $mnt " /proc/mounts || { echo "mmap NOT-MOUNTED"; echo "wal NOT-MOUNTED"; exit 1; }

/usr/local/bin/mmap-probe "$mnt/mapped.bin" 2>&1 | tail -1 | sed 's/^/mmap /;s/^mmap mmap /mmap /'

# WAL WITH TWO CONNECTIONS, because one connection can be served from its own
# page cache: the writer and the reader must agree through the shared-memory
# index, which is the mapping WAL needs. Rows are read back after both
# connections close, so the evidence is durability rather than a cache hit.
PROBE_MOUNT="$mnt" bun -e '
const { Database } = require("bun:sqlite");
const path = process.env.PROBE_MOUNT + "/app.db";
try {
  const writer = new Database(path, { create: true });
  const mode = writer.query("PRAGMA journal_mode = WAL").get();
  if (mode.journal_mode !== "wal") { console.log("wal MODE-" + mode.journal_mode.toUpperCase()); process.exit(0); }
  writer.run("CREATE TABLE rows (id INTEGER PRIMARY KEY, note TEXT)");
  writer.run("INSERT INTO rows (note) VALUES (?)", ["written under wal"]);
  const reader = new Database(path, { readonly: true });
  const seen = reader.query("SELECT note FROM rows").all();
  reader.close();
  writer.close();
  const reopened = new Database(path, { readonly: true });
  const survived = reopened.query("SELECT note FROM rows").all();
  reopened.close();
  console.log(seen.length === 1 && survived.length === 1 && survived[0].note === "written under wal"
    ? "wal OK" : "wal LOST-ROWS");
} catch (error) {
  const code = typeof error?.code === "string" ? error.code : String(error?.message ?? error);
  console.log("wal " + code);
}
' 2>/dev/null | tail -1
