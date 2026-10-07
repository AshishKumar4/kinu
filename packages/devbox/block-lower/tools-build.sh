# The tools tarball (D66, D77), built as the user by armada's recipe install after tools-setup.sh, in a work
# directory that holds this tree's block lower in block-lower/. It leaves tools.tgz there; each task reads a part.
set -eu
umask 022
out=/opt/devbox-tools
work=$(pwd)

(cd block-lower && cargo test --locked --target x86_64-unknown-linux-musl && cargo build --release --locked --target x86_64-unknown-linux-musl)
tar -xzf /opt/src/squashfuse.tar.gz
(cd squashfuse-0.1.103 && ./configure --disable-shared --disable-demo --disable-high-level --enable-low-level >/dev/null && make -j"$(nproc)" >/dev/null)

install -m 0755 block-lower/target/x86_64-unknown-linux-musl/release/devbox-block-lower "$out/usr/local/bin/devbox-block-lower"
install -m 0755 squashfuse-0.1.103/squashfuse_ll "$out/usr/local/bin/devbox-squashfuse"
chmod 0755 "$out/usr/local/bin/bun" "$out/usr/local/bin/sandbox-shim"
cd "$out"
find usr -type f | LC_ALL=C sort | xargs sha256sum > "$work/tools.sha256"
mv "$work/tools.sha256" usr/local/lib/devbox/tools.sha256
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - usr | gzip -n -1 > "$work/tools.tgz"
