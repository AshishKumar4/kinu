# The shipped workspace image, plus a compiler and libfuse so the two probes
# beside this file can be built INSIDE it. FROM the shipped tag on purpose: the
# positive case has to run on the same fuse-overlayfs the product attaches, not
# on a lookalike.
#
# The tag MUST equal the @cloudflare/sandbox version in packages/devbox/package.json
# and bench/wrangler.jsonc; a drift makes this suite assert the contract of an
# image the product does not run.
FROM docker.io/cloudflare/sandbox@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends gcc libc6-dev libfuse3-dev \
 && rm -rf /var/lib/apt/lists/*

COPY mmap-probe.c direct-io-fs.c run.sh /probe/
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/mmap-probe /probe/mmap-probe.c \
 && gcc -O2 -Wall -Wextra -D_FILE_OFFSET_BITS=64 -o /usr/local/bin/direct-io-fs \
      /probe/direct-io-fs.c -lfuse3 -lpthread \
 && chmod +x /probe/run.sh
