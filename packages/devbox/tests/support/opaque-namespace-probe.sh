#!/bin/sh
set -eu
probe_dir=$(mktemp -d /tmp/devbox-opaque.XXXXXX)
generation=22222222-2222-4222-8222-222222222222
base=$probe_dir/base
delta=$probe_dir/$generation
block=$probe_dir/block
merged=$probe_dir/merged
mkdir -p "$base" "$delta" "$block" "$merged" "$probe_dir/work"
cleanup() {
  for mount in "$merged" "$block" "$delta" "$base"; do
    if mountpoint -q "$mount"; then fusermount3 -u "$mount"; fi
  done
  chown -R --no-dereference "$(stat -c %u:%g /fixture)" /fixture
}
trap cleanup EXIT
mksquashfs /fixture/base "$probe_dir/base.sqsh" -comp zstd -no-progress -processors 1 >/dev/null
devbox-squashfuse "$probe_dir/base.sqsh" "$base" -o "ro,allow_other,subtype=squashfuse,fsname=$probe_dir/base.sqsh"
if [ "$1" = prepare ]; then
  mkdir -p /fixture/work
  fuse-overlayfs -o "lowerdir=$base,upperdir=/fixture/upper,workdir=/fixture/work" "$merged"
  rm -rf "$merged/target"
  mv -T "$merged/source" "$merged/target"
  names=$(find "$merged" -type f -printf '%P\n' | sort | paste -sd,)
  if [ "$names" != keep,target/new.txt ]; then printf 'rename namespace: %s\n' "$names" >&2; exit 1; fi
  test ! -e "$merged/target/stale.txt"
  test -f "$merged/target/new.txt"
  bash /fixture/probe.sh
else
  sh /fixture/stage.sh
  if [ "$1" = missing-marker ]; then rm /fixture/pkg/.devbox-delta/tree/target/.wh..wh..opq; fi
  mksquashfs /fixture/pkg "$probe_dir/delta.sqsh" -comp zstd -no-progress -processors 1 >/dev/null
  devbox-squashfuse "$probe_dir/delta.sqsh" "$delta" -o "ro,allow_other,subtype=squashfuse,fsname=$probe_dir/delta.sqsh"
  mkdir -p /var/tmp/devbox/upper
  sh /fixture/namespace.sh
  devbox-block-lower --base "$base" --delta "$delta" --mount "$block" \
    --base-source "$probe_dir/base.sqsh" --delta-source "$probe_dir/delta.sqsh" \
    --generation "$generation:opaque" --stats "$probe_dir/stats.json" >"$probe_dir/server.log" 2>&1 &
  server_pid=$!
  for attempt in $(seq 1 100); do
    mountpoint -q "$block" && break
    if ! kill -0 "$server_pid" 2>/dev/null; then cat "$probe_dir/server.log"; exit 1; fi
    sleep 0.05
  done
  mountpoint -q "$block"
  fuse-overlayfs -o "lowerdir=$block:$delta/.devbox-delta/tree:$base,upperdir=/var/tmp/devbox/upper,workdir=$probe_dir/work" "$merged"
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));if(s.payloadBytes!==0||s.indexPages!==0)throw Error(JSON.stringify(s));' "$probe_dir/stats.json"
  test "$(find "$merged" -type f -printf '%P\n' | sort | paste -sd,)" = keep,target/new.txt
  test "$(cat "$merged/target/new.txt")" = 'renamed bytes'
  test "$(cat "$merged/keep")" = 'unchanged sibling'
  printf 'namespace=keep,target/new.txt attach-payload-bytes=0 index-pages=0\n'
fi
