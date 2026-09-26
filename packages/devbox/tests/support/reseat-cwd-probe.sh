#!/bin/bash
set -euo pipefail
probe_dir=$(mktemp -d /tmp/devbox-reseat.XXXXXX)
generation=33333333-3333-4333-8333-333333333333
base=/fixture/lower-base
delta=$probe_dir/$generation
block=$probe_dir/block
mkdir -p /workspace /var/tmp/devbox "$base" "$delta" "$block" "$probe_dir/empty" /fixture/work
# Lowers detach lazily: the overlay's daemon still holds them while it exits (block-lower-probe.sh).
cleanup() {
  cd /
  if mountpoint -q /workspace; then fusermount3 -u /workspace; fi
  for mount in "$block" "$delta" "$base"; do
    if mountpoint -q "$mount"; then fusermount3 -uz "$mount"; fi
  done
}
trap cleanup EXIT
if [ "$1" = prepare ]; then
  fuse-overlayfs -o "lowerdir=$probe_dir/empty,upperdir=/fixture/upper,workdir=/fixture/work" /workspace
  cd /workspace
  node -e 'const f=require("fs");f.mkdirSync("vol");f.writeFileSync("vol/dense.bin",require("crypto").randomBytes(67108864));'
  mksquashfs /workspace /fixture/base.sqsh -comp zstd -no-progress -processors 1 >/dev/null
  if fusermount3 -u /workspace 2>/fixture/busy.err; then echo 'cwd unexpectedly allowed unmount' >&2; exit 1; fi
  grep -q 'busy' /fixture/busy.err
  printf 'cwd-control=EBUSY\n'
  cd /var/tmp/devbox
  fusermount3 -u /workspace
  rm -rf /fixture/upper /fixture/work
  mkdir -p /fixture/upper /fixture/work
  devbox-squashfuse /fixture/base.sqsh "$base" -o 'ro,allow_other,subtype=squashfuse,fsname=/fixture/base.sqsh'
  fuse-overlayfs -o "lowerdir=$base,upperdir=/fixture/upper,workdir=/fixture/work" /workspace
  dd if=/dev/urandom of=/workspace/vol/dense.bin bs=16384 count=4 seek=512 conv=notrunc,fsync status=none
  sha256sum /workspace/vol/dense.bin | cut -d' ' -f1 > /fixture/expected-sha
  bash /fixture/probe.sh > /fixture/probe.out
  bash /fixture/stat.sh > /fixture/stat.out
  bash /fixture/hash.sh > /fixture/hash.out
else
  bash /fixture/stage.sh
  mksquashfs /fixture/pkg /fixture/delta.sqsh -comp zstd -no-progress -processors 1 >/dev/null
  stat -c %s /fixture/delta.sqsh > /fixture/delta-bytes
  devbox-squashfuse /fixture/base.sqsh "$base" -o 'ro,allow_other,subtype=squashfuse,fsname=/fixture/base.sqsh'
  devbox-squashfuse /fixture/delta.sqsh "$delta" -o 'ro,allow_other,subtype=squashfuse,fsname=/fixture/delta.sqsh'
  mkdir -p /var/tmp/devbox/upper "$probe_dir/work"
  bash /fixture/namespace.sh
  devbox-block-lower --base "$base" --delta "$delta" --mount "$block" \
    --base-source /fixture/base.sqsh --delta-source /fixture/delta.sqsh \
    --generation "$generation:reseat" --stats "$probe_dir/stats.json" >"$probe_dir/server.log" 2>&1 &
  server_pid=$!
  for attempt in $(seq 1 100); do
    mountpoint -q "$block" && break
    if ! kill -0 "$server_pid" 2>/dev/null; then cat "$probe_dir/server.log"; exit 1; fi
    sleep 0.05
  done
  mountpoint -q "$block"
  fuse-overlayfs -o "lowerdir=$block:$delta/.devbox-delta/tree:$base,upperdir=/var/tmp/devbox/upper,workdir=$probe_dir/work" /workspace
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));if(s.payloadBytes!==0||s.indexPages!==0)throw Error(JSON.stringify(s));' "$probe_dir/stats.json"
  test "$(sha256sum /workspace/vol/dense.bin | cut -d' ' -f1)" = "$(cat /fixture/expected-sha)"
  printf 'reseat=outside-workspace delta=small restored=exact payload=0 index-pages=0\n'
fi
