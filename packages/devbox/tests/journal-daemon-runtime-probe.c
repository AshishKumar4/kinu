/* POSIX probe for the journal daemon runtime matrix.
 *
 * The matrix harness drives this binary through the daemon's mount point.  Each
 * mode prints one JSON object per line: {"check":..,"ok":..,"detail":..} for a
 * verified property, {"event":"round",..} for mmap progress, and a final
 * {"mode":..,"checks":..,"failed":..} summary.  Exit status is the failure
 * count, so the harness fails loudly even if it never parses a line.
 */

#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>

#define PAGE 4096
#define RENAME_NOREPLACE_FLAG (1 << 0)
#define RENAME_EXCHANGE_FLAG (1 << 1)

static unsigned checks_run;
static unsigned checks_failed;

static void check(const char *name, bool ok, const char *format, ...) {
  char detail[512];
  va_list args;
  va_start(args, format);
  vsnprintf(detail, sizeof(detail), format, args);
  va_end(args);
  for (char *p = detail; *p != '\0'; p++) {
    if (*p == '"' || *p == '\\') *p = '\'';
    if (*p == '\n' || *p == '\t') *p = ' ';
  }
  checks_run++;
  if (!ok) checks_failed++;
  printf("{\"check\":\"%s\",\"ok\":%s,\"detail\":\"%s\"}\n", name, ok ? "true" : "false", detail);
  fflush(stdout);
}

static int summary(const char *mode) {
  printf("{\"mode\":\"%s\",\"checks\":%u,\"failed\":%u}\n", mode, checks_run, checks_failed);
  fflush(stdout);
  return checks_failed == 0 ? 0 : 1;
}

static long long now_ms(void) {
  struct timespec ts;
  /* Wall clock: the harness correlates these stamps with its own fence window. */
  clock_gettime(CLOCK_REALTIME, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int join_path(char *out, size_t cap, const char *base, const char *name) {
  int written = snprintf(out, cap, "%s/%s", base, name);
  return written < 0 || (size_t)written >= cap ? -1 : 0;
}

static ssize_t write_file(const char *path, const void *bytes, size_t size, mode_t mode) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
  if (fd < 0) return -1;
  ssize_t written = size == 0 ? 0 : pwrite(fd, bytes, size, 0);
  if (close(fd) != 0) return -1;
  return written;
}

static ssize_t read_file(const char *path, void *bytes, size_t size) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return -1;
  ssize_t got = pread(fd, bytes, size, 0);
  close(fd);
  return got;
}

static void fill_pattern(unsigned char *bytes, size_t size, unsigned seed) {
  for (size_t index = 0; index < size; index++) bytes[index] = (unsigned char)((index * 31 + seed) & 0xff);
}

static bool pattern_matches(const unsigned char *bytes, size_t size, unsigned seed) {
  for (size_t index = 0; index < size; index++) {
    if (bytes[index] != (unsigned char)((index * 31 + seed) & 0xff)) return false;
  }
  return true;
}

/* ------------------------------------------------------------ posix ------ */

static void probe_create_read(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "create.txt") != 0) return;
  const char *text = "hello sealed journal";
  ssize_t written = write_file(path, text, strlen(text), 0644);
  char back[64] = {0};
  ssize_t got = read_file(path, back, sizeof(back) - 1);
  struct stat st;
  bool ok = written == (ssize_t)strlen(text) && got == (ssize_t)strlen(text) && strcmp(back, text) == 0 &&
            stat(path, &st) == 0 && st.st_size == (off_t)strlen(text) && (st.st_mode & 07777) == 0644;
  check("create-read", ok, "wrote=%zd read=%zd", written, got);
}

static void probe_partial_write(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "partial.bin") != 0) return;
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    check("partial-write", false, "open failed errno=%d", errno);
    return;
  }
  unsigned char block[1024];
  fill_pattern(block, sizeof(block), 7);
  ssize_t first = pwrite(fd, block, sizeof(block), 0);
  ssize_t second = pwrite(fd, block, 512, 4096);
  unsigned char back[1024];
  ssize_t read_first = pread(fd, back, sizeof(back), 0);
  bool head_ok = read_first == (ssize_t)sizeof(back) && pattern_matches(back, sizeof(back), 7);
  unsigned char gap[512];
  memset(gap, 0xaa, sizeof(gap));
  ssize_t read_gap = pread(fd, gap, sizeof(gap), 2048);
  bool gap_zero = read_gap == (ssize_t)sizeof(gap);
  for (size_t index = 0; gap_zero && index < sizeof(gap); index++) gap_zero = gap[index] == 0;
  struct stat st;
  bool ok = first == (ssize_t)sizeof(block) && second == 512 && head_ok && gap_zero && fstat(fd, &st) == 0 &&
            st.st_size == 4096 + 512;
  close(fd);
  check("partial-write", ok, "first=%zd second=%zd head=%d gap=%d", first, second, head_ok ? 1 : 0, gap_zero ? 1 : 0);
}

static void probe_error_writes(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "readonly.txt") != 0) return;
  write_file(path, "abc", 3, 0644);
  int fd = open(path, O_RDONLY);
  ssize_t refused = fd < 0 ? -1 : pwrite(fd, "x", 1, 0);
  int refused_errno = errno;
  if (fd >= 0) close(fd);
  check("error-write-ebadf", refused < 0 && refused_errno == EBADF, "rc=%zd errno=%d", refused, refused_errno);

  char missing[PATH_MAX];
  if (join_path(missing, sizeof(missing), dir, "absent/deeper.txt") != 0) return;
  int gone = open(missing, O_RDONLY);
  int gone_errno = errno;
  if (gone >= 0) close(gone);
  check("error-open-enoent", gone < 0 && gone_errno == ENOENT, "rc=%d errno=%d", gone, gone_errno);

  char directory[PATH_MAX];
  if (join_path(directory, sizeof(directory), dir, "dir-as-file") != 0) return;
  mkdir(directory, 0755);
  int as_file = open(directory, O_WRONLY);
  int as_file_errno = errno;
  if (as_file >= 0) close(as_file);
  check("error-open-eisdir", as_file < 0 && as_file_errno == EISDIR, "rc=%d errno=%d", as_file, as_file_errno);
}

static void probe_rename_flags(const char *dir) {
  char a[PATH_MAX];
  char b[PATH_MAX];
  char c[PATH_MAX];
  if (join_path(a, sizeof(a), dir, "rename-a") != 0 || join_path(b, sizeof(b), dir, "rename-b") != 0 ||
      join_path(c, sizeof(c), dir, "rename-c") != 0) {
    return;
  }
  write_file(a, "AAA", 3, 0644);
  write_file(b, "BBB", 3, 0644);

  long blocked = syscall(SYS_renameat2, AT_FDCWD, a, AT_FDCWD, b, RENAME_NOREPLACE_FLAG);
  int blocked_errno = errno;
  check("rename-noreplace-refused", blocked != 0 && blocked_errno == EEXIST, "rc=%ld errno=%d", blocked,
        blocked_errno);

  long exchanged = syscall(SYS_renameat2, AT_FDCWD, a, AT_FDCWD, b, RENAME_EXCHANGE_FLAG);
  char first[8] = {0};
  char second[8] = {0};
  read_file(a, first, sizeof(first) - 1);
  read_file(b, second, sizeof(second) - 1);
  check("rename-exchange", exchanged == 0 && strcmp(first, "BBB") == 0 && strcmp(second, "AAA") == 0,
        "rc=%ld a=%s b=%s", exchanged, first, second);

  long moved = syscall(SYS_renameat2, AT_FDCWD, a, AT_FDCWD, c, RENAME_NOREPLACE_FLAG);
  struct stat st;
  check("rename-noreplace-allowed", moved == 0 && stat(c, &st) == 0 && stat(a, &st) != 0, "rc=%ld", moved);
}

static void probe_unlink_open(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "unlink-open.bin") != 0) return;
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    check("unlink-open", false, "open failed errno=%d", errno);
    return;
  }
  unsigned char block[2048];
  fill_pattern(block, sizeof(block), 11);
  bool wrote = pwrite(fd, block, sizeof(block), 0) == (ssize_t)sizeof(block);
  bool removed = unlink(path) == 0;
  bool gone = access(path, F_OK) != 0 && errno == ENOENT;
  unsigned char back[2048];
  bool readable = pread(fd, back, sizeof(back), 0) == (ssize_t)sizeof(back) && pattern_matches(back, sizeof(back), 11);
  unsigned char more[256];
  fill_pattern(more, sizeof(more), 13);
  bool appended = pwrite(fd, more, sizeof(more), 4096) == (ssize_t)sizeof(more);
  bool synced = fsync(fd) == 0;
  struct stat st;
  bool stated = fstat(fd, &st) == 0 && st.st_nlink == 0 && st.st_size == 4096 + 256;
  unsigned char tail[256];
  bool tail_ok = pread(fd, tail, sizeof(tail), 4096) == (ssize_t)sizeof(tail) && pattern_matches(tail, sizeof(tail), 13);
  close(fd);
  check("unlink-open", wrote && removed && gone && readable && appended && synced && stated && tail_ok,
        "wrote=%d removed=%d gone=%d readable=%d appended=%d synced=%d stated=%d tail=%d", wrote, removed, gone,
        readable, appended, synced, stated, tail_ok);
}

static void probe_hardlink(const char *dir) {
  char first[PATH_MAX];
  char second[PATH_MAX];
  if (join_path(first, sizeof(first), dir, "link-first") != 0 || join_path(second, sizeof(second), dir, "link-second") != 0) {
    return;
  }
  write_file(first, "shared", 6, 0640);
  bool linked = link(first, second) == 0;
  struct stat a;
  struct stat b;
  bool stated = stat(first, &a) == 0 && stat(second, &b) == 0;
  bool same = stated && a.st_ino == b.st_ino && a.st_nlink == 2 && b.st_nlink == 2;
  int fd = open(first, O_WRONLY);
  bool wrote = fd >= 0 && pwrite(fd, "SHARED", 6, 0) == 6;
  if (fd >= 0) close(fd);
  char back[8] = {0};
  bool visible = read_file(second, back, sizeof(back) - 1) == 6 && strcmp(back, "SHARED") == 0;
  struct timespec times[2] = {{.tv_sec = 1000000, .tv_nsec = 123456789}, {.tv_sec = 1000001, .tv_nsec = 987654321}};
  bool timestamped = utimensat(AT_FDCWD, first, times, 0) == 0;
  check("hardlink", linked && same && wrote && visible && timestamped,
        "linked=%d same=%d visible=%d timestamped=%d via=%s", linked, same, visible, timestamped, back);
}

static unsigned count_extents(int fd, off_t size) {
  unsigned extents = 0;
  for (off_t position = 0; position < size;) {
    off_t data = lseek(fd, position, SEEK_DATA);
    if (data < 0) break;
    off_t hole = lseek(fd, data, SEEK_HOLE);
    if (hole < 0) break;
    extents++;
    position = hole;
  }
  return extents;
}

static void probe_sparse(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "sparse.bin") != 0) return;
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    check("sparse", false, "open failed errno=%d", errno);
    return;
  }
  const off_t size = 4 * 1024 * 1024;
  bool sized = ftruncate(fd, size) == 0;
  unsigned char block[PAGE];
  fill_pattern(block, sizeof(block), 17);
  bool head = pwrite(fd, block, sizeof(block), 0) == (ssize_t)sizeof(block);
  bool tail = pwrite(fd, block, sizeof(block), 3 * 1024 * 1024) == (ssize_t)sizeof(block);
  bool synced = fdatasync(fd) == 0;
  unsigned extents = count_extents(fd, size);
  struct stat st;
  bool stated = fstat(fd, &st) == 0;
  bool holey = stated && st.st_size == size && (off_t)st.st_blocks * 512 < size / 2;
  check("sparse-extents", sized && head && tail && synced && extents >= 2 && holey,
        "extents=%u blocks=%lld size=%lld", extents, stated ? (long long)st.st_blocks : -1,
        stated ? (long long)st.st_size : -1);

  bool allocated = fallocate(fd, 0, size, PAGE) == 0;
  bool grew = fstat(fd, &st) == 0 && st.st_size == size + PAGE;
  check("fallocate-extend", allocated && grew, "rc=%d size=%lld", allocated ? 0 : errno, (long long)st.st_size);

  bool punched = fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 0, PAGE) == 0;
  off_t first_data = lseek(fd, 0, SEEK_DATA);
  bool hole_at_head = punched && first_data > 0;
  check("fallocate-punch-hole", hole_at_head, "punched=%d firstData=%lld", punched ? 1 : 0, (long long)first_data);

  bool shrunk = ftruncate(fd, PAGE) == 0 && fstat(fd, &st) == 0 && st.st_size == PAGE;
  unsigned char zeroed[PAGE];
  memset(zeroed, 0xff, sizeof(zeroed));
  bool zero_read = pread(fd, zeroed, sizeof(zeroed), 0) == (ssize_t)sizeof(zeroed);
  bool zeros = zero_read;
  for (size_t index = 0; zeros && index < sizeof(zeroed); index++) zeros = zeroed[index] == 0;
  check("truncate", shrunk && zeros, "shrunk=%d zeros=%d", shrunk ? 1 : 0, zeros ? 1 : 0);
  close(fd);
}

static void probe_symlink(const char *dir) {
  char target[PATH_MAX];
  char link_path[PATH_MAX];
  if (join_path(target, sizeof(target), dir, "symlink-target") != 0 ||
      join_path(link_path, sizeof(link_path), dir, "symlink") != 0) {
    return;
  }
  write_file(target, "pointed", 7, 0644);
  bool created = symlink("symlink-target", link_path) == 0;
  char read_back[PATH_MAX] = {0};
  ssize_t length = readlink(link_path, read_back, sizeof(read_back) - 1);
  struct stat lst;
  bool is_link = lstat(link_path, &lst) == 0 && S_ISLNK(lst.st_mode);
  char through[16] = {0};
  bool resolves = read_file(link_path, through, sizeof(through) - 1) == 7 && strcmp(through, "pointed") == 0;
  check("symlink-readlink", created && length == (ssize_t)strlen("symlink-target") &&
                              strcmp(read_back, "symlink-target") == 0 && is_link && resolves,
        "target=%s isLink=%d resolves=%d", read_back, is_link ? 1 : 0, resolves ? 1 : 0);
}

static void probe_dirs(const char *dir) {
  char nested[PATH_MAX];
  char child[PATH_MAX];
  if (join_path(nested, sizeof(nested), dir, "tree") != 0) return;
  bool made = mkdir(nested, 0750) == 0;
  if (join_path(child, sizeof(child), nested, "leaf.txt") != 0) return;
  struct stat st;
  bool mode_ok = made && stat(nested, &st) == 0 && S_ISDIR(st.st_mode) && (st.st_mode & 07777) == 0750;
  write_file(child, "leaf", 4, 0600);
  bool found = false;
  unsigned entries = 0;
  DIR *handle = opendir(nested);
  if (handle != NULL) {
    struct dirent *entry;
    while ((entry = readdir(handle)) != NULL) {
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
      entries++;
      if (strcmp(entry->d_name, "leaf.txt") == 0) found = true;
    }
    closedir(handle);
  }
  bool busy = rmdir(nested) != 0 && errno == ENOTEMPTY;
  bool cleaned = unlink(child) == 0 && rmdir(nested) == 0;
  check("directories", made && found && entries == 1 && busy && cleaned && mode_ok,
        "made=%d entries=%u found=%d busy=%d cleaned=%d", made ? 1 : 0, entries, found ? 1 : 0, busy ? 1 : 0,
        cleaned ? 1 : 0);
}

/* A directory large enough to need several readdir round trips, so the daemon's
 * directory handle has to keep its own offset between them. */
static void probe_readdir_batches(const char *dir) {
  char batched[PATH_MAX];
  if (join_path(batched, sizeof(batched), dir, "batched") != 0) return;
  if (mkdir(batched, 0755) != 0) {
    check("readdir-batches", false, "mkdir errno=%d", errno);
    return;
  }
  const unsigned wanted = 250;
  bool created = true;
  for (unsigned index = 0; created && index < wanted; index++) {
    char name[32];
    char path[PATH_MAX];
    snprintf(name, sizeof(name), "entry-%04u", index);
    created = join_path(path, sizeof(path), batched, name) == 0 && write_file(path, "x", 1, 0644) == 1;
  }
  unsigned seen = 0;
  unsigned distinct = 0;
  DIR *handle = opendir(batched);
  if (handle != NULL) {
    struct dirent *entry;
    while ((entry = readdir(handle)) != NULL) {
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
      seen++;
      if (strncmp(entry->d_name, "entry-", 6) == 0) distinct++;
    }
    rewinddir(handle);
    unsigned again = 0;
    while ((entry = readdir(handle)) != NULL) {
      if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) again++;
    }
    bool stable = again == seen;
    int fd = dirfd(handle);
    bool synced = fd >= 0 && fsync(fd) == 0;
    closedir(handle);
    check("fsyncdir", synced, "synced=%d", synced ? 1 : 0);
    check("readdir-rewind", stable, "first=%u second=%u", seen, again);
  }
  bool removed = true;
  for (unsigned index = 0; removed && index < wanted; index++) {
    char name[32];
    char path[PATH_MAX];
    snprintf(name, sizeof(name), "entry-%04u", index);
    removed = join_path(path, sizeof(path), batched, name) == 0 && unlink(path) == 0;
  }
  bool cleaned = removed && rmdir(batched) == 0;
  check("readdir-batches", created && seen == wanted && distinct == wanted && cleaned,
        "created=%d seen=%u distinct=%u cleaned=%d", created ? 1 : 0, seen, distinct, cleaned ? 1 : 0);
}

static void probe_mknod(const char *dir) {
  char regular[PATH_MAX];
  char fifo[PATH_MAX];
  if (join_path(regular, sizeof(regular), dir, "mknod.bin") != 0 ||
      join_path(fifo, sizeof(fifo), dir, "mknod.fifo") != 0) {
    return;
  }
  bool made = mknod(regular, S_IFREG | 0640, 0) == 0;
  struct stat st;
  bool regular_ok = made && stat(regular, &st) == 0 && S_ISREG(st.st_mode) && (st.st_mode & 07777) == 0640 &&
                    st.st_size == 0;
  bool writable = write_file(regular, "node", 4, 0640) == 4;
  bool taken = mknod(regular, S_IFREG | 0640, 0) != 0 && errno == EEXIST;
  bool piped = mkfifo(fifo, 0600) == 0 && lstat(fifo, &st) == 0 && S_ISFIFO(st.st_mode);
  /* A pipe has no place in a sealed tree, so it never outlives this check. */
  bool cleaned = unlink(fifo) == 0 && unlink(regular) == 0;
  check("mknod", regular_ok && writable && taken && piped && cleaned,
        "regular=%d writable=%d exists=%d fifo=%d cleaned=%d", regular_ok ? 1 : 0, writable ? 1 : 0, taken ? 1 : 0,
        piped ? 1 : 0, cleaned ? 1 : 0);
}

static void probe_metadata(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "metadata.txt") != 0) return;
  write_file(path, "meta", 4, 0644);
  struct stat st;
  bool moded = chmod(path, 0640) == 0 && stat(path, &st) == 0 && (st.st_mode & 07777) == 0640;
  check("chmod", moded, "mode=%o", (unsigned)(st.st_mode & 07777));

  bool owned = chown(path, 65534, 65534) == 0 && stat(path, &st) == 0 && st.st_uid == 65534 && st.st_gid == 65534;
  bool restored = chown(path, 0, 0) == 0 && stat(path, &st) == 0 && st.st_uid == 0;
  check("chown", owned && restored, "owned=%d restored=%d uid=%u", owned ? 1 : 0, restored ? 1 : 0,
        (unsigned)st.st_uid);

  struct timespec times[2];
  times[0].tv_sec = 1000000;
  times[0].tv_nsec = 123456789;
  times[1].tv_sec = 2000000;
  times[1].tv_nsec = 987654321;
  bool timed = utimensat(AT_FDCWD, path, times, 0) == 0 && stat(path, &st) == 0 && st.st_mtim.tv_sec == 2000000 &&
               st.st_mtim.tv_nsec == 987654321 && st.st_atim.tv_sec == 1000000;
  check("utimens", timed, "mtime=%lld.%09ld", (long long)st.st_mtim.tv_sec, (long)st.st_mtim.tv_nsec);
}

static void probe_xattr(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "xattr.txt") != 0) return;
  write_file(path, "attrs", 5, 0644);
  bool set = setxattr(path, "user.kinu.seal", "sealed", 6, 0) == 0;
  char value[32] = {0};
  ssize_t got = getxattr(path, "user.kinu.seal", value, sizeof(value));
  char names[512] = {0};
  ssize_t listed = listxattr(path, names, sizeof(names));
  bool listed_ok = false;
  for (ssize_t index = 0; listed > 0 && index < listed; index += (ssize_t)strlen(names + index) + 1) {
    if (strcmp(names + index, "user.kinu.seal") == 0) listed_ok = true;
  }
  bool removed = removexattr(path, "user.kinu.seal") == 0;
  ssize_t after = getxattr(path, "user.kinu.seal", value, sizeof(value));
  int after_errno = errno;
  check("xattr", set && got == 6 && strcmp(value, "sealed") == 0 && listed_ok && removed && after < 0 &&
                   after_errno == ENODATA,
        "set=%d got=%zd listed=%d removed=%d afterErrno=%d", set ? 1 : 0, got, listed_ok ? 1 : 0, removed ? 1 : 0,
        after_errno);
}

/* Fixtures that survive the run so a fence stage can be inspected for
 * preserved modes, xattrs, hardlinks, holes and unfollowed symlinks. */
static void probe_sealed_inputs(const char *dir) {
  char attr_path[PATH_MAX];
  char sparse_path[PATH_MAX];
  char big_path[PATH_MAX];
  char outside[PATH_MAX];
  if (join_path(attr_path, sizeof(attr_path), dir, "sealed-xattr.txt") != 0 ||
      join_path(sparse_path, sizeof(sparse_path), dir, "sparse-keep.bin") != 0 ||
      join_path(big_path, sizeof(big_path), dir, "big.bin") != 0 ||
      join_path(outside, sizeof(outside), dir, "outside-link") != 0) {
    return;
  }
  write_file(attr_path, "sealed", 6, 0644);
  bool attributed = setxattr(attr_path, "user.kinu.seal", "sealed", 6, 0) == 0;

  int sparse = open(sparse_path, O_RDWR | O_CREAT | O_TRUNC, 0600);
  unsigned char block[PAGE];
  fill_pattern(block, sizeof(block), 29);
  bool holey = sparse >= 0 && ftruncate(sparse, 4 * 1024 * 1024) == 0 &&
               pwrite(sparse, block, sizeof(block), 0) == (ssize_t)sizeof(block) &&
               pwrite(sparse, block, sizeof(block), 3 * 1024 * 1024) == (ssize_t)sizeof(block) &&
               fdatasync(sparse) == 0;
  if (sparse >= 0) close(sparse);

  int big = open(big_path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  bool bulky = big >= 0;
  const off_t big_size = 3 * 512 * 1024;
  for (off_t offset = 0; bulky && offset < big_size; offset += (off_t)sizeof(block)) {
    bulky = pwrite(big, block, sizeof(block), offset) == (ssize_t)sizeof(block);
  }
  if (bulky) bulky = fdatasync(big) == 0;
  if (big >= 0) close(big);

  bool pointed = symlink("/etc", outside) == 0;
  check("sealed-inputs", attributed && holey && bulky && pointed,
        "xattr=%d sparse=%d big=%d outside=%d", attributed ? 1 : 0, holey ? 1 : 0, bulky ? 1 : 0, pointed ? 1 : 0);
}

static void probe_statfs(const char *dir) {
  struct statvfs vfs;
  bool ok = statvfs(dir, &vfs) == 0 && vfs.f_bsize > 0 && vfs.f_blocks > 0 && vfs.f_namemax >= 255;
  check("statfs", ok, "bsize=%lu blocks=%llu namemax=%lu", (unsigned long)vfs.f_bsize,
        (unsigned long long)vfs.f_blocks, (unsigned long)vfs.f_namemax);
}

static void probe_tab_name(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "tab\tname\\file") != 0) return;
  ssize_t written = write_file(path, "tabbed", 6, 0644);
  char back[16] = {0};
  ssize_t got = read_file(path, back, sizeof(back) - 1);
  check("hostile-name", written == 6 && got == 6 && strcmp(back, "tabbed") == 0, "wrote=%zd read=%zd", written, got);
}

static void probe_fsync_flush(const char *dir) {
  char path[PATH_MAX];
  if (join_path(path, sizeof(path), dir, "durable.bin") != 0) return;
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    check("fsync-flush", false, "open failed errno=%d", errno);
    return;
  }
  unsigned char block[8192];
  fill_pattern(block, sizeof(block), 23);
  bool wrote = pwrite(fd, block, sizeof(block), 0) == (ssize_t)sizeof(block);
  bool datasynced = fdatasync(fd) == 0;
  bool synced = fsync(fd) == 0;
  int duplicate = dup(fd);
  bool flushed = duplicate >= 0 && close(duplicate) == 0;
  bool closed = close(fd) == 0;
  check("fsync-flush", wrote && datasynced && synced && flushed && closed,
        "wrote=%d fdatasync=%d fsync=%d flush=%d close=%d", wrote ? 1 : 0, datasynced ? 1 : 0, synced ? 1 : 0,
        flushed ? 1 : 0, closed ? 1 : 0);
}

static void probe_unmodeled_metadata(const char *dir) {
  char root[PATH_MAX];
  char path[PATH_MAX];
  if (snprintf(root, sizeof(root), "%s", dir) < 0 || join_path(path, sizeof(path), dir, "invalid-xattr.txt") != 0) return;
  char *slash = strrchr(root, '/');
  if (slash == NULL || slash == root) return;
  *slash = '\0';
  errno = 0;
  bool chmod_denied = chmod(root, 0700) < 0 && errno == EOPNOTSUPP;
  errno = 0;
  bool root_xattr_denied = setxattr(root, "user.kinu.root", "x", 1, 0) < 0 && errno == EOPNOTSUPP;
  bool created = write_file(path, "x", 1, 0644) == 1;
  static const char invalid_name[] = {'u', 's', 'e', 'r', '.', (char)0xff, '\0'};
  errno = 0;
  bool invalid_name_denied = setxattr(path, invalid_name, "x", 1, 0) < 0 && errno == EILSEQ;
  check("unmodeled-metadata", chmod_denied && root_xattr_denied && created && invalid_name_denied,
        "chmod=%d rootXattr=%d created=%d invalidName=%d", chmod_denied, root_xattr_denied, created, invalid_name_denied);
}
static int mode_posix(const char *dir) {

  if (mkdir(dir, 0755) != 0 && errno != EEXIST) {
    check("posix-root", false, "mkdir failed errno=%d", errno);
    return summary("posix");
  }
  probe_create_read(dir);
  probe_partial_write(dir);
  probe_error_writes(dir);
  probe_rename_flags(dir);
  probe_unlink_open(dir);
  probe_hardlink(dir);
  probe_sparse(dir);
  probe_symlink(dir);
  probe_dirs(dir);
  probe_readdir_batches(dir);
  probe_mknod(dir);
  probe_metadata(dir);
  probe_xattr(dir);
  probe_statfs(dir);
  probe_unmodeled_metadata(dir);
  probe_tab_name(dir);
  probe_fsync_flush(dir);
  probe_sealed_inputs(dir);
  return summary("posix");
}

/* ------------------------------------------------------------ stage ------ */

/* Inspects a sealed stage directly: the copy must keep hardlink identity,
 * modes, extended attributes and holes, and must never have followed a symlink
 * that points outside the backing tree. */
static int mode_stage(const char *root) {
  char first[PATH_MAX];
  char second[PATH_MAX];
  char metadata[PATH_MAX];
  char attributed[PATH_MAX];
  char sparse[PATH_MAX];
  char outside[PATH_MAX];
  if (join_path(first, sizeof(first), root, "posix/link-first") != 0 ||
      join_path(second, sizeof(second), root, "posix/link-second") != 0 ||
      join_path(metadata, sizeof(metadata), root, "posix/metadata.txt") != 0 ||
      join_path(attributed, sizeof(attributed), root, "posix/sealed-xattr.txt") != 0 ||
      join_path(sparse, sizeof(sparse), root, "posix/sparse-keep.bin") != 0 ||
      join_path(outside, sizeof(outside), root, "posix/outside-link") != 0) {
    check("stage-paths", false, "paths too long");
    return summary("stage");
  }
  struct stat a;
  struct stat b;
  bool linked = stat(first, &a) == 0 && stat(second, &b) == 0 && a.st_ino == b.st_ino && a.st_nlink == 2;
  check("stage-hardlink", linked, "ino=%llu/%llu links=%lu", (unsigned long long)a.st_ino,
        (unsigned long long)b.st_ino, (unsigned long)a.st_nlink);

  struct stat st;
  bool moded = stat(metadata, &st) == 0 && (st.st_mode & 07777) == 0640;
  check("stage-mode", moded, "mode=%o", (unsigned)(st.st_mode & 07777));

  char value[32] = {0};
  ssize_t got = getxattr(attributed, "user.kinu.seal", value, sizeof(value));
  check("stage-xattr", got == 6 && strcmp(value, "sealed") == 0, "got=%zd value=%s", got, value);

  int fd = open(sparse, O_RDONLY);
  unsigned extents = fd < 0 ? 0 : count_extents(fd, 4 * 1024 * 1024);
  bool holey = fd >= 0 && fstat(fd, &st) == 0 && st.st_size == 4 * 1024 * 1024 &&
               (off_t)st.st_blocks * 512 < 1024 * 1024 && extents == 2;
  if (fd >= 0) close(fd);
  check("stage-sparse", holey, "extents=%u blocks=%lld size=%lld", extents, (long long)st.st_blocks,
        (long long)st.st_size);

  char target[PATH_MAX] = {0};
  ssize_t length = readlink(outside, target, sizeof(target) - 1);
  bool unfollowed = lstat(outside, &st) == 0 && S_ISLNK(st.st_mode) && length == 4 && strcmp(target, "/etc") == 0;
  check("stage-symlink-unfollowed", unfollowed, "target=%s isLink=%d", target, S_ISLNK(st.st_mode) ? 1 : 0);
  return summary("stage");
}

/* -------------------------------------------------------- truncation ----- */

/* O_TRUNC on an open of an existing file: the only mutation a filesystem can
 * perform inside an open, and one the journal must still name. */
static int mode_truncate_open(const char *path) {
  bool seeded = write_file(path, "0123456789", 10, 0644) == 10;
  int fd = open(path, O_WRONLY | O_TRUNC);
  struct stat st;
  bool emptied = fd >= 0 && fstat(fd, &st) == 0 && st.st_size == 0;
  bool wrote = fd >= 0 && pwrite(fd, "kept", 4, 0) == 4;
  if (fd >= 0) close(fd);
  char back[16] = {0};
  ssize_t got = read_file(path, back, sizeof(back) - 1);
  check("truncate-on-open", seeded && emptied && wrote && got == 4 && strcmp(back, "kept") == 0,
        "seeded=%d emptied=%d wrote=%d read=%zd content=%s", seeded ? 1 : 0, emptied ? 1 : 0, wrote ? 1 : 0, got,
        back);
  return summary("truncate-open");
}

/* ----------------------------------------------------------- escape ------ */

/* A pinned directory handle lets the kernel look a child up without walking its
 * ancestors again, so the daemon receives a multi component path whose parent
 * has been swapped for a symlink out of band.  RESOLVE_BENEATH must refuse it. */
static int mode_escape(const char *mount, const char *backing) {
  char mounted_dir[PATH_MAX];
  char mounted_child[PATH_MAX];
  char backing_dir[PATH_MAX];
  char backing_child[PATH_MAX];
  if (join_path(mounted_dir, sizeof(mounted_dir), mount, "swapdir") != 0 ||
      join_path(mounted_child, sizeof(mounted_child), mounted_dir, "inside.txt") != 0 ||
      join_path(backing_dir, sizeof(backing_dir), backing, "swapdir") != 0 ||
      join_path(backing_child, sizeof(backing_child), backing_dir, "inside.txt") != 0) {
    check("escape-setup", false, "paths too long");
    return summary("escape");
  }
  if (mkdir(mounted_dir, 0755) != 0 && errno != EEXIST) {
    check("escape-setup", false, "mkdir failed errno=%d", errno);
    return summary("escape");
  }
  write_file(mounted_child, "inside", 6, 0644);
  write_file("/etc/kinu-bait.txt", "leaked", 6, 0644);

  int pinned = open(mounted_dir, O_RDONLY | O_DIRECTORY);
  if (pinned < 0) {
    check("escape-setup", false, "pin failed errno=%d", errno);
    return summary("escape");
  }
  int before = openat(pinned, "inside.txt", O_RDONLY);
  char text[16] = {0};
  bool readable = before >= 0 && pread(before, text, sizeof(text) - 1, 0) == 6 && strcmp(text, "inside") == 0;
  if (before >= 0) close(before);
  check("escape-baseline", readable, "content=%s", text);

  bool swapped = unlink(backing_child) == 0 && rmdir(backing_dir) == 0 && symlink("/etc", backing_dir) == 0;
  check("escape-swap", swapped, "swapped=%d errno=%d", swapped ? 1 : 0, errno);

  int leaked = openat(pinned, "kinu-bait.txt", O_RDONLY);
  int leaked_errno = errno;
  char stolen[16] = {0};
  ssize_t stolen_size = leaked >= 0 ? pread(leaked, stolen, sizeof(stolen) - 1, 0) : -1;
  if (leaked >= 0) close(leaked);
  check("escape-refused", leaked < 0 && strcmp(stolen, "leaked") != 0, "rc=%d errno=%d size=%zd", leaked,
        leaked_errno, stolen_size);

  struct stat st;
  int stated = fstatat(pinned, "kinu-bait.txt", &st, 0);
  int stated_errno = errno;
  check("escape-stat-refused", stated != 0, "rc=%d errno=%d", stated, stated_errno);
  close(pinned);

  /* Restore the backing tree so a later fence sees no dangling escape. */
  unlink(backing_dir);
  return summary("escape");
}

/* ------------------------------------------------------------- mmap ------ */

static int mode_mmap(const char *path, long pages, const char *stop_path) {
  size_t size = (size_t)pages * PAGE;
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    check("mmap-open", false, "errno=%d", errno);
    return summary("mmap");
  }
  if (ftruncate(fd, (off_t)size) != 0) {
    check("mmap-size", false, "errno=%d", errno);
    close(fd);
    return summary("mmap");
  }
  unsigned char *mapped = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (mapped == MAP_FAILED) {
    check("mmap-shared", false, "errno=%d", errno);
    close(fd);
    return summary("mmap");
  }
  check("mmap-shared", true, "pages=%ld", pages);

  unsigned long rounds = 0;
  unsigned long failures = 0;
  unsigned round_seed = 0;
  while (access(stop_path, F_OK) != 0) {
    round_seed = (unsigned)(rounds & 0xff) + 1;
    for (size_t offset = 0; offset < size; offset += PAGE) fill_pattern(mapped + offset, PAGE, round_seed);
    if (msync(mapped, size, MS_SYNC) != 0) failures++;
    rounds++;
    printf("{\"event\":\"round\",\"round\":%lu,\"ms\":%lld,\"failures\":%lu}\n", rounds, now_ms(), failures);
    fflush(stdout);
    usleep(20000);
  }
  bool mapping_consistent = true;
  for (size_t offset = 0; mapping_consistent && offset < size; offset += PAGE) {
    mapping_consistent = pattern_matches(mapped + offset, PAGE, round_seed);
  }
  bool synced = msync(mapped, size, MS_SYNC) == 0;
  bool unmapped = munmap(mapped, size) == 0;

  unsigned char *page = malloc(PAGE);
  bool durable = page != NULL;
  for (size_t offset = 0; durable && offset < size; offset += PAGE) {
    durable = pread(fd, page, PAGE, (off_t)offset) == PAGE && pattern_matches(page, PAGE, round_seed);
  }
  free(page);
  close(fd);
  check("mmap-continuous", rounds >= 2 && failures == 0, "rounds=%lu failures=%lu", rounds, failures);
  check("mmap-mapping-consistent", mapping_consistent && synced && unmapped, "consistent=%d synced=%d unmapped=%d",
        mapping_consistent ? 1 : 0, synced ? 1 : 0, unmapped ? 1 : 0);
  check("mmap-readback", durable, "seed=%u", round_seed);
  return summary("mmap");
}

/* ---------------------------------------------------------- writers ------ */

static int mode_fork(const char *dir, long children, long writes) {
  if (mkdir(dir, 0755) != 0 && errno != EEXIST) {
    check("fork-root", false, "mkdir errno=%d", errno);
    return summary("fork");
  }
  pid_t *pids = calloc((size_t)children, sizeof(*pids));
  if (pids == NULL) {
    check("fork-alloc", false, "out of memory");
    return summary("fork");
  }
  for (long child = 0; child < children; child++) {
    pid_t pid = fork();
    if (pid == 0) {
      char path[PATH_MAX];
      snprintf(path, sizeof(path), "%s/child-%ld.bin", dir, child);
      int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
      if (fd < 0) _exit(1);
      unsigned char block[PAGE];
      fill_pattern(block, sizeof(block), (unsigned)child + 1);
      for (long index = 0; index < writes; index++) {
        if (pwrite(fd, block, sizeof(block), (off_t)index * PAGE) != (ssize_t)sizeof(block)) _exit(2);
      }
      if (fsync(fd) != 0) _exit(3);
      if (close(fd) != 0) _exit(4);
      _exit(0);
    }
    if (pid < 0) {
      check("fork-spawn", false, "errno=%d", errno);
      free(pids);
      return summary("fork");
    }
    pids[child] = pid;
  }
  unsigned failed = 0;
  for (long child = 0; child < children; child++) {
    int status = 0;
    if (waitpid(pids[child], &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) failed++;
  }
  free(pids);
  check("fork-writers", failed == 0, "children=%ld writes=%ld failed=%u", children, writes, failed);

  unsigned corrupted = 0;
  unsigned char *block = malloc(PAGE);
  for (long child = 0; child < children && block != NULL; child++) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/child-%ld.bin", dir, child);
    struct stat st;
    if (stat(path, &st) != 0 || st.st_size != (off_t)writes * PAGE) {
      corrupted++;
      continue;
    }
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
      corrupted++;
      continue;
    }
    for (long index = 0; index < writes; index++) {
      if (pread(fd, block, PAGE, (off_t)index * PAGE) != PAGE || !pattern_matches(block, PAGE, (unsigned)child + 1)) {
        corrupted++;
        break;
      }
    }
    close(fd);
  }
  free(block);
  check("fork-content", corrupted == 0, "corrupted=%u", corrupted);
  return summary("fork");
}

struct thread_task {
  const char *dir;
  long index;
  long writes;
  int status;
};

static void *thread_writer(void *raw) {
  struct thread_task *task = raw;
  char path[PATH_MAX];
  snprintf(path, sizeof(path), "%s/thread-%ld.bin", task->dir, task->index);
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    task->status = 1;
    return NULL;
  }
  unsigned char block[512];
  fill_pattern(block, sizeof(block), (unsigned)task->index + 41);
  for (long write_index = 0; write_index < task->writes; write_index++) {
    if (pwrite(fd, block, sizeof(block), write_index * (off_t)sizeof(block)) != (ssize_t)sizeof(block)) {
      task->status = 2;
      close(fd);
      return NULL;
    }
  }
  task->status = close(fd) == 0 ? 0 : 3;
  return NULL;
}

static int mode_threads(const char *dir, long threads, long writes) {
  if (mkdir(dir, 0755) != 0 && errno != EEXIST) {
    check("threads-root", false, "mkdir errno=%d", errno);
    return summary("threads");
  }
  pthread_t *workers = calloc((size_t)threads, sizeof(*workers));
  struct thread_task *tasks = calloc((size_t)threads, sizeof(*tasks));
  if (workers == NULL || tasks == NULL) {
    check("threads-alloc", false, "out of memory");
    free(workers);
    free(tasks);
    return summary("threads");
  }
  long long started = now_ms();
  for (long index = 0; index < threads; index++) {
    tasks[index].dir = dir;
    tasks[index].index = index;
    tasks[index].writes = writes;
    if (pthread_create(&workers[index], NULL, thread_writer, &tasks[index]) != 0) tasks[index].status = 4;
  }
  unsigned failed = 0;
  for (long index = 0; index < threads; index++) {
    pthread_join(workers[index], NULL);
    if (tasks[index].status != 0) failed++;
  }
  long long elapsed = now_ms() - started;
  free(workers);
  free(tasks);
  check("concurrent-writers", failed == 0, "threads=%ld writes=%ld failed=%u ms=%lld", threads, writes, failed,
        elapsed);
  return summary("threads");
}

static int mode_load(const char *dir, long threads, long seconds) {
  if (mkdir(dir, 0755) != 0 && errno != EEXIST) return 1;
  long long deadline = now_ms() + seconds * 1000;
  pthread_t *workers = calloc((size_t)threads, sizeof(*workers));
  struct thread_task *tasks = calloc((size_t)threads, sizeof(*tasks));
  if (workers == NULL || tasks == NULL) {
    free(workers);
    free(tasks);
    return 1;
  }
  printf("{\"event\":\"load\",\"threads\":%ld}\n", threads);
  fflush(stdout);
  for (long index = 0; index < threads; index++) {
    tasks[index].dir = dir;
    tasks[index].index = index;
    tasks[index].writes = 1000000;
    pthread_create(&workers[index], NULL, thread_writer, &tasks[index]);
  }
  while (now_ms() < deadline) usleep(50000);
  /* The harness kills this process; the writers never stop on their own. */
  free(workers);
  free(tasks);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s MODE ARGS...\n", argv[0]);
    return 64;
  }
  const char *mode = argv[1];
  if (strcmp(mode, "posix") == 0) return mode_posix(argv[2]);
  if (strcmp(mode, "stage") == 0) return mode_stage(argv[2]);
  if (strcmp(mode, "truncate-open") == 0) return mode_truncate_open(argv[2]);
  if (strcmp(mode, "escape") == 0 && argc == 4) return mode_escape(argv[2], argv[3]);
  if (strcmp(mode, "mmap") == 0 && argc == 5) return mode_mmap(argv[2], strtol(argv[3], NULL, 10), argv[4]);
  if (strcmp(mode, "fork") == 0 && argc == 5) {
    return mode_fork(argv[2], strtol(argv[3], NULL, 10), strtol(argv[4], NULL, 10));
  }
  if (strcmp(mode, "threads") == 0 && argc == 5) {
    return mode_threads(argv[2], strtol(argv[3], NULL, 10), strtol(argv[4], NULL, 10));
  }
  if (strcmp(mode, "load") == 0 && argc == 5) {
    return mode_load(argv[2], strtol(argv[3], NULL, 10), strtol(argv[4], NULL, 10));
  }
  fprintf(stderr, "unknown mode %s\n", mode);
  return 64;
}
