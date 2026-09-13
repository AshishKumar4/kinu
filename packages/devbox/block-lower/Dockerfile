FROM docker.io/library/rust@sha256:4fec02de605563c297c78a31064c8335bc004fa2b0bf406b1b99441da64e2d2d AS build
RUN apk add --no-cache build-base
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM docker.io/cloudflare/sandbox@sha256:822501de5f0c52a012c125c4e5e4c0080421a8e93ca4ce0ba3d247148021989f AS squash
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential libfuse-dev libzstd-dev zlib1g-dev pkg-config
ADD --checksum=sha256:42d4dfd17ed186745117cfd427023eb81effff3832bab09067823492b6b982e7 https://github.com/vasi/squashfuse/releases/download/0.1.103/squashfuse-0.1.103.tar.gz /build/source.tar.gz
WORKDIR /build
RUN tar -xzf source.tar.gz && cd squashfuse-0.1.103 && ./configure --disable-shared --disable-demo --disable-high-level --enable-low-level && make -j2

FROM docker.io/cloudflare/sandbox@sha256:822501de5f0c52a012c125c4e5e4c0080421a8e93ca4ce0ba3d247148021989f
COPY --from=build /build/target/release/devbox-block-lower /usr/local/bin/devbox-block-lower
COPY --from=squash /build/squashfuse-0.1.103/squashfuse_ll /usr/local/bin/devbox-squashfuse
