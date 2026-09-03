/* Journaling FUSE passthrough with an out-of-band sealing fence.
 *
 * Every backing operation is fd-relative: paths from the FUSE namespace are
 * validated, then resolved with openat2(RESOLVE_BENEATH) against a root fd that
 * is retained for the lifetime of the daemon, so a swapped symlink or a ".."
 * component can never reach outside the backing tree.
 *
 * Every write records one W record naming its inode, path, offset and length
 * BEFORE the pwrite it describes; every metadata mutation records an INTENT
 * before its effect and a RESULT before its reply.  One writer thread appends
 * all of them with write(2), and no mutation reply waits for a disk: the WAL
 * only has to survive a DAEMON death on this instance, where the written pages
 * are still in the page cache, and an instance death takes the backing root
 * and the WAL together.  A caller's own fsync still flushes the backing file
 * it named.
 *
 * A fence arrives out of band on an AF_UNIX socket.  It closes admission,
 * drains the mutations already in flight (which makes the journal complete
 * through the cut), syncs the backing filesystem, and hands the journal above
 * the previous fence to journal-delta.c, which derives the exact dirty ranges
 * and the ordered metadata operations, stages only the dirty clusters plus
 * their previous CDC-boundary context, and writes the delta manifest.  The
 * fence then records itself, compacts the journal to the published head plus
 * the unfenced tail, reopens admission, and replies with the cut, the sealed
 * generation, the manifest path and its SealWork row.
 *
 * After a successful head CAS the sidecar sends `boundaries`: the files whose
 * published chunk boundaries changed, the paths the generation dropped, and
 * the head they belong to.  That hand-back is what keeps the next fence O(k)
 * rather than O(file).
 */

#define FUSE_USE_VERSION 317
#define _GNU_SOURCE

#include <fuse3/fuse.h>
#include <fuse3/fuse_kernel.h>
#include <fuse3/fuse_lowlevel.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/openat2.h>
#include <openssl/sha.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/xattr.h>
#include <unistd.h>

#include "journal-delta.h"

#ifndef FUSE_CAP_DIRECT_IO_ALLOW_MMAP
#error "libfuse 3.17.1 with FUSE_CAP_DIRECT_IO_ALLOW_MMAP is required"
#endif
_Static_assert(FUSE_DIRECT_IO_ALLOW_MMAP == (1ULL << 36), "unexpected FUSE ABI");

#define PATH_CAP 4096
#define FIELD_CAP (2 * PATH_CAP)
#define RECORD_CAP (2 * FIELD_CAP + 256)
#define WAL_COMPACT_BYTES (128 * 1024)
/* A boundaries request carries one entry per file whose chunk boundaries moved,
 * so it is bounded by the seal and not by the tree.  The ceiling only stops a
 * runaway peer from growing this process without limit. */
#define CONTROL_REQUEST_CAP (64u * 1024u * 1024u)
#define CONTROL_TIMEOUT_SECONDS 5
#define WAL_NAME "wal.log"
#define WAL_COMPACT_NAME "wal.compact"

typedef unsigned long long counter;

enum record_kind { REC_INTENT, REC_RESULT, REC_WRITE, REC_FENCE, REC_RECOVER, REC_BASE };
static const char *const record_names[] = {"INTENT", "RESULT", "W", "FENCE", "RECOVER", "BASE"};

struct flush_request {
  char line[RECORD_CAP];
  size_t length;
  int status;
  bool done;
  pthread_cond_t done_cv;
  struct flush_request *next;
};

struct mutation {
  uint64_t sequence;
  uint64_t generation;
  bool active;
};

struct journal {
  int root_fd;
  int state_fd;
  int wal_fd;
  int socket_fd;
  int wake_fd;
  char state_path[PATH_CAP];
  char socket_path[PATH_CAP];
  struct fuse *fuse;
  uint64_t sequence;
  uint64_t generation;
  uint64_t base_cut;
  uint64_t base_generation;
  char base_root[SHA256_DIGEST_LENGTH * 2 + 1];
  uint64_t fence_cut;
  uint64_t fence_generation;
  char fence_manifest[PATH_CAP];
  counter records;
  counter batches;
  counter wal_bytes;
  counter wal_fsyncs;
  counter backing_fsyncs;
  counter writes;
  /* Reads the daemon itself served.  Counted without a lock because it is the
   * one counter on a path the daemon is trying to stay off: a re-read that the
   * page cache answers never arrives here, and that gap is the read path's
   * whole point.  Relaxed is enough — nothing orders against it. */
  _Atomic counter reads;
  unsigned active;
  bool admitted;
  bool stopping;
  bool detached;
  bool writer_stopping;
  bool mmap_negotiated;
  bool has_base;
  bool has_fence;
  /* The CDC parameter the published boundaries were cut with, and the map
   * itself.  Both are the sidecar's to set and are read under `lock`. */
  uint64_t max_chunk;
  struct journal_boundaries boundaries;
  pthread_mutex_t lock;       /* admission, sequence, generation, active, teardown */
  pthread_mutex_t queue_lock; /* record queue, counters */
  pthread_mutex_t wal_lock;   /* wal_fd identity and its appends */
  pthread_cond_t drained;
  pthread_cond_t admit;
  pthread_cond_t queue_ready;
  pthread_t control_thread;
  pthread_t writer_thread;
  struct flush_request *queue_head;
  struct flush_request *queue_tail;
};
static struct journal state;

static int neg_errno(void) { return errno == 0 ? -EIO : -errno; }

/* ---------------------------------------------------------------- paths --- */

/* FUSE paths are absolute names in the virtual namespace.  The backing store
 * only ever receives checked relative names under the retained root fd. */
static int relative_path(const char *path, char out[PATH_CAP]) {
  if (path == NULL || path[0] != '/') return -EINVAL;
  const char *cursor = path + 1;
  if (*cursor == '\0') {
    out[0] = '\0';
    return 0;
  }
  size_t used = 0;
  while (*cursor != '\0') {
    const char *start = cursor;
    while (*cursor != '\0' && *cursor != '/') cursor++;
    size_t part = (size_t)(cursor - start);
    if (part == 0 || part > NAME_MAX) return -EPERM;
    if (part == 1 && start[0] == '.') return -EPERM;
    if (part == 2 && start[0] == '.' && start[1] == '.') return -EPERM;
    if (used != 0) {
      if (used + 1 >= PATH_CAP) return -ENAMETOOLONG;
      out[used++] = '/';
    }
    if (used + part >= PATH_CAP) return -ENAMETOOLONG;
    memcpy(out + used, start, part);
    used += part;
    if (*cursor == '/') cursor++;
  }
  out[used] = '\0';
  return 0;
}

static int split_parent(const char *path, char parent[PATH_CAP], char name[NAME_MAX + 1]) {
  char rel[PATH_CAP];
  int rc = relative_path(path, rel);
  if (rc != 0) return rc;
  if (rel[0] == '\0') return -EBUSY;
  char *slash = strrchr(rel, '/');
  if (slash == NULL) {
    parent[0] = '\0';
    memcpy(name, rel, strlen(rel) + 1);
    return 0;
  }
  *slash = '\0';
  memcpy(name, slash + 1, strlen(slash + 1) + 1);
  memcpy(parent, rel, strlen(rel) + 1);
  return 0;
}

static int open_beneath(const char *rel, int flags, mode_t mode) {
  struct open_how how = {
    .flags = (uint64_t)(flags | O_CLOEXEC),
    .mode = mode,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS,
  };
  const char *name = rel[0] == '\0' ? "." : rel;
  long fd = syscall(SYS_openat2, state.root_fd, name, &how, sizeof(how));
  return fd < 0 ? neg_errno() : (int)fd;
}

/* An O_PATH handle names any node, including a symlink, without traversing it. */
static int open_node(const char *path) {
  char rel[PATH_CAP];
  int rc = relative_path(path, rel);
  return rc != 0 ? rc : open_beneath(rel, O_PATH | O_NOFOLLOW, 0);
}

static int open_parent(const char *path, char name[NAME_MAX + 1]) {
  char parent[PATH_CAP];
  int rc = split_parent(path, parent, name);
  return rc != 0 ? rc : open_beneath(parent, O_PATH | O_DIRECTORY, 0);
}

/* ------------------------------------------------------------- journal --- */

static bool escape_field(const char *in, char *out, size_t cap) {
  size_t used = 0;
  for (const char *p = in == NULL ? "" : in; *p != '\0'; p++) {
    char escape = '\0';
    if (*p == '\\') escape = '\\';
    else if (*p == '\t') escape = 't';
    else if (*p == '\n') escape = 'n';
    if (escape != '\0') {
      if (used + 2 >= cap) return false;
      out[used++] = '\\';
      out[used++] = escape;
      continue;
    }
    if (used + 1 >= cap) return false;
    out[used++] = *p;
  }
  out[used] = '\0';
  return true;
}

static int format_record(char *out, size_t cap, enum record_kind kind, uint64_t sequence, uint64_t generation,
                         const char *op, int outcome, const char *path, const char *aux) {
  char escaped_path[FIELD_CAP];
  char escaped_aux[FIELD_CAP];
  if (!escape_field(path, escaped_path, sizeof(escaped_path))) return -ENAMETOOLONG;
  if (!escape_field(aux, escaped_aux, sizeof(escaped_aux))) return -ENAMETOOLONG;
  int written = snprintf(out, cap, "%llu\t%s\t%s\t%d\t%llu\t%s\t%s\n", (counter)sequence, record_names[kind], op,
                         outcome, (counter)generation, escaped_path, escaped_aux);
  return written < 0 || (size_t)written >= cap ? -ENAMETOOLONG : written;
}

static int append_all(int fd, const char *bytes, size_t length) {
  size_t sent = 0;
  while (sent < length) {
    ssize_t n = write(fd, bytes + sent, length - sent);
    if (n < 0) {
      if (errno == EINTR) continue;
      return neg_errno();
    }
    sent += (size_t)n;
  }
  return 0;
}

/* One writer owns the journal file.  Whatever is queued while the previous
 * batch is in flight becomes the next batch and shares its one append pass. */
static void *writer_loop(void *unused) {
  (void)unused;
  for (;;) {
    pthread_mutex_lock(&state.queue_lock);
    while (state.queue_head == NULL && !state.writer_stopping) pthread_cond_wait(&state.queue_ready, &state.queue_lock);
    if (state.queue_head == NULL) {
      pthread_mutex_unlock(&state.queue_lock);
      return NULL;
    }
    struct flush_request *batch = state.queue_head;
    state.queue_head = NULL;
    state.queue_tail = NULL;
    pthread_mutex_unlock(&state.queue_lock);

    int rc = 0;
    counter written = 0;
    counter bytes = 0;
    pthread_mutex_lock(&state.wal_lock);
    for (struct flush_request *request = batch; request != NULL && rc == 0; request = request->next) {
      rc = append_all(state.wal_fd, request->line, request->length);
      if (rc == 0) {
        written++;
        bytes += request->length;
      }
    }
    /* No fdatasync here, by design: see the file header.  `walFsyncs` stays at
     * zero across every mutation, and the matrix asserts that. */
    pthread_mutex_unlock(&state.wal_lock);

    pthread_mutex_lock(&state.queue_lock);
    state.records += written;
    state.wal_bytes += bytes;
    state.batches++;
    for (struct flush_request *request = batch; request != NULL;) {
      struct flush_request *next = request->next;
      request->status = rc;
      request->done = true;
      pthread_cond_signal(&request->done_cv);
      request = next;
    }
    pthread_mutex_unlock(&state.queue_lock);
  }
}

static int durable(enum record_kind kind, uint64_t sequence, uint64_t generation, const char *op, int outcome,
                   const char *path, const char *aux) {
  struct flush_request request;
  memset(&request, 0, sizeof(request));
  int length = format_record(request.line, sizeof(request.line), kind, sequence, generation, op, outcome, path, aux);
  if (length < 0) return length;
  request.length = (size_t)length;
  pthread_cond_init(&request.done_cv, NULL);

  pthread_mutex_lock(&state.queue_lock);
  if (state.queue_tail != NULL) state.queue_tail->next = &request;
  else state.queue_head = &request;
  state.queue_tail = &request;
  pthread_cond_signal(&state.queue_ready);
  while (!request.done) pthread_cond_wait(&request.done_cv, &state.queue_lock);
  pthread_mutex_unlock(&state.queue_lock);
  pthread_cond_destroy(&request.done_cv);
  return request.status;
}

static void release_mutation(struct mutation *m) {
  pthread_mutex_lock(&state.lock);
  if (m->active) {
    state.active--;
    m->active = false;
    pthread_cond_broadcast(&state.drained);
  }
  pthread_mutex_unlock(&state.lock);
}

/* Mutations arriving while a fence holds admission closed wait for it rather
 * than failing, so a fence is invisible to a writer other than as latency. */
static int admit_mutation(struct mutation *m) {
  pthread_mutex_lock(&state.lock);
  while (!state.admitted && !state.stopping) pthread_cond_wait(&state.admit, &state.lock);
  if (state.stopping) {
    pthread_mutex_unlock(&state.lock);
    return -ESHUTDOWN;
  }
  m->sequence = ++state.sequence;
  m->generation = state.generation;
  m->active = true;
  state.active++;
  pthread_mutex_unlock(&state.lock);
  return 0;
}

static int begin_mutation(const char *op, const char *path, const char *aux, struct mutation *m) {
  int rc = admit_mutation(m);
  if (rc != 0) return rc;
  rc = durable(REC_INTENT, m->sequence, m->generation, op, 0, path, aux);
  if (rc != 0) release_mutation(m);
  return rc;
}

/* One W record per write, appended BEFORE the pwrite it describes.  A journal
 * that cannot take the record — a full state filesystem is the case that
 * matters — refuses the write without touching a byte of the tree, so a
 * restart's dirty set covers every write that returned. */
static int begin_write(uint64_t ino, const char *path, off_t offset, size_t size, struct mutation *m) {
  char aux[96];
  int formatted = journal_write_record(aux, sizeof(aux), ino, (uint64_t)offset, (uint64_t)size);
  if (formatted < 0) return formatted;
  int rc = admit_mutation(m);
  if (rc != 0) return rc;
  rc = durable(REC_WRITE, m->sequence, m->generation, "write", 0, path, aux);
  if (rc != 0) release_mutation(m);
  return rc;
}

static int finish_mutation(struct mutation *m, const char *op, const char *path, const char *aux, int result) {
  int rc = durable(REC_RESULT, m->sequence, m->generation, op, result, path, aux);
  release_mutation(m);
  return rc == 0 ? result : rc;
}

/* ----------------------------------------------------------- callbacks --- */

struct dir_handle {
  DIR *dp;
  struct dirent *entry;
  off_t offset;
};

static void *pass_init(struct fuse_conn_info *conn, struct fuse_config *cfg) {
  cfg->use_ino = 1;
  /* The daemon is the only mutator of the backing root, so the kernel may hold
   * a name and an attribute for thirty seconds; every change that invalidates
   * one arrives through these callbacks.  Zero cost a round trip per path
   * component: `small-stat-1k` measured 163.1 ms against 3.6 ms native
   * (bench/measure-first/MEASUREMENTS.md, 2026-09-02). */
  cfg->entry_timeout = 30;
  cfg->attr_timeout = 30;
  cfg->negative_timeout = 30;
  /* The high level API owns conn->want; libfuse refuses a session that mixes it
   * with the extended field. */
  bool negotiated = (conn->capable & FUSE_CAP_DIRECT_IO_ALLOW_MMAP) != 0;
  if (negotiated) conn->want |= FUSE_CAP_DIRECT_IO_ALLOW_MMAP;
  /* Truncation then arrives inside the open that asked for it, in one round trip
   * and on the one path the journal records. */
  if ((conn->capable & FUSE_CAP_ATOMIC_O_TRUNC) != 0) conn->want |= FUSE_CAP_ATOMIC_O_TRUNC;
  /* FUSE_CAP_PASSTHROUGH is deliberately NOT asked for, even where the kernel
   * offers it.  Passthrough is a property of the INODE and it is exclusive: the
   * kernel expects every open of an inode to be passthrough or none to be, so a
   * read-only passthrough handle makes the next open(O_RDWR) of the same file
   * fail with EIO, and a read-only open of a file another handle has mapped
   * fails the same way.  Writes have to stay intercepted to reach a W record,
   * so both handles exist on the same file and the mixture is unavoidable.
   * Read-only opens therefore keep the PAGE CACHE, which is legal in every one
   * of those mixtures, stays coherent with an intercepted write (the kernel
   * drops the cached range), and is the faster of the two anyway: 601,647 4 KiB
   * random reads/s against passthrough's 518,891 and 556,067 native
   * (bench/measure-first/MEASUREMENTS.md, 2026-09-02). */
  pthread_mutex_lock(&state.lock);
  state.mmap_negotiated = negotiated;
  pthread_mutex_unlock(&state.lock);
  if (!negotiated) {
    fprintf(stderr, "journal-daemon: kernel refuses FUSE_CAP_DIRECT_IO_ALLOW_MMAP\n");
    kill(getpid(), SIGTERM);
  }
  return NULL;
}

static int pass_getattr(const char *path, struct stat *st, struct fuse_file_info *fi) {
  if (fi != NULL) return fstat((int)fi->fh, st) == 0 ? 0 : neg_errno();
  int fd = open_node(path);
  if (fd < 0) return fd;
  int rc = fstat(fd, st) == 0 ? 0 : neg_errno();
  close(fd);
  return rc;
}

static int pass_access(const char *path, int mask) {
  int fd = open_node(path);
  if (fd < 0) return fd;
  long rc = syscall(SYS_faccessat2, fd, "", mask, AT_EACCESS | AT_EMPTY_PATH);
  int out = rc == 0 ? 0 : neg_errno();
  close(fd);
  return out;
}

/* The backing tree is one filesystem, so its statistics come from the root fd
 * once the named node is proven to resolve beneath it. */
static int pass_statfs(const char *path, struct statvfs *st) {
  int fd = open_node(path);
  if (fd < 0) return fd;
  close(fd);
  return fstatvfs(state.root_fd, st) == 0 ? 0 : neg_errno();
}

static int pass_readlink(const char *path, char *buffer, size_t size) {
  if (size == 0) return -EINVAL;
  int fd = open_node(path);
  if (fd < 0) return fd;
  ssize_t length = readlinkat(fd, "", buffer, size - 1);
  int rc = length < 0 ? neg_errno() : 0;
  if (length >= 0) buffer[length] = '\0';
  close(fd);
  return rc;
}

static int pass_opendir(const char *path, struct fuse_file_info *fi) {
  char rel[PATH_CAP];
  int rc = relative_path(path, rel);
  if (rc != 0) return rc;
  int fd = open_beneath(rel, O_RDONLY | O_DIRECTORY, 0);
  if (fd < 0) return fd;
  struct dir_handle *dir = calloc(1, sizeof(*dir));
  if (dir == NULL) {
    close(fd);
    return -ENOMEM;
  }
  dir->dp = fdopendir(fd);
  if (dir->dp == NULL) {
    rc = neg_errno();
    close(fd);
    free(dir);
    return rc;
  }
  fi->fh = (uint64_t)(uintptr_t)dir;
  return 0;
}

static int pass_readdir(const char *path, void *buffer, fuse_fill_dir_t fill, off_t offset, struct fuse_file_info *fi,
                        enum fuse_readdir_flags flags) {
  (void)path;
  struct dir_handle *dir = (struct dir_handle *)(uintptr_t)fi->fh;
  if (offset != dir->offset) {
    seekdir(dir->dp, offset);
    dir->entry = NULL;
    dir->offset = offset;
  }
  for (;;) {
    if (dir->entry == NULL) {
      errno = 0;
      dir->entry = readdir(dir->dp);
      if (dir->entry == NULL) return errno == 0 ? 0 : neg_errno();
    }
    struct stat st;
    enum fuse_fill_dir_flags fill_flags = FUSE_FILL_DIR_DEFAULTS;
    if ((flags & FUSE_READDIR_PLUS) != 0 &&
        fstatat(dirfd(dir->dp), dir->entry->d_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
      fill_flags = FUSE_FILL_DIR_PLUS;
    } else {
      memset(&st, 0, sizeof(st));
      st.st_ino = dir->entry->d_ino;
      st.st_mode = (mode_t)(dir->entry->d_type << 12);
    }
    off_t next = telldir(dir->dp);
    if (fill(buffer, dir->entry->d_name, &st, next, fill_flags) != 0) return 0;
    dir->entry = NULL;
    dir->offset = next;
  }
}

static int pass_releasedir(const char *path, struct fuse_file_info *fi) {
  (void)path;
  struct dir_handle *dir = (struct dir_handle *)(uintptr_t)fi->fh;
  int rc = closedir(dir->dp) == 0 ? 0 : neg_errno();
  free(dir);
  return rc;
}

static int pass_fsyncdir(const char *path, int datasync, struct fuse_file_info *fi) {
  struct dir_handle *dir = (struct dir_handle *)(uintptr_t)fi->fh;
  const char *op = datasync ? "fdatasyncdir" : "fsyncdir";
  struct mutation m;
  int rc = begin_mutation(op, path, "", &m);
  if (rc != 0) return rc;
  int fd = dirfd(dir->dp);
  int result = (datasync ? fdatasync(fd) : fsync(fd)) == 0 ? 0 : neg_errno();
  return finish_mutation(&m, op, path, "", result);
}

/* O_DIRECT alignment on the backing file is the daemon's concern, never the
 * caller's, so it is dropped while every other open flag is honoured. */
static int open_handle(const char *path, int flags, struct fuse_file_info *fi) {
  char rel[PATH_CAP];
  int rc = relative_path(path, rel);
  if (rc != 0) return rc;
  int fd = open_beneath(rel, flags & ~O_DIRECT, 0);
  if (fd < 0) return fd;
  fi->fh = (uint64_t)fd;
  /* A writable handle is direct: every byte it writes has to arrive here and
   * reach a W record before it reaches the file.  A read-only handle keeps the
   * page cache, so the daemon answers the first read of a range and none of the
   * re-reads; an intercepted write drops the cached range, so the two handles
   * stay coherent. */
  bool writable = (flags & O_ACCMODE) != O_RDONLY;
  fi->direct_io = writable ? 1 : 0;
  fi->keep_cache = writable ? 0 : 1;
  return 0;
}

/* With atomic truncation negotiated, an open carries the only record of a
 * mutation, so it is journaled exactly like an explicit truncate. */
static int pass_open(const char *path, struct fuse_file_info *fi) {
  if ((fi->flags & O_TRUNC) == 0) return open_handle(path, fi->flags, fi);
  struct mutation m;
  int rc = begin_mutation("open-truncate", path, "", &m);
  if (rc != 0) return rc;
  int result = open_handle(path, fi->flags, fi);
  return finish_mutation(&m, "open-truncate", path, "", result);
}

static int pass_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
  struct mutation m;
  int rc = begin_mutation("create", path, "", &m);
  if (rc != 0) return rc;
  char name[NAME_MAX + 1];
  int parent = open_parent(path, name);
  int result = parent;
  if (parent >= 0) {
    int fd = openat(parent, name, (fi->flags & ~O_DIRECT) | O_CREAT | O_CLOEXEC, mode);
    result = fd < 0 ? neg_errno() : 0;
    if (fd >= 0) {
      fi->fh = (uint64_t)fd;
      fi->direct_io = 1;
    }
    close(parent);
  }
  return finish_mutation(&m, "create", path, "", result);
}

static int pass_release(const char *path, struct fuse_file_info *fi) {
  (void)path;
  return close((int)fi->fh) == 0 ? 0 : neg_errno();
}

/* flush reports what close(2) would report; durability is fsync's job. */
static int pass_flush(const char *path, struct fuse_file_info *fi) {
  (void)path;
  int copy = dup((int)fi->fh);
  if (copy < 0) return neg_errno();
  return close(copy) == 0 ? 0 : neg_errno();
}

static int pass_read(const char *path, char *buffer, size_t size, off_t offset, struct fuse_file_info *fi) {
  (void)path;
  atomic_fetch_add_explicit(&state.reads, 1, memory_order_relaxed);
  ssize_t n = pread((int)fi->fh, buffer, size, offset);
  return n < 0 ? neg_errno() : (int)n;
}

static int pass_write(const char *path, const char *buffer, size_t size, off_t offset, struct fuse_file_info *fi) {
  struct stat st;
  if (fstat((int)fi->fh, &st) != 0) return neg_errno();
  struct mutation m;
  int rc = begin_write((uint64_t)st.st_ino, path, offset, size, &m);
  if (rc != 0) return rc;
  ssize_t n = pwrite((int)fi->fh, buffer, size, offset);
  release_mutation(&m);
  pthread_mutex_lock(&state.queue_lock);
  state.writes++;
  pthread_mutex_unlock(&state.queue_lock);
  return n < 0 ? neg_errno() : (int)n;
}

/* A caller's fsync still flushes the file it named: that is the durability the
 * caller asked for, and it is the only sync left on a reply path. */
static int pass_fsync(const char *path, int datasync, struct fuse_file_info *fi) {
  const char *op = datasync ? "fdatasync" : "fsync";
  struct mutation m;
  int rc = begin_mutation(op, path, "", &m);
  if (rc != 0) return rc;
  int fd = (int)fi->fh;
  int result = (datasync ? fdatasync(fd) : fsync(fd)) == 0 ? 0 : neg_errno();
  pthread_mutex_lock(&state.queue_lock);
  state.backing_fsyncs++;
  pthread_mutex_unlock(&state.queue_lock);
  return finish_mutation(&m, op, path, "", result);
}

static int pass_fallocate(const char *path, int mode, off_t offset, off_t length, struct fuse_file_info *fi) {
  struct mutation m;
  int rc = begin_mutation("fallocate", path, "", &m);
  if (rc != 0) return rc;
  int result = fallocate((int)fi->fh, mode, offset, length) == 0 ? 0 : neg_errno();
  return finish_mutation(&m, "fallocate", path, "", result);
}

static off_t pass_lseek(const char *path, off_t offset, int whence, struct fuse_file_info *fi) {
  (void)path;
  off_t at = lseek((int)fi->fh, offset, whence);
  return at < 0 ? neg_errno() : at;
}

/* A metadata change either uses the caller's handle or a fresh one opened
 * beneath the root; nothing resolves a path in the backing namespace twice. */
static int handle_or_open(const char *path, struct fuse_file_info *fi, int flags) {
  if (fi != NULL) return (int)fi->fh;
  char rel[PATH_CAP];
  int rc = relative_path(path, rel);
  return rc != 0 ? rc : open_beneath(rel, flags, 0);
}

/* A metadata record carries the argument its replay needs: the delta manifest
 * describes the tree at the cut, and the operation list says how it got there. */
static int pass_truncate(const char *path, off_t size, struct fuse_file_info *fi) {
  char aux[32];
  if (snprintf(aux, sizeof(aux), "%llu", (counter)size) >= (int)sizeof(aux)) return -ENAMETOOLONG;
  struct mutation m;
  int rc = begin_mutation("truncate", path, aux, &m);
  if (rc != 0) return rc;
  int fd = handle_or_open(path, fi, O_WRONLY);
  int result = fd < 0 ? fd : (ftruncate(fd, size) == 0 ? 0 : neg_errno());
  if (fi == NULL && fd >= 0) close(fd);
  return finish_mutation(&m, "truncate", path, aux, result);
}

static int reject_root_metadata(const char *path) {
  return strcmp(path, "/") == 0 ? -EOPNOTSUPP : 0;
}

static bool valid_utf8(const char *text) {
  const unsigned char *p = (const unsigned char *)text;
  while (*p != '\0') {
    if (*p <= 0x7f) {
      p++;
      continue;
    }
    if (*p >= 0xc2 && *p <= 0xdf && p[1] >= 0x80 && p[1] <= 0xbf) {
      p += 2;
      continue;
    }
    if (*p == 0xe0 && p[1] >= 0xa0 && p[1] <= 0xbf && p[2] >= 0x80 && p[2] <= 0xbf) {
      p += 3;
      continue;
    }
    if (((*p >= 0xe1 && *p <= 0xec) || (*p >= 0xee && *p <= 0xef)) && p[1] >= 0x80 && p[1] <= 0xbf
        && p[2] >= 0x80 && p[2] <= 0xbf) {
      p += 3;
      continue;
    }
    if (*p == 0xed && p[1] >= 0x80 && p[1] <= 0x9f && p[2] >= 0x80 && p[2] <= 0xbf) {
      p += 3;
      continue;
    }
    if (*p == 0xf0 && p[1] >= 0x90 && p[1] <= 0xbf && p[2] >= 0x80 && p[2] <= 0xbf
        && p[3] >= 0x80 && p[3] <= 0xbf) {
      p += 4;
      continue;
    }
    if (*p >= 0xf1 && *p <= 0xf3 && p[1] >= 0x80 && p[1] <= 0xbf && p[2] >= 0x80 && p[2] <= 0xbf
        && p[3] >= 0x80 && p[3] <= 0xbf) {
      p += 4;
      continue;
    }
    if (*p == 0xf4 && p[1] >= 0x80 && p[1] <= 0x8f && p[2] >= 0x80 && p[2] <= 0xbf
        && p[3] >= 0x80 && p[3] <= 0xbf) {
      p += 4;
      continue;
    }
    return false;
  }
  return true;
}

static int pass_chmod(const char *path, mode_t mode, struct fuse_file_info *fi) {
  int root = reject_root_metadata(path);
  if (root != 0) return root;
  char aux[16];
  if (snprintf(aux, sizeof(aux), "%u", (unsigned)(mode & 07777)) >= (int)sizeof(aux)) return -ENAMETOOLONG;
  struct mutation m;
  int rc = begin_mutation("chmod", path, aux, &m);
  if (rc != 0) return rc;
  int fd = handle_or_open(path, fi, O_RDONLY | O_NOFOLLOW);
  int result = fd < 0 ? fd : (fchmod(fd, mode) == 0 ? 0 : neg_errno());
  if (fi == NULL && fd >= 0) close(fd);
  return finish_mutation(&m, "chmod", path, aux, result);
}

static int pass_chown(const char *path, uid_t uid, gid_t gid, struct fuse_file_info *fi) {
  int root = reject_root_metadata(path);
  if (root != 0) return root;
  char aux[32];
  if (snprintf(aux, sizeof(aux), "%u %u", (unsigned)uid, (unsigned)gid) >= (int)sizeof(aux)) return -ENAMETOOLONG;
  struct mutation m;
  int rc = begin_mutation("chown", path, aux, &m);
  if (rc != 0) return rc;
  int result;
  if (fi != NULL) {
    result = fchown((int)fi->fh, uid, gid) == 0 ? 0 : neg_errno();
  } else {
    char name[NAME_MAX + 1];
    int parent = open_parent(path, name);
    result = parent < 0 ? parent : (fchownat(parent, name, uid, gid, AT_SYMLINK_NOFOLLOW) == 0 ? 0 : neg_errno());
    if (parent >= 0) close(parent);
  }
  return finish_mutation(&m, "chown", path, aux, result);
}

static int pass_utimens(const char *path, const struct timespec tv[2], struct fuse_file_info *fi) {
  int root = reject_root_metadata(path);
  if (root != 0) return root;
  char aux[64];
  if (snprintf(aux, sizeof(aux), "%llu %llu",
               (counter)((uint64_t)tv[0].tv_sec * 1000000000ULL + (uint64_t)tv[0].tv_nsec),
               (counter)((uint64_t)tv[1].tv_sec * 1000000000ULL + (uint64_t)tv[1].tv_nsec)) >= (int)sizeof(aux)) {
    return -ENAMETOOLONG;
  }
  struct mutation m;
  int rc = begin_mutation("utimens", path, aux, &m);
  if (rc != 0) return rc;
  int result;
  if (fi != NULL) {
    result = futimens((int)fi->fh, tv) == 0 ? 0 : neg_errno();
  } else {
    char name[NAME_MAX + 1];
    int parent = open_parent(path, name);
    result = parent < 0 ? parent : (utimensat(parent, name, tv, AT_SYMLINK_NOFOLLOW) == 0 ? 0 : neg_errno());
    if (parent >= 0) close(parent);
  }
  return finish_mutation(&m, "utimens", path, aux, result);
}

static int pass_mkdir(const char *path, mode_t mode) {
  struct mutation m;
  int rc = begin_mutation("mkdir", path, "", &m);
  if (rc != 0) return rc;
  char name[NAME_MAX + 1];
  int parent = open_parent(path, name);
  int result = parent < 0 ? parent : (mkdirat(parent, name, mode) == 0 ? 0 : neg_errno());
  if (parent >= 0) close(parent);
  return finish_mutation(&m, "mkdir", path, "", result);
}

static int pass_mknod(const char *path, mode_t mode, dev_t rdev) {
  struct mutation m;
  int rc = begin_mutation("mknod", path, "", &m);
  if (rc != 0) return rc;
  char name[NAME_MAX + 1];
  int parent = open_parent(path, name);
  int result = parent;
  if (parent >= 0) {
    if (S_ISREG(mode)) {
      int fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, mode);
      result = fd < 0 ? neg_errno() : 0;
      if (fd >= 0) close(fd);
    } else {
      result = mknodat(parent, name, mode, rdev) == 0 ? 0 : neg_errno();
    }
    close(parent);
  }
  return finish_mutation(&m, "mknod", path, "", result);
}

static int remove_entry(const char *op, const char *path, int flags) {
  struct mutation m;
  int rc = begin_mutation(op, path, "", &m);
  if (rc != 0) return rc;
  char name[NAME_MAX + 1];
  int parent = open_parent(path, name);
  int result = parent < 0 ? parent : (unlinkat(parent, name, flags) == 0 ? 0 : neg_errno());
  if (parent >= 0) close(parent);
  return finish_mutation(&m, op, path, "", result);
}

static int pass_unlink(const char *path) { return remove_entry("unlink", path, 0); }
static int pass_rmdir(const char *path) { return remove_entry("rmdir", path, AT_REMOVEDIR); }

static int pass_symlink(const char *target, const char *path) {
  struct mutation m;
  int rc = begin_mutation("symlink", path, target, &m);
  if (rc != 0) return rc;
  char name[NAME_MAX + 1];
  int parent = open_parent(path, name);
  int result = parent < 0 ? parent : (symlinkat(target, parent, name) == 0 ? 0 : neg_errno());
  if (parent >= 0) close(parent);
  return finish_mutation(&m, "symlink", path, target, result);
}

static int pass_link(const char *from, const char *to) {
  struct mutation m;
  int rc = begin_mutation("link", to, from, &m);
  if (rc != 0) return rc;
  char from_name[NAME_MAX + 1];
  char to_name[NAME_MAX + 1];
  int from_parent = open_parent(from, from_name);
  int to_parent = open_parent(to, to_name);
  int result = from_parent < 0 ? from_parent : to_parent;
  if (from_parent >= 0 && to_parent >= 0) {
    result = linkat(from_parent, from_name, to_parent, to_name, 0) == 0 ? 0 : neg_errno();
  }
  if (from_parent >= 0) close(from_parent);
  if (to_parent >= 0) close(to_parent);
  return finish_mutation(&m, "link", to, from, result);
}

static int pass_rename(const char *from, const char *to, unsigned int flags) {
  struct mutation m;
  int rc = begin_mutation("rename", from, to, &m);
  if (rc != 0) return rc;
  char from_name[NAME_MAX + 1];
  char to_name[NAME_MAX + 1];
  int from_parent = open_parent(from, from_name);
  int to_parent = open_parent(to, to_name);
  int result = from_parent < 0 ? from_parent : to_parent;
  if (from_parent >= 0 && to_parent >= 0) {
    long moved = syscall(SYS_renameat2, from_parent, from_name, to_parent, to_name, flags);
    result = moved == 0 ? 0 : neg_errno();
  }
  if (from_parent >= 0) close(from_parent);
  if (to_parent >= 0) close(to_parent);
  return finish_mutation(&m, "rename", from, to, result);
}

/* Extended attributes need a readable handle: the kernel allows them only on
 * regular files and directories, so a final symlink is reported unsupported. */
static int open_xattr(const char *path) {
  char rel[PATH_CAP];
  int rc = relative_path(path, rel);
  if (rc != 0) return rc;
  int fd = open_beneath(rel, O_RDONLY | O_NOFOLLOW, 0);
  return fd == -ELOOP ? -EOPNOTSUPP : fd;
}

static int pass_setxattr(const char *path, const char *name, const char *value, size_t size, int flags) {
  int root = reject_root_metadata(path);
  if (root != 0) return root;
  if (!valid_utf8(name)) return -EILSEQ;
  struct mutation m;
  int rc = begin_mutation("setxattr", path, name, &m);
  if (rc != 0) return rc;
  int fd = open_xattr(path);
  int result = fd < 0 ? fd : (fsetxattr(fd, name, value, size, flags) == 0 ? 0 : neg_errno());
  if (fd >= 0) close(fd);
  return finish_mutation(&m, "setxattr", path, name, result);
}

static int pass_getxattr(const char *path, const char *name, char *value, size_t size) {
  if (!valid_utf8(name)) return -EILSEQ;
  int fd = open_xattr(path);
  if (fd < 0) return fd;
  ssize_t length = fgetxattr(fd, name, value, size);
  int rc = length < 0 ? neg_errno() : (int)length;
  close(fd);
  return rc;
}

static int pass_listxattr(const char *path, char *list, size_t size) {
  int fd = open_xattr(path);
  if (fd < 0) return fd;
  ssize_t length = flistxattr(fd, list, size);
  int rc = length < 0 ? neg_errno() : (int)length;
  close(fd);
  return rc;
}

static int pass_removexattr(const char *path, const char *name) {
  int root = reject_root_metadata(path);
  if (root != 0) return root;
  if (!valid_utf8(name)) return -EILSEQ;
  struct mutation m;
  int rc = begin_mutation("removexattr", path, name, &m);
  if (rc != 0) return rc;
  int fd = open_xattr(path);
  int result = fd < 0 ? fd : (fremovexattr(fd, name) == 0 ? 0 : neg_errno());
  if (fd >= 0) close(fd);
  return finish_mutation(&m, "removexattr", path, name, result);
}

static const struct fuse_operations operations = {
  .init = pass_init,
  .getattr = pass_getattr,
  .access = pass_access,
  .statfs = pass_statfs,
  .readlink = pass_readlink,
  .opendir = pass_opendir,
  .readdir = pass_readdir,
  .releasedir = pass_releasedir,
  .fsyncdir = pass_fsyncdir,
  .open = pass_open,
  .create = pass_create,
  .release = pass_release,
  .flush = pass_flush,
  .read = pass_read,
  .write = pass_write,
  .fsync = pass_fsync,
  .fallocate = pass_fallocate,
  .lseek = pass_lseek,
  .truncate = pass_truncate,
  .chmod = pass_chmod,
  .chown = pass_chown,
  .utimens = pass_utimens,
  .mkdir = pass_mkdir,
  .mknod = pass_mknod,
  .unlink = pass_unlink,
  .rmdir = pass_rmdir,
  .symlink = pass_symlink,
  .link = pass_link,
  .rename = pass_rename,
  .setxattr = pass_setxattr,
  .getxattr = pass_getxattr,
  .listxattr = pass_listxattr,
  .removexattr = pass_removexattr,
};

/* ------------------------------------------------------------- control --- */

/* Copies every record above `since` from the live journal into `fd`.  Those
 * are the mutations no fence has sealed yet and the next fence derives its
 * dirty set from them, so compaction may never drop them. */
static int copy_unfenced_tail(int fd, uint64_t since) {
  int source = openat(state.state_fd, WAL_NAME, O_RDONLY | O_CLOEXEC);
  if (source < 0) return errno == ENOENT ? 0 : neg_errno();
  FILE *journal = fdopen(source, "r");
  if (journal == NULL) {
    int rc = neg_errno();
    close(source);
    return rc;
  }
  char line[RECORD_CAP];
  char scratch[RECORD_CAP];
  int rc = 0;
  while (rc == 0 && fgets(line, sizeof(line), journal) != NULL) {
    size_t length = strlen(line);
    memcpy(scratch, line, length + 1);
    char *fields[JOURNAL_RECORD_FIELDS];
    if (journal_record_split(scratch, fields) != 0) {
      rc = -EUCLEAN;
      break;
    }
    uint64_t sequence = 0;
    if (!journal_parse_counter(fields[0], &sequence)) {
      rc = -EUCLEAN;
      break;
    }
    bool published = strcmp(fields[1], "FENCE") == 0 || strcmp(fields[1], "BASE") == 0;
    if (sequence > since && !published) rc = append_all(fd, line, length);
  }
  if (rc == 0 && ferror(journal) != 0) rc = -EIO;
  fclose(journal);
  return rc;
}

/* A compact WAL keeps every identity recovery needs — the immutable head the
 * daemon authenticated and the latest sealed watermark after it — plus the
 * unfenced tail the next fence has to see. */
static int compact_journal(void) {
  struct stat st;
  if (fstat(state.wal_fd, &st) != 0) return neg_errno();
  if (st.st_size < WAL_COMPACT_BYTES) return 0;

  bool has_base;
  uint64_t base_cut;
  uint64_t base_generation;
  char base_root[sizeof(state.base_root)];
  bool has_fence;
  uint64_t fence_cut;
  uint64_t fence_generation;
  char fence_manifest[sizeof(state.fence_manifest)];
  pthread_mutex_lock(&state.lock);
  has_base = state.has_base;
  base_cut = state.base_cut;
  base_generation = state.base_generation;
  memcpy(base_root, state.base_root, sizeof(base_root));
  has_fence = state.has_fence;
  fence_cut = state.fence_cut;
  fence_generation = state.fence_generation;
  memcpy(fence_manifest, state.fence_manifest, sizeof(fence_manifest));
  pthread_mutex_unlock(&state.lock);

  char records[2][RECORD_CAP];
  size_t count = 0;
  if (has_base) {
    int length = format_record(records[count], sizeof(records[count]), REC_BASE, base_cut, base_generation,
                               "base", 0, base_root, "");
    if (length < 0) return length;
    count++;
  }
  if (has_fence) {
    int length = format_record(records[count], sizeof(records[count]), REC_FENCE, fence_cut, fence_generation,
                               "fence", 0, "", fence_manifest);
    if (length < 0) return length;
    count++;
  }
  if (count == 0) return -EUCLEAN;

  int fd = openat(state.state_fd, WAL_COMPACT_NAME, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return neg_errno();
  int rc = 0;
  for (size_t index = 0; rc == 0 && index < count; index++) {
    rc = append_all(fd, records[index], strlen(records[index]));
  }
  if (rc == 0) rc = copy_unfenced_tail(fd, has_fence ? fence_cut : 0);
  /* The compact journal replaces the live one, so it is on the disk before the
   * rename that names it: the one sync outside a fence, and never on a reply. */
  if (rc == 0 && fsync(fd) != 0) rc = neg_errno();
  if (rc == 0) {
    pthread_mutex_lock(&state.queue_lock);
    state.wal_fsyncs++;
    pthread_mutex_unlock(&state.queue_lock);
  }
  close(fd);
  if (rc != 0) {
    unlinkat(state.state_fd, WAL_COMPACT_NAME, 0);
    return rc;
  }

  pthread_mutex_lock(&state.wal_lock);
  if (renameat(state.state_fd, WAL_COMPACT_NAME, state.state_fd, WAL_NAME) != 0) rc = neg_errno();
  if (rc == 0 && fsync(state.state_fd) != 0) rc = neg_errno();
  if (rc == 0) {
    int reopened = openat(state.state_fd, WAL_NAME, O_WRONLY | O_APPEND | O_CLOEXEC);
    if (reopened < 0) {
      rc = neg_errno();
    } else {
      close(state.wal_fd);
      state.wal_fd = reopened;
    }
  }
  pthread_mutex_unlock(&state.wal_lock);
  return rc;
}

/* The fence body.  Admission is closed, the mutations in flight have drained
 * and the backing root is synced, so the journal above the previous fence is an
 * exact account of what changed and journal-delta.c stages exactly that. */
static int run_fence(uint64_t *cut_out, uint64_t *generation_out, char manifest[PATH_CAP],
                     struct journal_seal_work *work) {
  pthread_mutex_lock(&state.lock);
  if (state.stopping) {
    pthread_mutex_unlock(&state.lock);
    return -ESHUTDOWN;
  }
  state.admitted = false;
  while (state.active != 0) pthread_cond_wait(&state.drained, &state.lock);
  uint64_t cut = state.sequence;
  uint64_t generation = state.generation;
  struct journal_delta_request delta = {
    .root_fd = state.root_fd,
    .state_fd = state.state_fd,
    .state_path = state.state_path,
    .wal_name = WAL_NAME,
    .cut = cut,
    .generation = generation,
    .since = state.has_fence ? state.fence_cut : 0,
    .max_chunk = state.max_chunk,
    .boundaries = &state.boundaries,
    .has_base = state.has_base,
    .base_cut = state.base_cut,
    .base_generation = state.base_generation,
    .base_root = state.base_root,
  };
  pthread_mutex_unlock(&state.lock);

  memset(work, 0, sizeof(*work));
  int rc = syncfs(state.root_fd) == 0 ? 0 : neg_errno();
  if (rc == 0) rc = journal_delta_stage(&delta, manifest, work);
  if (rc == 0) rc = durable(REC_FENCE, cut, generation, "fence", 0, "", manifest);
  if (rc == 0) {
    pthread_mutex_lock(&state.lock);
    state.fence_cut = cut;
    state.fence_generation = generation;
    memcpy(state.fence_manifest, manifest, sizeof(state.fence_manifest));
    state.has_fence = true;
    pthread_mutex_unlock(&state.lock);
    int compacted = compact_journal();
    if (compacted != 0) fprintf(stderr, "journal-daemon: compaction failed: %s\n", strerror(-compacted));
  }

  pthread_mutex_lock(&state.lock);
  if (rc == 0) state.generation = generation + 1;
  state.admitted = !state.stopping;
  pthread_cond_broadcast(&state.admit);
  pthread_mutex_unlock(&state.lock);

  *cut_out = cut;
  *generation_out = generation;
  return rc;
}

static bool is_root_id(const char *root) {
  if (root == NULL || strlen(root) != SHA256_DIGEST_LENGTH * 2) return false;
  for (const char *at = root; *at != '\0'; at++) {
    if (!(*at >= '0' && *at <= '9') && !(*at >= 'a' && *at <= 'f')) return false;
  }
  return true;
}

static int run_base(uint64_t cut, uint64_t generation, const char *root) {
  if (!is_root_id(root)) return -EINVAL;
  pthread_mutex_lock(&state.lock);
  if (state.stopping) {
    pthread_mutex_unlock(&state.lock);
    return -ESHUTDOWN;
  }
  state.admitted = false;
  while (state.active != 0) pthread_cond_wait(&state.drained, &state.lock);

  bool identical = state.has_base && state.base_cut == cut && state.base_generation == generation
                   && strcmp(state.base_root, root) == 0;
  if (identical) {
    state.admitted = true;
    pthread_cond_broadcast(&state.admit);
    pthread_mutex_unlock(&state.lock);
    return 0;
  }
  bool fresh = !state.has_base && !state.has_fence && state.sequence == 0 && state.generation == 1;
  bool matches_fence = state.has_fence && cut == state.fence_cut && generation == state.fence_generation;
  if (!fresh && (!matches_fence
      || (state.has_base && (cut <= state.base_cut || generation <= state.base_generation)))) {
    state.admitted = true;
    pthread_cond_broadcast(&state.admit);
    pthread_mutex_unlock(&state.lock);
    return -ERANGE;
  }
  pthread_mutex_unlock(&state.lock);

  int rc = durable(REC_BASE, cut, generation, "base", 0, root, "");
  if (rc == 0) {
    pthread_mutex_lock(&state.lock);
    state.base_cut = cut;
    state.base_generation = generation;
    memcpy(state.base_root, root, sizeof(state.base_root));
    state.has_base = true;
    if (fresh) {
      state.sequence = cut;
      state.generation = generation + 1;
    }
    pthread_mutex_unlock(&state.lock);
    int compacted = compact_journal();
    if (compacted != 0) fprintf(stderr, "journal-daemon: compaction failed: %s\n", strerror(-compacted));
  }

  pthread_mutex_lock(&state.lock);
  state.admitted = !state.stopping;
  pthread_cond_broadcast(&state.admit);
  pthread_mutex_unlock(&state.lock);
  return rc;
}

/* The sidecar's post-CAS hand-back.  It reseeds the base exactly as `base`
 * does — the head it names must be the fence this daemon sealed — and, inside
 * the same admission-closed window, merges the boundaries of the files whose
 * chunk layout the publish changed.  One request, so the map and the head it
 * belongs to can never be observed apart. */
static int run_boundaries(const char *request, size_t *merged) {
  struct journal_boundaries_update update;
  int rc = journal_boundaries_parse(request, &update);
  if (rc == 0) rc = run_base(update.cut, update.generation, update.root);
  if (rc == 0) {
    pthread_mutex_lock(&state.lock);
    rc = journal_boundaries_merge(&state.boundaries, update.files, update.count,
                                  (const char *const *)update.removed, update.removed_count);
    if (rc == 0) {
      state.max_chunk = update.max_chunk;
      *merged = update.count;
    }
    pthread_mutex_unlock(&state.lock);
  }
  journal_boundaries_update_release(&update);
  return rc;
}

/* Detaching the mount is what makes the FUSE workers return, so the thread that
 * asks for a shutdown has to do it rather than wait for main.  It happens once:
 * fuse_session_unmount frees the mountpoint it also reads, so a second caller
 * would tear the string out from under the first.  Main destroys the session
 * only after joining every thread that can reach it. */
static void detach_session(void) {
  pthread_mutex_lock(&state.lock);
  bool mine = !state.detached;
  state.detached = true;
  pthread_mutex_unlock(&state.lock);
  if (!mine) return;
  struct fuse_session *session = fuse_get_session(state.fuse);
  fuse_session_exit(session);
  fuse_session_unmount(session);
}

static void begin_shutdown(void) {
  pthread_mutex_lock(&state.lock);
  state.stopping = true;
  state.admitted = false;
  pthread_cond_broadcast(&state.admit);
  while (state.active != 0) pthread_cond_wait(&state.drained, &state.lock);
  pthread_mutex_unlock(&state.lock);
  detach_session();
}

static bool json_field(const char *request, const char *key, char *out, size_t cap) {
  char pattern[32];
  int written = snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
  if (written < 0 || (size_t)written >= sizeof(pattern)) return false;
  const char *at = strstr(request, pattern);
  if (at == NULL) return false;
  at += written;
  size_t used = 0;
  while (*at != '\0' && *at != '"') {
    if (used + 1 >= cap) return false;
    out[used++] = *at++;
  }
  out[used] = '\0';
  return *at == '"';
}

/* Reads one newline-terminated request, growing the buffer as it arrives.  A
 * `boundaries` payload is one entry per file whose chunk layout moved, so it is
 * bounded by the seal rather than by the tree. */
static char *read_request(int fd, bool *complete) {
  size_t capacity = 8192;
  size_t filled = 0;
  char *request = malloc(capacity);
  *complete = false;
  if (request == NULL) return NULL;
  for (;;) {
    if (filled + 1 == capacity) {
      if (capacity >= CONTROL_REQUEST_CAP) break;
      char *grown = realloc(request, capacity * 2);
      if (grown == NULL) {
        free(request);
        return NULL;
      }
      request = grown;
      capacity *= 2;
    }
    ssize_t n = read(fd, request + filled, capacity - 1 - filled);
    if (n <= 0) break;
    filled += (size_t)n;
    request[filled] = '\0';
    if (memchr(request, '\n', filled) != NULL) {
      *complete = true;
      break;
    }
  }
  request[filled] = '\0';
  return request;
}

/* Answers one control request and reports whether it asked the daemon to stop. */
static bool handle_control(int fd) {
  bool complete = false;
  char *request = read_request(fd, &complete);
  if (request == NULL) return false;

  char id[128] = "";
  char op[32] = "";
  char *body = NULL;
  size_t length = 0;
  FILE *out = open_memstream(&body, &length);
  if (out == NULL) {
    free(request);
    return false;
  }
  bool stop = false;

  if (!complete || !json_field(request, "id", id, sizeof(id)) || !json_field(request, "op", op, sizeof(op))) {
    fputs("{\"id\":\"\",\"ok\":false,\"error\":\"invalid request\"}\n", out);
  } else if (strcmp(op, "base") == 0) {
    char cut_text[32] = "";
    char generation_text[32] = "";
    char root[SHA256_DIGEST_LENGTH * 2 + 1] = "";
    uint64_t cut = 0;
    uint64_t generation = 0;
    int rc = (
      json_field(request, "cut", cut_text, sizeof(cut_text))
      && json_field(request, "generation", generation_text, sizeof(generation_text))
      && json_field(request, "root", root, sizeof(root))
      && journal_parse_counter(cut_text, &cut)
      && journal_parse_counter(generation_text, &generation)
    ) ? run_base(cut, generation, root) : -EINVAL;
    fputs("{\"id\":", out);
    journal_json_string(out, id);
    if (rc == 0) {
      fputs(",\"ok\":true}\n", out);
    } else {
      fputs(",\"ok\":false,\"error\":", out);
      journal_json_string(out, strerror(-rc));
      fputs("}\n", out);
    }
  } else if (strcmp(op, "boundaries") == 0) {
    size_t merged = 0;
    int rc = run_boundaries(request, &merged);
    fputs("{\"id\":", out);
    journal_json_string(out, id);
    if (rc == 0) {
      fprintf(out, ",\"ok\":true,\"boundaryFiles\":%zu}\n", merged);
    } else {
      fputs(",\"ok\":false,\"error\":", out);
      journal_json_string(out, strerror(-rc));
      fputs("}\n", out);
    }
  } else if (strcmp(op, "fence") == 0) {
    uint64_t cut = 0;
    uint64_t generation = 0;
    char manifest[PATH_CAP] = "";
    struct journal_seal_work work;
    int rc = run_fence(&cut, &generation, manifest, &work);
    fputs("{\"id\":", out);
    journal_json_string(out, id);
    if (rc == 0) {
      pthread_mutex_lock(&state.lock);
      bool has_base = state.has_base;
      uint64_t base_cut = state.base_cut;
      uint64_t base_generation = state.base_generation;
      char base_root[sizeof(state.base_root)];
      memcpy(base_root, state.base_root, sizeof(base_root));
      pthread_mutex_unlock(&state.lock);
      fprintf(out, ",\"ok\":true,\"cut\":%llu,\"generation\":%llu,\"manifestPath\":", (counter)cut,
              (counter)generation);
      journal_json_string(out, manifest);
      if (has_base) {
        fprintf(out, ",\"baseCut\":\"%llu\",\"baseGeneration\":\"%llu\",\"baseRoot\":", (counter)base_cut,
                (counter)base_generation);
        journal_json_string(out, base_root);
      }
      fprintf(out,
              ",\"sealWork\":{\"bytesStaged\":%llu,\"bytesChunked\":%llu,\"chunksHashed\":%llu,"
              "\"nodesRewritten\":%llu,\"wholeFiles\":%llu}}\n",
              (counter)work.bytes_staged, (counter)work.bytes_chunked, (counter)work.chunks_hashed,
              (counter)work.nodes_rewritten, (counter)work.whole_files);
    } else {
      fputs(",\"ok\":false,\"error\":", out);
      journal_json_string(out, strerror(-rc));
      fputs("}\n", out);
    }
  } else if (strcmp(op, "stats") == 0) {
    pthread_mutex_lock(&state.lock);
    uint64_t sequence = state.sequence;
    uint64_t generation = state.generation;
    unsigned active = state.active;
    bool admitted = state.admitted;
    bool mmap_negotiated = state.mmap_negotiated;
    size_t boundary_files = state.boundaries.count;
    pthread_mutex_unlock(&state.lock);
    pthread_mutex_lock(&state.queue_lock);
    counter records = state.records;
    counter batches = state.batches;
    counter wal_bytes = state.wal_bytes;
    counter wal_fsyncs = state.wal_fsyncs;
    counter backing_fsyncs = state.backing_fsyncs;
    counter writes = state.writes;
    pthread_mutex_unlock(&state.queue_lock);
    counter reads = atomic_load_explicit(&state.reads, memory_order_relaxed);
    struct stat st;
    long long journal_bytes = fstat(state.wal_fd, &st) == 0 ? (long long)st.st_size : -1;
    fputs("{\"id\":", out);
    journal_json_string(out, id);
    fprintf(out,
            ",\"ok\":true,\"sequence\":%llu,\"generation\":%llu,\"active\":%u,\"admitted\":%s,\"records\":%llu,"
            "\"batches\":%llu,\"journalBytes\":%lld,\"directIoAllowMmap\":%s,\"reads\":%llu,"
            "\"writes\":%llu,\"walBytes\":%llu,\"walFsyncs\":%llu,\"backingFsyncs\":%llu,"
            "\"boundaryFiles\":%zu}\n",
            (counter)sequence, (counter)generation, active, admitted ? "true" : "false", records, batches,
            journal_bytes, mmap_negotiated ? "true" : "false", reads, writes, wal_bytes,
            wal_fsyncs, backing_fsyncs, boundary_files);
  } else if (strcmp(op, "stop") == 0) {
    pthread_mutex_lock(&state.lock);
    uint64_t sequence = state.sequence;
    pthread_mutex_unlock(&state.lock);
    fputs("{\"id\":", out);
    journal_json_string(out, id);
    fprintf(out, ",\"ok\":true,\"sequence\":%llu}\n", (counter)sequence);
    stop = true;
  } else {
    fputs("{\"id\":", out);
    journal_json_string(out, id);
    fputs(",\"ok\":false,\"error\":\"unknown operation\"}\n", out);
  }
  fclose(out);
  if (body != NULL) append_all(fd, body, length);
  free(body);
  free(request);
  return stop;
}

static void *control_loop(void *unused) {
  (void)unused;
  struct pollfd waiting[2] = {
    {.fd = state.socket_fd, .events = POLLIN, .revents = 0},
    {.fd = state.wake_fd, .events = POLLIN, .revents = 0},
  };
  /* Every way out of this loop ends the daemon: a shutdown can only be asked for
   * through the control socket or a signal, and both arrive here. */
  for (;;) {
    if (poll(waiting, 2, -1) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if ((waiting[1].revents & POLLIN) != 0) {
      uint64_t drained = 0;
      ssize_t ignored = read(state.wake_fd, &drained, sizeof(drained));
      (void)ignored;
      break;
    }
    if ((waiting[0].revents & POLLIN) == 0) continue;
    int client = accept4(state.socket_fd, NULL, NULL, SOCK_CLOEXEC);
    if (client < 0) {
      if (errno == EINTR || errno == ECONNABORTED) continue;
      break;
    }
    struct timeval timeout = {.tv_sec = CONTROL_TIMEOUT_SECONDS, .tv_usec = 0};
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    bool stop = handle_control(client);
    close(client);
    if (stop) break;
  }
  begin_shutdown();
  return NULL;
}

static int start_control(void) {
  unlink(state.socket_path);
  state.socket_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (state.socket_fd < 0) return neg_errno();
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  size_t length = strlen(state.socket_path);
  if (length >= sizeof(address.sun_path)) return -ENAMETOOLONG;
  memcpy(address.sun_path, state.socket_path, length + 1);
  if (bind(state.socket_fd, (const struct sockaddr *)&address, sizeof(address)) != 0) return neg_errno();
  if (listen(state.socket_fd, 16) != 0) return neg_errno();
  return pthread_create(&state.control_thread, NULL, control_loop, NULL) == 0 ? 0 : -EIO;
}

/* ------------------------------------------------------------ recovery --- */

struct pending_intent {
  uint64_t sequence;
  uint64_t generation;
  char op[32];
  char path[PATH_CAP];
  char aux[PATH_CAP];
};
struct recovery {
  struct pending_intent *pending;
  size_t count;
  size_t capacity;
  uint64_t max_sequence;
  uint64_t published;
  uint64_t base_cut;
  uint64_t base_generation;
  char base_root[SHA256_DIGEST_LENGTH * 2 + 1];
  uint64_t fence_cut;
  uint64_t fence_generation;
  char fence_manifest[PATH_CAP];
  bool has_base;
  bool has_fence;
};

static int remember_intent(struct recovery *r, const struct pending_intent *intent) {
  if (r->count == r->capacity) {
    size_t capacity = r->capacity == 0 ? 32 : r->capacity * 2;
    struct pending_intent *grown = realloc(r->pending, capacity * sizeof(*grown));
    if (grown == NULL) return -ENOMEM;
    r->pending = grown;
    r->capacity = capacity;
  }
  r->pending[r->count++] = *intent;
  return 0;
}

static void resolve_intent(struct recovery *r, uint64_t sequence) {
  for (size_t index = r->count; index > 0; index--) {
    if (r->pending[index - 1].sequence != sequence) continue;
    memmove(r->pending + index - 1, r->pending + index, (r->count - index) * sizeof(*r->pending));
    r->count--;
    return;
  }
}

/* Concurrent operations reach the journal in completion order, so reconciliation
 * sorts what it found and records it in sequence order. */
static int compare_pending(const void *left, const void *right) {
  uint64_t a = ((const struct pending_intent *)left)->sequence;
  uint64_t b = ((const struct pending_intent *)right)->sequence;
  return a < b ? -1 : a > b ? 1 : 0;
}

static int parse_record(char *line, struct recovery *r) {
  char *fields[JOURNAL_RECORD_FIELDS];
  int split = journal_record_split(line, fields);
  if (split != 0) return split;
  uint64_t sequence = 0;
  uint64_t generation = 0;
  if (!journal_parse_counter(fields[0], &sequence) || !journal_parse_counter(fields[4], &generation)) return -EUCLEAN;
  if (sequence > r->max_sequence) r->max_sequence = sequence;

  const char *kind = fields[1];
  /* A W record carries no result, so there is nothing to reconcile: the next
   * fence re-derives the range from it and stages the bytes the disk holds. */
  if (strcmp(kind, "W") == 0) return 0;
  if (strcmp(kind, "FENCE") == 0) {
    if (strcmp(fields[2], "fence") != 0 || strcmp(fields[3], "0") != 0 || fields[5][0] != '\0'
        || fields[6][0] != '/' || strlen(fields[6]) >= sizeof(r->fence_manifest)) return -EUCLEAN;
    if (r->has_fence && (sequence < r->fence_cut || generation <= r->fence_generation)) return -EUCLEAN;
    r->fence_cut = sequence;
    r->fence_generation = generation;
    memcpy(r->fence_manifest, fields[6], strlen(fields[6]) + 1);
    r->has_fence = true;
    if (generation > r->published) r->published = generation;
    return 0;
  }
  if (strcmp(kind, "BASE") == 0) {
    if (strcmp(fields[2], "base") != 0 || strcmp(fields[3], "0") != 0 || !is_root_id(fields[5])
        || fields[6][0] != '\0') return -EUCLEAN;
    if (r->has_base) {
      bool identical = r->base_cut == sequence && r->base_generation == generation
                       && strcmp(r->base_root, fields[5]) == 0;
      if (!identical && (sequence <= r->base_cut || generation <= r->base_generation)) return -EUCLEAN;
      if (!identical && (!r->has_fence || sequence != r->fence_cut || generation != r->fence_generation)) {
        return -EUCLEAN;
      }
    }
    if (r->has_fence && (sequence != r->fence_cut || generation != r->fence_generation)) return -EUCLEAN;
    r->has_base = true;
    r->base_cut = sequence;
    r->base_generation = generation;
    memcpy(r->base_root, fields[5], sizeof(r->base_root));
    if (generation > r->published) r->published = generation;
    return 0;
  }
  if (strcmp(kind, "RESULT") == 0 || strcmp(kind, "RECOVER") == 0) {
    resolve_intent(r, sequence);
    return 0;
  }
  if (strcmp(kind, "INTENT") != 0) return -EUCLEAN;
  journal_field_unescape(fields[5]);
  journal_field_unescape(fields[6]);
  struct pending_intent intent;
  memset(&intent, 0, sizeof(intent));
  intent.sequence = sequence;
  intent.generation = generation;
  if (strlen(fields[2]) >= sizeof(intent.op)) return -EUCLEAN;
  if (strlen(fields[5]) >= sizeof(intent.path)) return -EUCLEAN;
  if (strlen(fields[6]) >= sizeof(intent.aux)) return -EUCLEAN;
  memcpy(intent.op, fields[2], strlen(fields[2]) + 1);
  memcpy(intent.path, fields[5], strlen(fields[5]) + 1);
  memcpy(intent.aux, fields[6], strlen(fields[6]) + 1);
  return remember_intent(r, &intent);
}

/* An intent whose result never became durable has an undetermined effect: the
 * completed prefix keeps its meaning only if the intent is reconciled, so the
 * restart records it as cancelled instead of replaying or inferring it. */
static int recover_journal(void) {
  int fd = openat(state.state_fd, WAL_NAME, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? 0 : neg_errno();
  FILE *journal = fdopen(fd, "r");
  if (journal == NULL) {
    int rc = neg_errno();
    close(fd);
    return rc;
  }
  struct recovery r;
  memset(&r, 0, sizeof(r));
  char line[RECORD_CAP];
  int rc = 0;
  while (rc == 0 && fgets(line, sizeof(line), journal) != NULL) rc = parse_record(line, &r);
  fclose(journal);

  if (rc == 0) {
    state.sequence = r.max_sequence;
    state.generation = r.published + 1;
    state.has_base = r.has_base;
    state.base_cut = r.base_cut;
    state.base_generation = r.base_generation;
    memcpy(state.base_root, r.base_root, sizeof(state.base_root));
    state.has_fence = r.has_fence;
    state.fence_cut = r.fence_cut;
    state.fence_generation = r.fence_generation;
    memcpy(state.fence_manifest, r.fence_manifest, sizeof(state.fence_manifest));
    if (r.count > 1) qsort(r.pending, r.count, sizeof(*r.pending), compare_pending);
    for (size_t index = 0; rc == 0 && index < r.count; index++) {
      const struct pending_intent *intent = &r.pending[index];
      rc = durable(REC_RECOVER, intent->sequence, intent->generation, intent->op, -ECANCELED, intent->path,
                   intent->aux);
    }
  }
  free(r.pending);
  return rc;
}

/* ---------------------------------------------------------------- main --- */

/* The control thread owns shutdown, so a signal only has to reach it. */
static void wake_control(void) {
  uint64_t one = 1;
  ssize_t ignored = write(state.wake_fd, &one, sizeof(one));
  (void)ignored;
}

static void wake_handler(int signal_number) {
  (void)signal_number;
  wake_control();
}

static int install_handlers(void) {
  struct sigaction wake;
  memset(&wake, 0, sizeof(wake));
  wake.sa_handler = wake_handler;
  sigemptyset(&wake.sa_mask);
  struct sigaction ignore;
  memset(&ignore, 0, sizeof(ignore));
  ignore.sa_handler = SIG_IGN;
  sigemptyset(&ignore.sa_mask);
  if (sigaction(SIGTERM, &wake, NULL) != 0) return neg_errno();
  if (sigaction(SIGINT, &wake, NULL) != 0) return neg_errno();
  if (sigaction(SIGHUP, &wake, NULL) != 0) return neg_errno();
  if (sigaction(SIGPIPE, &ignore, NULL) != 0) return neg_errno();
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 9 || strcmp(argv[1], "--root") != 0 || strcmp(argv[3], "--mount") != 0 ||
      strcmp(argv[5], "--state") != 0 || strcmp(argv[7], "--socket") != 0) {
    fprintf(stderr, "usage: %s --root ROOT --mount MOUNT --state STATE --socket SOCKET\n", argv[0]);
    return 2;
  }
  memset(&state, 0, sizeof(state));
  state.admitted = true;
  state.generation = 1;
  journal_boundaries_init(&state.boundaries);
  /* Until the sidecar publishes a generation there is nothing to resync from,
   * so the first fence stages whole files.  Every later fence uses whatever
   * `maxChunkBytes` the publish reported. */
  state.max_chunk = 64 * 1024;
  if (snprintf(state.state_path, sizeof(state.state_path), "%s", argv[6]) >= (int)sizeof(state.state_path)) return 2;
  if (snprintf(state.socket_path, sizeof(state.socket_path), "%s", argv[8]) >= (int)sizeof(state.socket_path)) return 2;

  state.root_fd = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  state.state_fd = open(argv[6], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (state.root_fd < 0 || state.state_fd < 0) {
    fprintf(stderr, "journal-daemon: cannot retain root and state directories: %s\n", strerror(errno));
    return 3;
  }
  state.wal_fd = openat(state.state_fd, WAL_NAME, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  state.wake_fd = eventfd(0, EFD_CLOEXEC);
  if (state.wal_fd < 0 || state.wake_fd < 0) {
    fprintf(stderr, "journal-daemon: cannot open the journal: %s\n", strerror(errno));
    return 3;
  }
  pthread_mutex_init(&state.lock, NULL);
  pthread_mutex_init(&state.queue_lock, NULL);
  pthread_mutex_init(&state.wal_lock, NULL);
  pthread_cond_init(&state.drained, NULL);
  pthread_cond_init(&state.admit, NULL);
  pthread_cond_init(&state.queue_ready, NULL);

  if (install_handlers() != 0) return 3;
  if (pthread_create(&state.writer_thread, NULL, writer_loop, NULL) != 0) return 3;
  int rc = recover_journal();
  if (rc != 0) {
    fprintf(stderr, "journal-daemon: journal recovery failed: %s\n", strerror(-rc));
    return 3;
  }

  struct fuse_args args = FUSE_ARGS_INIT(0, NULL);
  if (fuse_opt_add_arg(&args, argv[0]) != 0 || fuse_opt_add_arg(&args, "-o") != 0 ||
      fuse_opt_add_arg(&args, "default_permissions") != 0) {
    return 3;
  }
  state.fuse = fuse_new(&args, &operations, sizeof(operations), NULL);
  fuse_opt_free_args(&args);
  if (state.fuse == NULL) {
    fprintf(stderr, "journal-daemon: cannot create the session\n");
    return 3;
  }
  if (fuse_mount(state.fuse, argv[4]) != 0) {
    fprintf(stderr, "journal-daemon: cannot mount %s\n", argv[4]);
    fuse_destroy(state.fuse);
    return 3;
  }
  if (start_control() != 0) {
    fprintf(stderr, "journal-daemon: cannot serve the control socket\n");
    detach_session();
    fuse_destroy(state.fuse);
    return 3;
  }

  /* A loop that cannot be configured still leaves a mount and two threads, so it
   * reports a failure through the one teardown rather than returning early. */
  int status = -ENOMEM;
  struct fuse_loop_config *loop = fuse_loop_cfg_create();
  if (loop != NULL) {
    fuse_loop_cfg_set_clone_fd(loop, 1);
    fuse_loop_cfg_set_max_threads(loop, 16);
    status = fuse_loop_mt(state.fuse, loop);
    fuse_loop_cfg_destroy(loop);
  }

  /* The loop also ends on its own, so main closes admission and detaches the
   * mount for the shutdowns nobody asked for.  Destroying the session waits for
   * the control thread, the last thread besides main that can still reach it. */
  begin_shutdown();
  wake_control();
  pthread_join(state.control_thread, NULL);
  fuse_destroy(state.fuse);
  close(state.socket_fd);
  unlink(state.socket_path);

  pthread_mutex_lock(&state.queue_lock);
  state.writer_stopping = true;
  pthread_cond_signal(&state.queue_ready);
  pthread_mutex_unlock(&state.queue_lock);
  pthread_join(state.writer_thread, NULL);

  journal_boundaries_release(&state.boundaries);
  close(state.wal_fd);
  close(state.wake_fd);
  close(state.state_fd);
  close(state.root_fd);
  return status == 0 ? 0 : 1;
}
