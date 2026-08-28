# The writable mmap probe has its own image. It is never used by product code.
# libfuse is built from a pinned release because Ubuntu 22.04's package predates
# FUSE_CAP_DIRECT_IO_ALLOW_MMAP. The archive digest makes a build fail closed.
FROM docker.io/cloudflare/sandbox:0.12.8

ARG LIBFUSE_VERSION=3.17.1
ARG LIBFUSE_SHA256=2d8ae87a4525fbfa1db5e5eb010ff6f38140627a7004554ed88411c1843d51b2

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl meson ninja-build pkg-config \
 && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --silent --show-error \
      "https://github.com/libfuse/libfuse/releases/download/fuse-${LIBFUSE_VERSION}/fuse-${LIBFUSE_VERSION}.tar.gz" \
      -o /tmp/libfuse.tar.gz \
 && echo "${LIBFUSE_SHA256}  /tmp/libfuse.tar.gz" | sha256sum --check --status \
 && mkdir /tmp/libfuse \
 && tar -xzf /tmp/libfuse.tar.gz -C /tmp/libfuse --strip-components=1 \
 && meson setup /tmp/libfuse/build /tmp/libfuse -Dexamples=false -Dtests=false -Duseroot=false \
 && meson compile -C /tmp/libfuse/build \
 && meson install -C /tmp/libfuse/build \
 && cp /tmp/libfuse/include/fuse_kernel.h /usr/local/include/fuse3/fuse_kernel.h \
 && ldconfig \
 && rm -rf /tmp/libfuse /tmp/libfuse.tar.gz
COPY writable-probe.c /usr/local/src/fuse-mmap-probe.c
RUN cc -std=c17 -D_FILE_OFFSET_BITS=64 -Wall -Wextra -Werror -Wpedantic -O2 \
      /usr/local/src/fuse-mmap-probe.c -o /usr/local/bin/fuse-mmap-probe \
      $(pkg-config --cflags --libs fuse3) -pthread \
 && { \
      printf '{"libfuse":"%s","kernel":{"major":%s,"minor":%s},"constants":{"directIoAllowMmap":%s,"openDirectIo":%s},"headers":{' \
        "${LIBFUSE_VERSION}" 7 40 68719476736 1; \
      printf '"fuse_kernel_h":"'; sha256sum /usr/local/include/fuse3/fuse_kernel.h | cut -d' ' -f1 | tr -d '\n'; \
      printf '","fuse_lowlevel_h":"'; sha256sum /usr/local/include/fuse3/fuse_lowlevel.h | cut -d' ' -f1 | tr -d '\n'; \
      printf '","sourceSha256":"'; sha256sum /usr/local/src/fuse-mmap-probe.c | cut -d' ' -f1 | tr -d '\n'; \
      printf '"}}\n'; \
    } > /usr/local/share/fuse-mmap-header.json
