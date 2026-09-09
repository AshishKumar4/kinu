# The shipped workspace image, plus a compiler and libfuse so the two probes
# beside this file can be built INSIDE it. FROM the shipped tag on purpose: the
# positive case has to run on the same fuse-overlayfs the product attaches, not
# on a lookalike.
#
# The tag MUST equal the @cloudflare/sandbox version in packages/devbox/package.json
# and bench/wrangler.jsonc; a drift makes this suite assert the contract of an
# image the product does not run.
FROM docker.io/cloudflare/sandbox:0.12.8

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends gcc libc6-dev libfuse3-dev \
 && rm -rf /var/lib/apt/lists/*

COPY mmap-probe.c direct-io-fs.c run.sh /probe/
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/mmap-probe /probe/mmap-probe.c \
 && gcc -O2 -Wall -Wextra -D_FILE_OFFSET_BITS=64 -o /usr/local/bin/direct-io-fs \
      /probe/direct-io-fs.c -lfuse3 -lpthread \
 && chmod +x /probe/run.sh
