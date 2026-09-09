/*
 * Does this filesystem honour a writable MAP_SHARED mapping?
 *
 * One question, answered the way SQLite's WAL asks it: open a file, map it
 * MAP_SHARED with PROT_WRITE, store a byte through the mapping, msync, and read
 * it back through an ordinary pread. Anything that refuses is printed as its
 * errno NAME, because the name is the contract: a filesystem whose files are
 * direct-io answers ENODEV, and that is a different failure from a read-only
 * mount (EACCES) or a kernel without the call (ENOSYS).
 *
 * No product code: this file is the whole probe.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static const char *errno_name(int value) {
  switch (value) {
    case ENODEV: return "ENODEV";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOSYS: return "ENOSYS";
    case EINVAL: return "EINVAL";
    case ENOMEM: return "ENOMEM";
    case EROFS: return "EROFS";
    default: return "OTHER";
  }
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: mmap-probe <path>\n");
    return 2;
  }
  int fd = open(argv[1], O_RDWR | O_CREAT, 0644);
  if (fd < 0) {
    printf("open %s\n", errno_name(errno));
    return 1;
  }
  const size_t length = 4096;
  if (ftruncate(fd, (off_t)length) != 0) {
    printf("ftruncate %s\n", errno_name(errno));
    close(fd);
    return 1;
  }
  void *mapped = mmap(NULL, length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (mapped == MAP_FAILED) {
    printf("mmap %s\n", errno_name(errno));
    close(fd);
    return 1;
  }
  memcpy(mapped, "shared", 6);
  if (msync(mapped, length, MS_SYNC) != 0) {
    printf("msync %s\n", errno_name(errno));
    munmap(mapped, length);
    close(fd);
    return 1;
  }
  if (munmap(mapped, length) != 0) {
    printf("munmap %s\n", errno_name(errno));
    close(fd);
    return 1;
  }
  char read_back[7] = {0};
  ssize_t got = pread(fd, read_back, 6, 0);
  close(fd);
  if (got != 6 || memcmp(read_back, "shared", 6) != 0) {
    printf("readback MISMATCH\n");
    return 1;
  }
  printf("mmap OK\n");
  return 0;
}
