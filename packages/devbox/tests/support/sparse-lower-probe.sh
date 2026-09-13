#!/bin/sh
set -eu

# Run in a disposable container with /dev/fuse and CAP_SYS_ADMIN. The lower
# file's first block is a hole; the same base-file block is nonzero.
probe_dir=$(mktemp -d /tmp/devbox-sparse-lower.XXXXXX)
mkdir "$probe_dir/base" "$probe_dir/delta" "$probe_dir/upper" "$probe_dir/work" "$probe_dir/merged"
head -c 8192 /dev/zero | tr '\000' A > "$probe_dir/base/file"
truncate -s 8192 "$probe_dir/delta/file"
head -c 4096 /dev/zero | tr '\000' B | dd of="$probe_dir/delta/file" bs=4096 seek=1 conv=notrunc status=none

fuse-overlayfs -o "lowerdir=$probe_dir/delta:$probe_dir/base,upperdir=$probe_dir/upper,workdir=$probe_dir/work" "$probe_dir/merged"
trap 'fusermount3 -u "$probe_dir/merged"' EXIT

printf 'base-first-byte='
od -An -tu1 -N1 "$probe_dir/base/file"
printf 'delta-hole-first-byte='
od -An -tu1 -N1 "$probe_dir/delta/file"
printf 'merged-first-byte='
od -An -tu1 -N1 "$probe_dir/merged/file"
printf 'merged-second-block-byte='
od -An -tu1 -j4096 -N1 "$probe_dir/merged/file"

actual=$(od -An -tu1 -N1 "$probe_dir/merged/file" | tr -d ' ')
if [ "$actual" = 0 ]; then
  printf 'VERDICT: sparse upper-lower inode shadows the whole base inode; holes are zeros, not base bytes\n'
else
  printf 'UNEXPECTED: sparse lower first byte is %s; inspect before designing\n' "$actual"
  exit 1
fi
