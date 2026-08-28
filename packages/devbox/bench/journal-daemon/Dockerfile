FROM docker.io/cloudflare/sandbox:0.12.8

ARG LIBFUSE_VERSION=3.17.1
ARG LIBFUSE_SHA256=2d8ae87a4525fbfa1db5e5eb010ff6f38140627a7004554ed88411c1843d51b2

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl libssl-dev meson ninja-build pkg-config \
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
 && ldconfig
COPY journal-daemon.c /usr/local/src/kinu-journal-daemon.c
RUN cc -std=c17 -D_FILE_OFFSET_BITS=64 -Wall -Wextra -Werror -Wpedantic -O2 \
      /usr/local/src/kinu-journal-daemon.c -o /usr/local/bin/kinu-journal-daemon \
      $(pkg-config --cflags --libs fuse3) -lcrypto -pthread
# The shutdown races the matrix asserts on resolve cleanly most of the time, so
# the matrix reruns the same shutdowns against this build, which reports them.
RUN cc -std=c17 -D_FILE_OFFSET_BITS=64 -Wall -Wextra -Werror -Wpedantic -O1 -g -fsanitize=thread \
      /usr/local/src/kinu-journal-daemon.c -o /usr/local/bin/kinu-journal-daemon-tsan \
      $(pkg-config --cflags --libs fuse3) -lcrypto -pthread
