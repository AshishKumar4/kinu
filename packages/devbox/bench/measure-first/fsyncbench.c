/* Lane 0 probe: write+fdatasync latency through one open file.
 *
 *   fsyncbench FILE OPS
 *
 * Each operation pwrite()s one deterministic 4 KiB page at a distinct offset,
 * then fdatasync()s that open file. It prints p50/p95/mean/max for the pwrite,
 * the fdatasync and the pair in microseconds. The pair is the contract users
 * observe; the split says which half changed.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define BLOCK 4096

static double now_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1e6 + (double)ts.tv_nsec / 1e3;
}

static int compare_double(const void *a, const void *b) {
  double x = *(const double *)a;
  double y = *(const double *)b;
  return x < y ? -1 : x > y ? 1 : 0;
}

static void print_summary(const char *name, double *values, size_t count, int last) {
  qsort(values, count, sizeof(double), compare_double);
  double sum = 0;
  for (size_t i = 0; i < count; i++) sum += values[i];
  size_t p50 = (count * 50) / 100;
  size_t p95 = (count * 95) / 100;
  if (p50 >= count) p50 = count - 1;
  if (p95 >= count) p95 = count - 1;
  printf("\"%s\":{\"ops\":%zu,\"meanUs\":%.2f,\"p50Us\":%.2f,\"p95Us\":%.2f,\"maxUs\":%.2f}%s", name, count,
         sum / (double)count, values[p50], values[p95], values[count - 1], last ? "" : ",");
}

static void fail(const char *what) {
  fprintf(stderr, "fsyncbench: %s: %s\n", what, strerror(errno));
  exit(1);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s FILE OPS\n", argv[0]);
    return 2;
  }
  size_t ops = strtoull(argv[2], NULL, 10);
  if (ops == 0 || ops > 1000000) return 2;
  double *write_us = calloc(ops, sizeof(double));
  double *sync_us = calloc(ops, sizeof(double));
  double *pair_us = calloc(ops, sizeof(double));
  if (write_us == NULL || sync_us == NULL || pair_us == NULL) fail("calloc");

  char block[BLOCK];
  for (size_t i = 0; i < sizeof(block); i++) block[i] = (char)(i * 31u + 17u);
  int fd = open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) fail("open");
  for (size_t i = 0; i < ops; i++) {
    double t0 = now_us();
    ssize_t written = pwrite(fd, block, sizeof(block), (off_t)(i * sizeof(block)));
    double t1 = now_us();
    if (written != (ssize_t)sizeof(block)) fail("pwrite");
    if (fdatasync(fd) != 0) fail("fdatasync");
    double t2 = now_us();
    write_us[i] = t1 - t0;
    sync_us[i] = t2 - t1;
    pair_us[i] = t2 - t0;
  }
  close(fd);
  printf("{\"ops\":%zu,", ops);
  print_summary("pwrite", write_us, ops, 0);
  print_summary("fdatasync", sync_us, ops, 0);
  print_summary("pair", pair_us, ops, 1);
  printf("}\n");
  return 0;
}
