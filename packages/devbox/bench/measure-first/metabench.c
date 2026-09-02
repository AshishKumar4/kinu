/* Lane 0 probe: metadata cost per entry on one directory.
 *
 *   metabench DIR COUNT FILE_BYTES
 *
 * Creates COUNT files of FILE_BYTES under DIR, then times, per call and with
 * CLOCK_MONOTONIC: stat of every file, one readdir of the directory, open+read
 * of every file, unlink of every file.  Prints one JSON line with the sum,
 * mean, p50, p95 and max of each loop in microseconds.  The same loops the
 * decisive driver's `small-*` cells time from bun, minus the runtime.
 */

#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

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

static void print_summary(const char *name, double *samples, size_t count, bool last) {
  qsort(samples, count, sizeof(double), compare_double);
  double sum = 0;
  for (size_t i = 0; i < count; i++) sum += samples[i];
  size_t p50 = count == 0 ? 0 : (count * 50) / 100;
  size_t p95 = count == 0 ? 0 : (count * 95) / 100;
  if (p50 >= count && count > 0) p50 = count - 1;
  if (p95 >= count && count > 0) p95 = count - 1;
  printf("\"%s\":{\"ops\":%zu,\"sumUs\":%.1f,\"meanUs\":%.3f,\"p50Us\":%.3f,\"p95Us\":%.3f,\"maxUs\":%.3f}%s", name, count,
         sum, count == 0 ? 0 : sum / (double)count, count == 0 ? 0 : samples[p50], count == 0 ? 0 : samples[p95],
         count == 0 ? 0 : samples[count - 1], last ? "" : ",");
}

static void fail(const char *what) {
  fprintf(stderr, "metabench: %s: %s\n", what, strerror(errno));
  exit(1);
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: %s DIR COUNT FILE_BYTES\n", argv[0]);
    return 2;
  }
  const char *dir = argv[1];
  size_t count = (size_t)strtoull(argv[2], NULL, 10);
  size_t bytes = (size_t)strtoull(argv[3], NULL, 10);
  if (count == 0 || count > 10000000) return 2;

  char *body = malloc(bytes == 0 ? 1 : bytes);
  if (body == NULL) fail("malloc");
  for (size_t i = 0; i < bytes; i++) body[i] = (char)('a' + (i % 26));

  double *create = calloc(count, sizeof(double));
  double *stat_us = calloc(count, sizeof(double));
  double *read_us = calloc(count, sizeof(double));
  double *unlink_us = calloc(count, sizeof(double));
  if (create == NULL || stat_us == NULL || read_us == NULL || unlink_us == NULL) fail("calloc");

  char path[4096];
  int dir_fd = open(dir, O_RDONLY | O_DIRECTORY);
  if (dir_fd < 0) fail("open dir");

  for (size_t i = 0; i < count; i++) {
    snprintf(path, sizeof(path), "%s/f%06zu.txt", dir, i);
    double t0 = now_us();
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) fail("create");
    size_t sent = 0;
    while (sent < bytes) {
      ssize_t n = write(fd, body + sent, bytes - sent);
      if (n < 0) fail("write");
      sent += (size_t)n;
    }
    if (close(fd) != 0) fail("close");
    create[i] = now_us() - t0;
  }

  struct stat st;
  for (size_t i = 0; i < count; i++) {
    snprintf(path, sizeof(path), "%s/f%06zu.txt", dir, i);
    double t0 = now_us();
    if (stat(path, &st) != 0) fail("stat");
    stat_us[i] = now_us() - t0;
  }

  double r0 = now_us();
  DIR *listing = opendir(dir);
  if (listing == NULL) fail("opendir");
  size_t listed = 0;
  struct dirent *entry;
  while ((entry = readdir(listing)) != NULL) listed++;
  closedir(listing);
  double readdir_us = now_us() - r0;

  char *buffer = malloc(bytes == 0 ? 1 : bytes);
  if (buffer == NULL) fail("malloc");
  for (size_t i = 0; i < count; i++) {
    snprintf(path, sizeof(path), "%s/f%06zu.txt", dir, i);
    double t0 = now_us();
    int fd = open(path, O_RDONLY);
    if (fd < 0) fail("open read");
    size_t got = 0;
    while (got < bytes) {
      ssize_t n = read(fd, buffer + got, bytes - got);
      if (n < 0) fail("read");
      if (n == 0) break;
      got += (size_t)n;
    }
    close(fd);
    read_us[i] = now_us() - t0;
  }

  for (size_t i = 0; i < count; i++) {
    snprintf(path, sizeof(path), "%s/f%06zu.txt", dir, i);
    double t0 = now_us();
    if (unlink(path) != 0) fail("unlink");
    unlink_us[i] = now_us() - t0;
  }
  close(dir_fd);

  printf("{\"count\":%zu,\"fileBytes\":%zu,\"readdirEntries\":%zu,\"readdirUs\":%.1f,", count, bytes, listed, readdir_us);
  print_summary("create", create, count, false);
  print_summary("stat", stat_us, count, false);
  print_summary("read", read_us, count, false);
  print_summary("unlink", unlink_us, count, true);
  printf("}\n");
  return 0;
}
