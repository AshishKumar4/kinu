#!/bin/sh
set -eu

probe_dir=$(mktemp -d /tmp/devbox-block-lower.XXXXXX)
generation=11111111-1111-4111-8111-111111111111
base=$probe_dir/base
delta=$probe_dir/$generation
block=$probe_dir/block
merged=$probe_dir/merged
upper=/var/tmp/devbox/upper
mkdir -p "$base" "$delta" "$block" "$merged" "$upper" "$probe_dir/work"
cleanup() {
  for mount in "$merged" "$block" "$delta" "$base"; do
    if mountpoint -q "$mount"; then fusermount3 -u "$mount"; fi
  done
}
trap cleanup EXIT
mksquashfs /fixture/base "$probe_dir/base.sqsh" -comp zstd -no-progress -processors 1 >/dev/null
mksquashfs /fixture/pkg "$probe_dir/delta.sqsh" -comp zstd -no-progress -processors 1 >/dev/null
devbox-squashfuse "$probe_dir/base.sqsh" "$base" -o "ro,allow_other,subtype=squashfuse,fsname=$probe_dir/base.sqsh"
devbox-squashfuse "$probe_dir/delta.sqsh" "$delta" -o "ro,allow_other,subtype=squashfuse,fsname=$probe_dir/delta.sqsh"
sh /fixture/namespace.sh

devbox-block-lower --base "$base" --delta "$delta" --mount "$block" \
  --base-source "$probe_dir/base.sqsh" --delta-source "$probe_dir/delta.sqsh" \
  --generation "$generation:probe" --stats "$probe_dir/stats.json" >"$probe_dir/server.log" 2>&1 &
server_pid=$!
for attempt in $(seq 1 100); do
  mountpoint -q "$block" && break
  if ! kill -0 "$server_pid" 2>/dev/null; then cat "$probe_dir/server.log"; cat /proc/mounts; exit 1; fi
  sleep 0.05
done
mountpoint -q "$block"
fuse-overlayfs -o "lowerdir=$block:$delta/.devbox-delta/tree:$base,upperdir=$upper,workdir=$probe_dir/work" "$merged"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1])); if(s.payloadBytes!==0||s.indexPages!==0)throw Error(JSON.stringify(s)); console.log("attach-payload-bytes="+s.payloadBytes)' "$probe_dir/stats.json"
cmp /fixture/expected "$merged/dir/file"
test "$(cat "$merged/dir/whole")" = both
test ! -e "$merged/dir/stale"
cmp /fixture/whole "$merged/whole"
test "$(readlink "$merged/link")" = whole
test ! -e "$merged/gone/sub/file"
test -f "$merged/replace"
test ! -e "$merged/replace/child"
test "$(stat -c %i "$merged/whole")" = "$(stat -c %i "$merged/hardlink")"
if printf wrong >"$block/dir/file" 2>/dev/null; then echo 'readonly lower accepted a write'; exit 1; fi
node -e 'const fs=require("fs"); const fd=fs.openSync(process.argv[1],"r+"); fs.closeSync(fd)' "$merged/dir/file"
cmp /fixture/expected "$upper/dir/file"
printf Z | dd of="$merged/dir/file" bs=1 seek=5 conv=notrunc status=none
cmp /fixture/expected "$block/dir/file"
node -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);if(b[5]!==90)throw Error("upper write lost");const s=JSON.parse(fs.readFileSync(process.argv[2]));if(s.payloadBytes<=0)throw Error("demand IO not counted");console.log("composed-read=exact copyup=file-local")' "$merged/dir/file" "$probe_dir/stats.json"
cat "$probe_dir/stats.json"
