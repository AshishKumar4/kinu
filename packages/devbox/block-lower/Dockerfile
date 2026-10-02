FROM docker.io/library/rust@sha256:4fec02de605563c297c78a31064c8335bc004fa2b0bf406b1b99441da64e2d2d AS build
RUN apk add --no-cache build-base
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo test --locked && cargo build --release --locked

FROM ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254 AS squash
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential libfuse-dev libzstd-dev zlib1g-dev pkg-config
ADD --checksum=sha256:42d4dfd17ed186745117cfd427023eb81effff3832bab09067823492b6b982e7 https://github.com/vasi/squashfuse/releases/download/0.1.103/squashfuse-0.1.103.tar.gz /build/source.tar.gz
WORKDIR /build
RUN tar -xzf source.tar.gz && cd squashfuse-0.1.103 && ./configure --disable-shared --disable-demo --disable-high-level --enable-low-level && make -j2

FROM docker.io/cloudflare/sandbox@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 AS shim
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS node
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS bun
FROM ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bash ca-certificates curl git python3 tmux tini fuse3 fuse-overlayfs squashfs-tools zstd s3fs=1.93-1build3 libfuse2t64 libzstd1 libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /build/target/release/devbox-block-lower /usr/local/bin/devbox-block-lower
COPY --from=squash /build/squashfuse-0.1.103/squashfuse_ll /usr/local/bin/devbox-squashfuse
COPY --from=shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace /var/tmp/devbox && ln -s /usr/bin/fusermount3 /usr/local/bin/fusermount
WORKDIR /
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
