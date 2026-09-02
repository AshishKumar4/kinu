/* Lane 0 probe: range reads at a fixed concurrency through a filesystem.
 *
 *   rangeread FILE RANGE_BYTES CONCURRENCY REQUESTS SEED
 *
 * CONCURRENCY threads share one open file and each pread whole RANGE_BYTES
 * windows at random RANGE_BYTES-aligned offsets until REQUESTS windows have
 * been read in total.  Every window is timed with CLOCK_MONOTONIC.  Prints
 * one JSON line: p50, p95, mean and max latency in milliseconds, wall time,
 * bytes read and MiB/s.  Used against the s3fs mount, where a pread is the
 * range GET the design's hydrator would otherwise issue itself.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1e3 + (double)ts.tv_nsec / 1e6;
}

struct shared {
  int fd;
  uint64_t range;
  uint64_t windows;
  uint64_t requests;
  uint64_t next;
  uint64_t seed;
  pthread_mutex_t lock;
  double *latencies;
  uint64_t bytes;
  int failed;
};


static void *worker(void *arg) {
  struct shared *s = arg;
  char *buffer = malloc(s->range);
  if (buffer == NULL) {
    s->failed = 1;
    return NULL;
  }
  for (;;) {
    pthread_mutex_lock(&s->lock);
    uint64_t index = s->next;
    if (index >= s->requests || s->failed) {
      pthread_mutex_unlock(&s->lock);
      break;
    }
    s->next++;
    pthread_mutex_unlock(&s->lock);
    /* 7919 is odd, so this is a permutation for the power-of-two window
     * counts used by the probe. No request in one cell can hit a range a
     * sibling already put in s3fs's open-file cache. */
    uint64_t window = (index * 7919ULL + s->seed) % s->windows;
    off_t offset = (off_t)(window * s->range);
    double t0 = now_ms();
    uint64_t got = 0;
    while (got < s->range) {
      ssize_t n = pread(s->fd, buffer + got, s->range - got, offset + (off_t)got);
      if (n < 0) {
        if (errno == EINTR) continue;
        fprintf(stderr, "rangeread: pread at %lld: %s\n", (long long)offset, strerror(errno));
        s->failed = 1;
        break;
      }
      if (n == 0) break;
      got += (uint64_t)n;
    }
    double elapsed = now_ms() - t0;
    pthread_mutex_lock(&s->lock);
    s->latencies[index] = elapsed;
    s->bytes += got;
    if (got != s->range) s->failed = 1;
    pthread_mutex_unlock(&s->lock);
  }
  free(buffer);
  return NULL;
}

static int compare_double(const void *a, const void *b) {
  double x = *(const double *)a;
  double y = *(const double *)b;
  return x < y ? -1 : x > y ? 1 : 0;
}

int main(int argc, char **argv) {
  if (argc != 6) {
    fprintf(stderr, "usage: %s FILE RANGE_BYTES CONCURRENCY REQUESTS SEED\n", argv[0]);
    return 2;
  }
  struct shared s;
  memset(&s, 0, sizeof(s));
  s.range = strtoull(argv[2], NULL, 10);
  unsigned concurrency = (unsigned)strtoul(argv[3], NULL, 10);
  s.requests = strtoull(argv[4], NULL, 10);
  s.seed = strtoull(argv[5], NULL, 10);
  if (s.range == 0 || concurrency == 0 || concurrency > 256 || s.requests == 0) return 2;
  s.fd = open(argv[1], O_RDONLY);
  if (s.fd < 0) {
    fprintf(stderr, "rangeread: open %s: %s\n", argv[1], strerror(errno));
    return 1;
  }
  struct stat st;
  if (fstat(s.fd, &st) != 0 || (uint64_t)st.st_size < s.range) {
    fprintf(stderr, "rangeread: file smaller than one range\n");
    return 1;
  }
  s.windows = (uint64_t)st.st_size / s.range;
  s.latencies = calloc(s.requests, sizeof(double));
  if (s.latencies == NULL) return 1;
  pthread_mutex_init(&s.lock, NULL);

  pthread_t threads[256];
  double wall0 = now_ms();
  for (unsigned i = 0; i < concurrency; i++) {
    if (pthread_create(&threads[i], NULL, worker, &s) != 0) {
      fprintf(stderr, "rangeread: pthread_create failed\n");
      return 1;
    }
  }
  for (unsigned i = 0; i < concurrency; i++) pthread_join(threads[i], NULL);
  double wall = now_ms() - wall0;
  if (s.failed) {
    fprintf(stderr, "rangeread: a read failed or came back short\n");
    return 1;
  }
  qsort(s.latencies, s.requests, sizeof(double), compare_double);
  double sum = 0;
  for (uint64_t i = 0; i < s.requests; i++) sum += s.latencies[i];
  uint64_t p50 = (s.requests * 50) / 100;
  uint64_t p95 = (s.requests * 95) / 100;
  if (p95 >= s.requests) p95 = s.requests - 1;
  printf("{\"rangeBytes\":%llu,\"concurrency\":%u,\"requests\":%llu,\"bytes\":%llu,\"wallMs\":%.1f,"
         "\"p50Ms\":%.2f,\"p95Ms\":%.2f,\"meanMs\":%.2f,\"maxMs\":%.2f,\"mibPerSec\":%.2f}\n",
         (unsigned long long)s.range, concurrency, (unsigned long long)s.requests, (unsigned long long)s.bytes, wall,
         s.latencies[p50], s.latencies[p95], sum / (double)s.requests, s.latencies[s.requests - 1],
         wall > 0 ? ((double)s.bytes / (1024.0 * 1024.0)) / (wall / 1e3) : 0);
  close(s.fd);
  return 0;
}
