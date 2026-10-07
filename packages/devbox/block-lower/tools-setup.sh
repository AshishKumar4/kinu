# The tools tarball's build environment (D66, D78), run as root once per environment by armada's recipe setup on
# cloudflare/debian-trixie: every Debian package from one day of the archive, the toolchain included, and each other
# input fetched by its pinned sha256. tools-build.sh then compiles and packs as the user.
set -eu
umask 022
export DEBIAN_FRONTEND=noninteractive
snapshot=20261002T000000Z
out=/opt/devbox-tools
repo=$out/usr/local/lib/devbox/debs
fetch() { curl -fsSL -o "$1" "$2" && echo "$3  $1" | sha256sum -c --quiet -; }

rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: trixie-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
  "$snapshot" "$snapshot" > /etc/apt/sources.list.d/debian.sources
echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/snapshot
# Above 1000, so a package the base or the runner layer took newer is taken back to the archive's day.
printf 'Package: *\nPin: origin "snapshot.debian.org"\nPin-Priority: 1001\n' > /etc/apt/preferences.d/snapshot
apt-get update -qq
apt-get dist-upgrade -y -qq --allow-downgrades
apt-get install -y -qq --no-install-recommends --allow-downgrades build-essential pkg-config libfuse-dev libzstd-dev zlib1g-dev dpkg-dev

mkdir -p /opt/src "$out/usr/local/bin" "$repo"
cd /opt/src
rust=1.93.1
fetch rustc.tar.xz https://static.rust-lang.org/dist/rustc-$rust-x86_64-unknown-linux-gnu.tar.xz b9db2636f5a101c4cdaf46a26f8a0c8e4b5767ecdb02ae9c7ccc3ead577732bc
fetch cargo.tar.xz https://static.rust-lang.org/dist/cargo-$rust-x86_64-unknown-linux-gnu.tar.xz dbf12e8fd2a245a6bdd9f6c8df267cb2c25b0c56866ee91d8321337df0a00ddb
fetch std-gnu.tar.xz https://static.rust-lang.org/dist/rust-std-$rust-x86_64-unknown-linux-gnu.tar.xz 82c4e41268f1741e4eb68796aeb6ca5042406ae858dd56144155c4ef8d87d8b6
fetch std-musl.tar.xz https://static.rust-lang.org/dist/rust-std-$rust-x86_64-unknown-linux-musl.tar.xz 24a9592c81c3def623f9e33e90f8f5bacefbffdd59d87f52da542fd6f4b252df
for part in rustc cargo std-gnu std-musl; do
  mkdir "$part" && tar -xJf "$part.tar.xz" -C "$part" --strip-components=1 && "./$part/install.sh" --prefix=/usr/local --disable-ldconfig >/dev/null
done
fetch squashfuse.tar.gz https://github.com/vasi/squashfuse/releases/download/0.1.103/squashfuse-0.1.103.tar.gz 42d4dfd17ed186745117cfd427023eb81effff3832bab09067823492b6b982e7

fetch bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip 36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
unzip -p bun.zip bun-linux-x64/bun > "$out/usr/local/bin/bun"
# The one layer of docker.io/cloudflare/sandbox@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 (1.0.0): the shim.
token=$(curl -fsS 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:cloudflare/sandbox:pull' | jq -r .token)
curl -fsSL -H "Authorization: Bearer $token" -o shim.tar.gz \
  https://registry-1.docker.io/v2/cloudflare/sandbox/blobs/sha256:df3ac1c2dcd527c14bc65136ee282385067cc5df20c8a5341276b3d1c1f5759b
echo 'df3ac1c2dcd527c14bc65136ee282385067cc5df20c8a5341276b3d1c1f5759b  shim.tar.gz' | sha256sum -c --quiet -
tar -xzf shim.tar.gz -C "$out" usr/local/bin/sandbox-shim

# An offline apt repository of the closure of what a box needs, and KasmVNC's own release (D70), which Debian lacks.
fetch "$repo/kasmvncserver_trixie_1.5.0_amd64.deb" https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_trixie_1.5.0_amd64.deb 80b241de7dfe53bba2b7e1cc5ac8c5246d72271efa16be2d4f76607f30fab1c4
echo bash ca-certificates curl git python3 tmux tini fuse3 fuse-overlayfs squashfs-tools zstd s3fs libfuse2t64 libzstd1 libstdc++6 procps chromium openbox xdotool scrot > "$repo/wanted"
: > /opt/src/empty-status
apt-get -o Dir::State::status=/opt/src/empty-status -o Dir::Cache::archives="$repo" install --download-only -y -qq --no-install-recommends \
  $(cat "$repo/wanted") "$repo/kasmvncserver_trixie_1.5.0_amd64.deb"
echo kasmvncserver >> "$repo/wanted"
cd "$repo" && rm -rf partial lock && dpkg-scanpackages --multiversion . /dev/null > Packages 2>/dev/null
chown -R ci:ci "$out" /opt/src
