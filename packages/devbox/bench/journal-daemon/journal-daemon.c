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

#include <fuse3/fuse_kernel.h>
#include <fuse3/fuse_lowlevel.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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
#include <time.h>
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
  struct fuse_session *session;
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
static int begin_write(uint64_t ino, uint64_t nlink, const char *path, off_t offset, size_t size,
                       struct mutation *m) {
  char aux[128];
  int formatted = journal_write_record(aux, sizeof(aux), ino, (uint64_t)offset, (uint64_t)size, nlink);
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

/* ----------------------------------------------------------- inodes ------- */

/*
 * The mount is served by the low-level API, so every operation names an
 * inode the daemon holds an O_PATH handle on, never a path it has to resolve
 * again. That is what makes an unlink an unlink: the name goes, the handle
 * stays, and a descriptor a caller still holds keeps reading, writing,
 * fstat-ing and fsync-ing the inode until it closes. The high-level API
 * could not do this: it either renamed the open file to `.fuse_hiddenNNNN`
 * (a name the journal and a fence would then see) or, with `hard_remove`,
 * answered ESTALE to fstat because the kernel sends GETATTR without a handle
 * (measured 2026-09-06, sidecar-real-daemon-run.ts).
 *
 * One node per backing inode, found by (dev, ino), so two hardlink names
 * are one node. A node remembers every name it was reached by this boot; the
 * first is its canonical name, and that is the path the journal records for
 * an operation that arrives by inode rather than by name. An operation that
 * arrives by (parent, name) is journaled under exactly that name.
 */
struct node_name {
  fuse_ino_t parent;
  char name[NAME_MAX + 1];
};

struct node {
  fuse_ino_t id;
  uint64_t generation;
  int fd; /* O_PATH */
  dev_t dev;
  ino_t ino;
  uint64_t nlookup;
  /* Children that name this node as a parent keep it resident. */
  uint64_t children;
  struct node_name *names;
  size_t name_count;
  size_t name_capacity;
  struct node *hash_next;
  bool live;
};

#define NODE_HASH 4096
/* The daemon is the only mutator of the backing root, so the kernel may hold
 * a name and an attribute for thirty seconds; every change that invalidates
 * one arrives through these callbacks.  Zero cost a round trip per path
 * component: `small-stat-1k` measured 163.1 ms against 3.6 ms native
 * (bench/measure-first/MEASUREMENTS.md, 2026-09-02). */
#define ATTR_TIMEOUT_SECONDS 30.0

static struct {
  struct node **table; /* by id; 0 unused, 1 the root */
  size_t count;
  size_t capacity;
  fuse_ino_t *free_ids;
  size_t free_count;
  size_t free_capacity;
  uint64_t generation;
  struct node *hash[NODE_HASH];
  pthread_mutex_t lock;
} nodes;

static size_t node_slot(dev_t dev, ino_t ino) {
  return (size_t)(((uint64_t)ino * 0x9e3779b97f4a7c15ULL) ^ (uint64_t)dev) % NODE_HASH;
}

/* Under `nodes.lock`. */
static struct node *node_by_id(fuse_ino_t id) {
  if (id == 0 || id >= nodes.count) return NULL;
  struct node *node = nodes.table[id];
  return node != NULL && node->live ? node : NULL;
}

/* Under `nodes.lock`. */
static struct node *node_by_identity(dev_t dev, ino_t ino) {
  for (struct node *node = nodes.hash[node_slot(dev, ino)]; node != NULL; node = node->hash_next) {
    if (node->live && node->dev == dev && node->ino == ino) return node;
  }
  return NULL;
}

/* Under `nodes.lock`. Takes ownership of `fd`. */
static struct node *node_insert(int fd, const struct stat *st) {
  struct node *node = calloc(1, sizeof(*node));
  if (node == NULL) return NULL;
  fuse_ino_t id;
  if (nodes.free_count > 0) {
    id = nodes.free_ids[--nodes.free_count];
  } else {
    if (nodes.count == nodes.capacity) {
      size_t capacity = nodes.capacity == 0 ? 1024 : nodes.capacity * 2;
      struct node **grown = realloc(nodes.table, capacity * sizeof(*grown));
      if (grown == NULL) {
        free(node);
        return NULL;
      }
      nodes.table = grown;
      nodes.capacity = capacity;
    }
    if (nodes.count == 0) nodes.count = 1; /* id 0 is never a node */
    id = nodes.count++;
  }
  node->id = id;
  node->generation = ++nodes.generation;
  node->fd = fd;
  node->dev = st->st_dev;
  node->ino = st->st_ino;
  node->live = true;
  size_t slot = node_slot(st->st_dev, st->st_ino);
  node->hash_next = nodes.hash[slot];
  nodes.hash[slot] = node;
  nodes.table[id] = node;
  return node;
}

/* Under `nodes.lock`. */
static void node_unhash(struct node *node) {
  size_t slot = node_slot(node->dev, node->ino);
  struct node **cursor = &nodes.hash[slot];
  while (*cursor != NULL) {
    if (*cursor == node) {
      *cursor = node->hash_next;
      return;
    }
    cursor = &(*cursor)->hash_next;
  }
}

/* Under `nodes.lock`. The kernel forgot the node and no child names it. */
static void node_free(struct node *node) {
  node_unhash(node);
  nodes.table[node->id] = NULL;
  node->live = false;
  if (nodes.free_count == nodes.free_capacity) {
    size_t capacity = nodes.free_capacity == 0 ? 256 : nodes.free_capacity * 2;
    fuse_ino_t *grown = realloc(nodes.free_ids, capacity * sizeof(*grown));
    if (grown != NULL) {
      nodes.free_ids = grown;
      nodes.free_capacity = capacity;
    }
  }
  if (nodes.free_count < nodes.free_capacity) nodes.free_ids[nodes.free_count++] = node->id;
  for (size_t index = 0; index < node->name_count; index++) {
    struct node *parent = node_by_id(node->names[index].parent);
    if (parent != NULL && parent->children > 0 && --parent->children == 0 && parent->nlookup == 0
        && parent->id != FUSE_ROOT_ID) {
      node_free(parent);
    }
  }
  free(node->names);
  close(node->fd);
  free(node);
}

/* Under `nodes.lock`. Remember one name a node was reached by. */
static int node_add_name(struct node *node, fuse_ino_t parent, const char *name) {
  for (size_t index = 0; index < node->name_count; index++) {
    if (node->names[index].parent == parent && strcmp(node->names[index].name, name) == 0) return 0;
  }
  if (node->name_count == node->name_capacity) {
    size_t capacity = node->name_capacity == 0 ? 1 : node->name_capacity * 2;
    struct node_name *grown = realloc(node->names, capacity * sizeof(*grown));
    if (grown == NULL) return -ENOMEM;
    node->names = grown;
    node->name_capacity = capacity;
  }
  struct node_name *entry = &node->names[node->name_count++];
  entry->parent = parent;
  memcpy(entry->name, name, strlen(name) + 1);
  struct node *above = node_by_id(parent);
  if (above != NULL) above->children++;
  return 0;
}

/* Under `nodes.lock`. A name is gone: an unlink, or the source of a rename. */
static void node_drop_name(struct node *node, fuse_ino_t parent, const char *name) {
  for (size_t index = 0; index < node->name_count; index++) {
    if (node->names[index].parent != parent || strcmp(node->names[index].name, name) != 0) continue;
    memmove(node->names + index, node->names + index + 1, (node->name_count - index - 1) * sizeof(*node->names));
    node->name_count--;
    struct node *above = node_by_id(parent);
    if (above != NULL && above->children > 0) above->children--;
    return;
  }
}

/* Under `nodes.lock`. The absolute FUSE path of a node by its canonical
 * name, the spelling every journal record carries. A node with no name left
 * (its last name was unlinked while a handle stayed open) has no path, and
 * an operation on it is journaled as nothing: no name at the cut can carry
 * the change. */
static int node_path(const struct node *node, char out[PATH_CAP]) {
  if (node->id == FUSE_ROOT_ID) {
    out[0] = '/';
    out[1] = '\0';
    return 0;
  }
  if (node->name_count == 0) return -ENOENT;
  char parent_path[PATH_CAP];
  struct node *parent = node_by_id(node->names[0].parent);
  if (parent == NULL) return -ESTALE;
  int rc = node_path(parent, parent_path);
  if (rc != 0) return rc;
  int written = parent->id == FUSE_ROOT_ID
    ? snprintf(out, PATH_CAP, "/%s", node->names[0].name)
    : snprintf(out, PATH_CAP, "%s/%s", parent_path, node->names[0].name);
  return written < 0 || written >= PATH_CAP ? -ENAMETOOLONG : 0;
}

/* The canonical path of an inode, or -ENOENT for a nameless one. */
static int path_of_inode(fuse_ino_t id, char out[PATH_CAP]) {
  pthread_mutex_lock(&nodes.lock);
  struct node *node = node_by_id(id);
  int rc = node == NULL ? -ESTALE : node_path(node, out);
  pthread_mutex_unlock(&nodes.lock);
  return rc;
}

/* The path of a name under a parent: what a caller spelled. */
static int path_of_name(fuse_ino_t parent, const char *name, char out[PATH_CAP]) {
  char parent_path[PATH_CAP];
  int rc = path_of_inode(parent, parent_path);
  if (rc != 0) return rc;
  int written = parent == FUSE_ROOT_ID
    ? snprintf(out, PATH_CAP, "/%s", name)
    : snprintf(out, PATH_CAP, "%s/%s", parent_path, name);
  return written < 0 || written >= PATH_CAP ? -ENAMETOOLONG : 0;
}

/* The O_PATH handle of an inode, or -1. The handle lives as long as the
 * node, which the kernel's lookup count and the node's children keep. */
static int fd_of(fuse_ino_t id) {
  pthread_mutex_lock(&nodes.lock);
  struct node *node = node_by_id(id);
  int fd = node == NULL ? -1 : node->fd;
  pthread_mutex_unlock(&nodes.lock);
  return fd;
}

static bool acceptable_name(const char *name) {
  if (name[0] == '\0' || strchr(name, '/') != NULL) return false;
  if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) return false;
  return strlen(name) <= NAME_MAX;
}

/* Resolve one name under a parent into a node, counting the kernel's lookup.
 * A backing entry that is already a node gets one more name and one more
 * lookup; a new one gets a node of its own. */
static int lookup_node(fuse_ino_t parent, const char *name, struct fuse_entry_param *entry) {
  if (!acceptable_name(name)) return -EPERM;
  int parent_fd = fd_of(parent);
  if (parent_fd < 0) return -ESTALE;
  int fd = openat(parent_fd, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return neg_errno();
  struct stat st;
  if (fstatat(fd, "", &st, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) != 0) {
    int rc = neg_errno();
    close(fd);
    return rc;
  }
  pthread_mutex_lock(&nodes.lock);
  struct node *node = node_by_identity(st.st_dev, st.st_ino);
  if (node != NULL) {
    close(fd);
  } else {
    node = node_insert(fd, &st);
    if (node == NULL) {
      pthread_mutex_unlock(&nodes.lock);
      close(fd);
      return -ENOMEM;
    }
  }
  int rc = node_add_name(node, parent, name);
  if (rc == 0) node->nlookup++;
  memset(entry, 0, sizeof(*entry));
  entry->ino = node->id;
  entry->generation = node->generation;
  entry->attr = st;
  entry->attr_timeout = ATTR_TIMEOUT_SECONDS;
  entry->entry_timeout = ATTR_TIMEOUT_SECONDS;
  pthread_mutex_unlock(&nodes.lock);
  return rc;
}

static void forget_node(fuse_ino_t id, uint64_t count) {
  pthread_mutex_lock(&nodes.lock);
  struct node *node = node_by_id(id);
  if (node != NULL && node->id != FUSE_ROOT_ID) {
    node->nlookup = count >= node->nlookup ? 0 : node->nlookup - count;
    if (node->nlookup == 0 && node->children == 0) node_free(node);
  }
  pthread_mutex_unlock(&nodes.lock);
}

/* ----------------------------------------------------------- callbacks --- */

static void reply_errno(fuse_req_t req, int rc) {
  fuse_reply_err(req, rc < 0 ? -rc : rc);
}

static void ll_init(void *userdata, struct fuse_conn_info *conn) {
  (void)userdata;
  bool negotiated = (conn->capable & FUSE_CAP_DIRECT_IO_ALLOW_MMAP) != 0;
  if (negotiated) fuse_set_feature_flag(conn, FUSE_CAP_DIRECT_IO_ALLOW_MMAP);
  /* Truncation then arrives inside the open that asked for it, in one round trip
   * and on the one path the journal records. */
  if ((conn->capable & FUSE_CAP_ATOMIC_O_TRUNC) != 0) fuse_set_feature_flag(conn, FUSE_CAP_ATOMIC_O_TRUNC);
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
}

static void ll_lookup(fuse_req_t req, fuse_ino_t parent, const char *name) {
  struct fuse_entry_param entry;
  int rc = lookup_node(parent, name, &entry);
  if (rc == -ENOENT) {
    /* A negative entry the kernel may keep for the same window as a positive one. */
    memset(&entry, 0, sizeof(entry));
    entry.entry_timeout = ATTR_TIMEOUT_SECONDS;
    fuse_reply_entry(req, &entry);
    return;
  }
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  fuse_reply_entry(req, &entry);
}

static void ll_forget(fuse_req_t req, fuse_ino_t ino, uint64_t nlookup) {
  forget_node(ino, nlookup);
  fuse_reply_none(req);
}

static void ll_forget_multi(fuse_req_t req, size_t count, struct fuse_forget_data *forgets) {
  for (size_t index = 0; index < count; index++) forget_node(forgets[index].ino, forgets[index].nlookup);
  fuse_reply_none(req);
}

static void ll_getattr(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  struct stat st;
  int rc;
  if (fi != NULL) {
    rc = fstat((int)fi->fh, &st) == 0 ? 0 : neg_errno();
  } else {
    int fd = fd_of(ino);
    rc = fd < 0 ? -ESTALE : (fstatat(fd, "", &st, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) == 0 ? 0 : neg_errno());
  }
  if (rc != 0) reply_errno(req, rc);
  else fuse_reply_attr(req, &st, ATTR_TIMEOUT_SECONDS);
}

/* Reopen an O_PATH handle with real access, through the kernel's own magic
 * link, which resolves the inode and not any name. */
static int reopen(int path_fd, int flags) {
  char procname[64];
  snprintf(procname, sizeof(procname), "/proc/self/fd/%d", path_fd);
  int fd = open(procname, (flags & ~(O_NOFOLLOW | O_DIRECT)) | O_CLOEXEC);
  return fd < 0 ? neg_errno() : fd;
}

/* One journaled metadata change on an inode, by its canonical path. A nameless
 * inode's change is admitted and applied but journaled as nothing: no name at
 * the cut can describe it. */
static int inode_mutation(fuse_ino_t ino, const char *op, const char *aux, struct mutation *m, bool *journaled,
                          char path[PATH_CAP]) {
  int rc = path_of_inode(ino, path);
  if (rc == -ENOENT) {
    *journaled = false;
    return admit_mutation(m);
  }
  if (rc != 0) return rc;
  *journaled = true;
  return begin_mutation(op, path, aux, m);
}

static int end_inode_mutation(struct mutation *m, bool journaled, const char *op, const char *path, const char *aux,
                              int result) {
  if (!journaled) {
    release_mutation(m);
    return result;
  }
  return finish_mutation(m, op, path, aux, result);
}

static void ll_setattr(fuse_req_t req, fuse_ino_t ino, struct stat *attr, int to_set, struct fuse_file_info *fi) {
  int fd = fd_of(ino);
  if (fd < 0) {
    reply_errno(req, -ESTALE);
    return;
  }
  if (ino == FUSE_ROOT_ID && (to_set & (FUSE_SET_ATTR_MODE | FUSE_SET_ATTR_UID | FUSE_SET_ATTR_GID
                                        | FUSE_SET_ATTR_ATIME | FUSE_SET_ATTR_MTIME)) != 0) {
    reply_errno(req, -EOPNOTSUPP);
    return;
  }
  char path[PATH_CAP];
  char procname[64];
  snprintf(procname, sizeof(procname), "/proc/self/fd/%d", fd);
  if ((to_set & FUSE_SET_ATTR_MODE) != 0) {
    char aux[16];
    snprintf(aux, sizeof(aux), "%u", (unsigned)(attr->st_mode & 07777));
    struct mutation m;
    bool journaled;
    int rc = inode_mutation(ino, "chmod", aux, &m, &journaled, path);
    if (rc != 0) {
      reply_errno(req, rc);
      return;
    }
    int result = (fi != NULL ? fchmod((int)fi->fh, attr->st_mode) : chmod(procname, attr->st_mode)) == 0
      ? 0 : neg_errno();
    result = end_inode_mutation(&m, journaled, "chmod", path, aux, result);
    if (result != 0) {
      reply_errno(req, result);
      return;
    }
  }
  if ((to_set & (FUSE_SET_ATTR_UID | FUSE_SET_ATTR_GID)) != 0) {
    uid_t uid = (to_set & FUSE_SET_ATTR_UID) != 0 ? attr->st_uid : (uid_t)-1;
    gid_t gid = (to_set & FUSE_SET_ATTR_GID) != 0 ? attr->st_gid : (gid_t)-1;
    char aux[32];
    snprintf(aux, sizeof(aux), "%u %u", (unsigned)uid, (unsigned)gid);
    struct mutation m;
    bool journaled;
    int rc = inode_mutation(ino, "chown", aux, &m, &journaled, path);
    if (rc != 0) {
      reply_errno(req, rc);
      return;
    }
    int result = fchownat(fd, "", uid, gid, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) == 0 ? 0 : neg_errno();
    result = end_inode_mutation(&m, journaled, "chown", path, aux, result);
    if (result != 0) {
      reply_errno(req, result);
      return;
    }
  }
  if ((to_set & FUSE_SET_ATTR_SIZE) != 0) {
    char aux[32];
    snprintf(aux, sizeof(aux), "%llu", (counter)attr->st_size);
    struct mutation m;
    bool journaled;
    int rc = inode_mutation(ino, "truncate", aux, &m, &journaled, path);
    if (rc != 0) {
      reply_errno(req, rc);
      return;
    }
    int result = (fi != NULL ? ftruncate((int)fi->fh, attr->st_size) : truncate(procname, attr->st_size)) == 0
      ? 0 : neg_errno();
    result = end_inode_mutation(&m, journaled, "truncate", path, aux, result);
    if (result != 0) {
      reply_errno(req, result);
      return;
    }
  }
  if ((to_set & (FUSE_SET_ATTR_ATIME | FUSE_SET_ATTR_MTIME)) != 0) {
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    struct timespec tv[2];
    tv[0].tv_sec = 0;
    tv[0].tv_nsec = UTIME_OMIT;
    tv[1].tv_sec = 0;
    tv[1].tv_nsec = UTIME_OMIT;
    if ((to_set & FUSE_SET_ATTR_ATIME_NOW) != 0) tv[0] = now;
    else if ((to_set & FUSE_SET_ATTR_ATIME) != 0) tv[0] = attr->st_atim;
    if ((to_set & FUSE_SET_ATTR_MTIME_NOW) != 0) tv[1] = now;
    else if ((to_set & FUSE_SET_ATTR_MTIME) != 0) tv[1] = attr->st_mtim;
    /* The record carries the times the tree will show, so an omitted one is
     * read from the inode rather than spelled as the OMIT sentinel. */
    struct stat st;
    if (fstatat(fd, "", &st, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) != 0) {
      reply_errno(req, neg_errno());
      return;
    }
    struct timespec shown[2] = {
      tv[0].tv_nsec == UTIME_OMIT ? st.st_atim : tv[0],
      tv[1].tv_nsec == UTIME_OMIT ? st.st_mtim : tv[1],
    };
    char aux[64];
    if (snprintf(aux, sizeof(aux), "%llu %llu",
                 (counter)((uint64_t)shown[0].tv_sec * 1000000000ULL + (uint64_t)shown[0].tv_nsec),
                 (counter)((uint64_t)shown[1].tv_sec * 1000000000ULL + (uint64_t)shown[1].tv_nsec)) >= (int)sizeof(aux)) {
      reply_errno(req, -ENAMETOOLONG);
      return;
    }
    struct mutation m;
    bool journaled;
    int rc = inode_mutation(ino, "utimens", aux, &m, &journaled, path);
    if (rc != 0) {
      reply_errno(req, rc);
      return;
    }
    int result;
    if (fi != NULL) result = futimens((int)fi->fh, tv) == 0 ? 0 : neg_errno();
    else result = utimensat(fd, "", tv, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) == 0 ? 0 : neg_errno();
    result = end_inode_mutation(&m, journaled, "utimens", path, aux, result);
    if (result != 0) {
      reply_errno(req, result);
      return;
    }
  }
  ll_getattr(req, ino, fi);
}

static void ll_readlink(fuse_req_t req, fuse_ino_t ino) {
  int fd = fd_of(ino);
  if (fd < 0) {
    reply_errno(req, -ESTALE);
    return;
  }
  char buffer[PATH_CAP];
  ssize_t length = readlinkat(fd, "", buffer, sizeof(buffer) - 1);
  if (length < 0) {
    reply_errno(req, neg_errno());
    return;
  }
  buffer[length] = '\0';
  fuse_reply_readlink(req, buffer);
}

static void ll_access(fuse_req_t req, fuse_ino_t ino, int mask) {
  int fd = fd_of(ino);
  if (fd < 0) {
    reply_errno(req, -ESTALE);
    return;
  }
  long rc = syscall(SYS_faccessat2, fd, "", mask, AT_EACCESS | AT_EMPTY_PATH);
  reply_errno(req, rc == 0 ? 0 : neg_errno());
}

/* The backing tree is one filesystem, so its statistics come from the root fd
 * once the named node is proven to resolve beneath it. */
static void ll_statfs(fuse_req_t req, fuse_ino_t ino) {
  if (fd_of(ino) < 0) {
    reply_errno(req, -ESTALE);
    return;
  }
  struct statvfs st;
  if (fstatvfs(state.root_fd, &st) != 0) reply_errno(req, neg_errno());
  else fuse_reply_statfs(req, &st);
}

/* A new entry under a parent: journaled under the name the caller spelled,
 * then looked up so the kernel gets its node. */
static void reply_created(fuse_req_t req, fuse_ino_t parent, const char *name, int result,
                          struct fuse_file_info *fi) {
  if (result != 0) {
    reply_errno(req, result);
    return;
  }
  struct fuse_entry_param entry;
  int rc = lookup_node(parent, name, &entry);
  if (rc != 0) {
    if (fi != NULL) close((int)fi->fh);
    reply_errno(req, rc);
    return;
  }
  if (fi != NULL) fuse_reply_create(req, &entry, fi);
  else fuse_reply_entry(req, &entry);
}

static void ll_mknod(fuse_req_t req, fuse_ino_t parent, const char *name, mode_t mode, dev_t rdev) {
  char path[PATH_CAP];
  int rc = acceptable_name(name) ? path_of_name(parent, name, path) : -EPERM;
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct mutation m;
  rc = begin_mutation("mknod", path, "", &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int parent_fd = fd_of(parent);
  int result = parent_fd < 0 ? -ESTALE : 0;
  if (result == 0) {
    if (S_ISREG(mode)) {
      int fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, mode);
      result = fd < 0 ? neg_errno() : 0;
      if (fd >= 0) close(fd);
    } else {
      result = mknodat(parent_fd, name, mode, rdev) == 0 ? 0 : neg_errno();
    }
  }
  reply_created(req, parent, name, finish_mutation(&m, "mknod", path, "", result), NULL);
}

static void ll_mkdir(fuse_req_t req, fuse_ino_t parent, const char *name, mode_t mode) {
  char path[PATH_CAP];
  int rc = acceptable_name(name) ? path_of_name(parent, name, path) : -EPERM;
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct mutation m;
  rc = begin_mutation("mkdir", path, "", &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int parent_fd = fd_of(parent);
  int result = parent_fd < 0 ? -ESTALE : (mkdirat(parent_fd, name, mode) == 0 ? 0 : neg_errno());
  reply_created(req, parent, name, finish_mutation(&m, "mkdir", path, "", result), NULL);
}

static void ll_symlink(fuse_req_t req, const char *target, fuse_ino_t parent, const char *name) {
  char path[PATH_CAP];
  int rc = acceptable_name(name) ? path_of_name(parent, name, path) : -EPERM;
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct mutation m;
  rc = begin_mutation("symlink", path, target, &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int parent_fd = fd_of(parent);
  int result = parent_fd < 0 ? -ESTALE : (symlinkat(target, parent_fd, name) == 0 ? 0 : neg_errno());
  reply_created(req, parent, name, finish_mutation(&m, "symlink", path, target, result), NULL);
}

/* The name goes and the node stays: a handle still open keeps the inode. */
static void remove_name(fuse_req_t req, const char *op, fuse_ino_t parent, const char *name, int flags) {
  char path[PATH_CAP];
  int rc = acceptable_name(name) ? path_of_name(parent, name, path) : -EPERM;
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct mutation m;
  rc = begin_mutation(op, path, "", &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int parent_fd = fd_of(parent);
  int result = -ESTALE;
  struct stat st;
  bool known = parent_fd >= 0 && fstatat(parent_fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0;
  if (parent_fd >= 0) result = unlinkat(parent_fd, name, flags) == 0 ? 0 : neg_errno();
  if (result == 0 && known) {
    pthread_mutex_lock(&nodes.lock);
    struct node *node = node_by_identity(st.st_dev, st.st_ino);
    if (node != NULL) node_drop_name(node, parent, name);
    pthread_mutex_unlock(&nodes.lock);
  }
  reply_errno(req, finish_mutation(&m, op, path, "", result));
}

static void ll_unlink(fuse_req_t req, fuse_ino_t parent, const char *name) {
  remove_name(req, "unlink", parent, name, 0);
}

static void ll_rmdir(fuse_req_t req, fuse_ino_t parent, const char *name) {
  remove_name(req, "rmdir", parent, name, AT_REMOVEDIR);
}

static void ll_rename(fuse_req_t req, fuse_ino_t parent, const char *name, fuse_ino_t newparent,
                      const char *newname, unsigned int flags) {
  char from[PATH_CAP];
  char to[PATH_CAP];
  int rc = acceptable_name(name) && acceptable_name(newname) ? path_of_name(parent, name, from) : -EPERM;
  if (rc == 0) rc = path_of_name(newparent, newname, to);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct mutation m;
  rc = begin_mutation("rename", from, to, &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int from_fd = fd_of(parent);
  int to_fd = fd_of(newparent);
  int result = from_fd < 0 || to_fd < 0 ? -ESTALE : 0;
  struct stat moved;
  struct stat replaced;
  bool had_moved = result == 0 && fstatat(from_fd, name, &moved, AT_SYMLINK_NOFOLLOW) == 0;
  bool had_replaced = result == 0 && fstatat(to_fd, newname, &replaced, AT_SYMLINK_NOFOLLOW) == 0;
  if (result == 0) {
    long ok = syscall(SYS_renameat2, from_fd, name, to_fd, newname, flags);
    result = ok == 0 ? 0 : neg_errno();
  }
  if (result == 0) {
    pthread_mutex_lock(&nodes.lock);
    bool exchange = (flags & RENAME_EXCHANGE) != 0;
    if (had_moved) {
      struct node *node = node_by_identity(moved.st_dev, moved.st_ino);
      if (node != NULL) {
        node_drop_name(node, parent, name);
        node_add_name(node, newparent, newname);
      }
    }
    if (had_replaced) {
      struct node *node = node_by_identity(replaced.st_dev, replaced.st_ino);
      if (node != NULL) {
        node_drop_name(node, newparent, newname);
        if (exchange) node_add_name(node, parent, name);
      }
    }
    pthread_mutex_unlock(&nodes.lock);
  }
  reply_errno(req, finish_mutation(&m, "rename", from, to, result));
}

static void ll_link(fuse_req_t req, fuse_ino_t ino, fuse_ino_t newparent, const char *newname) {
  char from[PATH_CAP];
  char to[PATH_CAP];
  int rc = acceptable_name(newname) ? path_of_inode(ino, from) : -EPERM;
  if (rc == 0) rc = path_of_name(newparent, newname, to);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct mutation m;
  rc = begin_mutation("link", to, from, &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int fd = fd_of(ino);
  int parent_fd = fd_of(newparent);
  int result = fd < 0 || parent_fd < 0 ? -ESTALE : 0;
  if (result == 0) {
    char procname[64];
    snprintf(procname, sizeof(procname), "/proc/self/fd/%d", fd);
    result = linkat(AT_FDCWD, procname, parent_fd, newname, AT_SYMLINK_FOLLOW) == 0 ? 0 : neg_errno();
  }
  reply_created(req, newparent, newname, finish_mutation(&m, "link", to, from, result), NULL);
}

struct dir_handle {
  DIR *dp;
  struct dirent *entry;
  off_t offset;
};

static void ll_opendir(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  int path_fd = fd_of(ino);
  if (path_fd < 0) {
    reply_errno(req, -ESTALE);
    return;
  }
  int fd = openat(path_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) {
    reply_errno(req, neg_errno());
    return;
  }
  struct dir_handle *dir = calloc(1, sizeof(*dir));
  if (dir == NULL) {
    close(fd);
    reply_errno(req, -ENOMEM);
    return;
  }
  dir->dp = fdopendir(fd);
  if (dir->dp == NULL) {
    int rc = neg_errno();
    close(fd);
    free(dir);
    reply_errno(req, rc);
    return;
  }
  fi->fh = (uint64_t)(uintptr_t)dir;
  fuse_reply_open(req, fi);
}

static void read_directory(fuse_req_t req, fuse_ino_t ino, size_t size, off_t offset, struct fuse_file_info *fi,
                           bool plus) {
  struct dir_handle *dir = (struct dir_handle *)(uintptr_t)fi->fh;
  char *buffer = calloc(1, size);
  if (buffer == NULL) {
    reply_errno(req, -ENOMEM);
    return;
  }
  if (offset != dir->offset) {
    seekdir(dir->dp, offset);
    dir->entry = NULL;
    dir->offset = offset;
  }
  size_t used = 0;
  int rc = 0;
  for (;;) {
    if (dir->entry == NULL) {
      errno = 0;
      dir->entry = readdir(dir->dp);
      if (dir->entry == NULL) {
        if (errno != 0) rc = neg_errno();
        break;
      }
    }
    off_t next = telldir(dir->dp);
    size_t added;
    if (plus) {
      struct fuse_entry_param entry;
      const char *name = dir->entry->d_name;
      bool dot = name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'));
      memset(&entry, 0, sizeof(entry));
      if (dot) {
        entry.attr.st_ino = dir->entry->d_ino;
        entry.attr.st_mode = (mode_t)(dir->entry->d_type << 12);
      } else {
        int looked = lookup_node(ino, name, &entry);
        if (looked != 0) {
          rc = looked;
          break;
        }
      }
      added = fuse_add_direntry_plus(req, buffer + used, size - used, name, &entry, next);
      if (added > size - used && !dot) forget_node(entry.ino, 1);
    } else {
      struct stat st;
      memset(&st, 0, sizeof(st));
      st.st_ino = dir->entry->d_ino;
      st.st_mode = (mode_t)(dir->entry->d_type << 12);
      added = fuse_add_direntry(req, buffer + used, size - used, dir->entry->d_name, &st, next);
    }
    if (added > size - used) break;
    used += added;
    dir->entry = NULL;
    dir->offset = next;
  }
  if (rc != 0 && used == 0) reply_errno(req, rc);
  else fuse_reply_buf(req, buffer, used);
  free(buffer);
}

static void ll_readdir(fuse_req_t req, fuse_ino_t ino, size_t size, off_t offset, struct fuse_file_info *fi) {
  read_directory(req, ino, size, offset, fi, false);
}

static void ll_readdirplus(fuse_req_t req, fuse_ino_t ino, size_t size, off_t offset, struct fuse_file_info *fi) {
  read_directory(req, ino, size, offset, fi, true);
}

static void ll_releasedir(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  (void)ino;
  struct dir_handle *dir = (struct dir_handle *)(uintptr_t)fi->fh;
  int rc = closedir(dir->dp) == 0 ? 0 : neg_errno();
  free(dir);
  reply_errno(req, rc);
}

static void ll_fsyncdir(fuse_req_t req, fuse_ino_t ino, int datasync, struct fuse_file_info *fi) {
  struct dir_handle *dir = (struct dir_handle *)(uintptr_t)fi->fh;
  const char *op = datasync ? "fdatasyncdir" : "fsyncdir";
  char path[PATH_CAP];
  struct mutation m;
  bool journaled;
  int rc = inode_mutation(ino, op, "", &m, &journaled, path);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int fd = dirfd(dir->dp);
  int result = (datasync ? fdatasync(fd) : fsync(fd)) == 0 ? 0 : neg_errno();
  reply_errno(req, end_inode_mutation(&m, journaled, op, path, "", result));
}

/* A writable handle is direct: every byte it writes has to arrive here and
 * reach a W record before it reaches the file.  A read-only handle keeps the
 * page cache, so the daemon answers the first read of a range and none of the
 * re-reads; an intercepted write drops the cached range, so the two handles
 * stay coherent.  O_DIRECT alignment on the backing file is the daemon's
 * concern, never the caller's, so it is dropped while every other open flag
 * is honoured. */
static void open_flags(struct fuse_file_info *fi, int fd) {
  fi->fh = (uint64_t)fd;
  bool writable = (fi->flags & O_ACCMODE) != O_RDONLY;
  fi->direct_io = writable ? 1 : 0;
  fi->keep_cache = writable ? 0 : 1;
}

/* With atomic truncation negotiated, an open carries the only record of a
 * mutation, so it is journaled exactly like an explicit truncate. */
static void ll_open(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  int path_fd = fd_of(ino);
  if (path_fd < 0) {
    reply_errno(req, -ESTALE);
    return;
  }
  if ((fi->flags & O_TRUNC) == 0) {
    int fd = reopen(path_fd, fi->flags);
    if (fd < 0) {
      reply_errno(req, fd);
      return;
    }
    open_flags(fi, fd);
    fuse_reply_open(req, fi);
    return;
  }
  char path[PATH_CAP];
  struct mutation m;
  bool journaled;
  int rc = inode_mutation(ino, "open-truncate", "", &m, &journaled, path);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int fd = reopen(path_fd, fi->flags);
  int result = end_inode_mutation(&m, journaled, "open-truncate", path, "", fd < 0 ? fd : 0);
  if (result != 0) {
    if (fd >= 0) close(fd);
    reply_errno(req, result);
    return;
  }
  open_flags(fi, fd);
  fuse_reply_open(req, fi);
}

static void ll_create(fuse_req_t req, fuse_ino_t parent, const char *name, mode_t mode, struct fuse_file_info *fi) {
  char path[PATH_CAP];
  int rc = acceptable_name(name) ? path_of_name(parent, name, path) : -EPERM;
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct mutation m;
  rc = begin_mutation("create", path, "", &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int parent_fd = fd_of(parent);
  int fd = -1;
  int result = parent_fd < 0 ? -ESTALE : 0;
  if (result == 0) {
    fd = openat(parent_fd, name, (fi->flags & ~(O_DIRECT | O_NOFOLLOW)) | O_CREAT | O_CLOEXEC, mode);
    result = fd < 0 ? neg_errno() : 0;
  }
  result = finish_mutation(&m, "create", path, "", result);
  if (result != 0) {
    if (fd >= 0) close(fd);
    reply_errno(req, result);
    return;
  }
  fi->fh = (uint64_t)fd;
  fi->direct_io = 1;
  reply_created(req, parent, name, 0, fi);
}

static void ll_release(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  (void)ino;
  reply_errno(req, close((int)fi->fh) == 0 ? 0 : neg_errno());
}

/* flush reports what close(2) would report; durability is fsync's job. */
static void ll_flush(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  (void)ino;
  int copy = dup((int)fi->fh);
  if (copy < 0) {
    reply_errno(req, neg_errno());
    return;
  }
  reply_errno(req, close(copy) == 0 ? 0 : neg_errno());
}

static void ll_read(fuse_req_t req, fuse_ino_t ino, size_t size, off_t offset, struct fuse_file_info *fi) {
  (void)ino;
  atomic_fetch_add_explicit(&state.reads, 1, memory_order_relaxed);
  struct fuse_bufvec buffer = FUSE_BUFVEC_INIT(size);
  buffer.buf[0].flags = FUSE_BUF_IS_FD | FUSE_BUF_FD_SEEK;
  buffer.buf[0].fd = (int)fi->fh;
  buffer.buf[0].pos = offset;
  fuse_reply_data(req, &buffer, FUSE_BUF_SPLICE_MOVE);
}

static void ll_write_buf(fuse_req_t req, fuse_ino_t ino, struct fuse_bufvec *in, off_t offset,
                         struct fuse_file_info *fi) {
  struct stat st;
  if (fstat((int)fi->fh, &st) != 0) {
    reply_errno(req, neg_errno());
    return;
  }
  size_t size = fuse_buf_size(in);
  char path[PATH_CAP];
  int named = path_of_inode(ino, path);
  if (named == -ENOENT) path[0] = '\0';
  else if (named != 0) {
    reply_errno(req, named);
    return;
  }
  struct mutation m;
  int rc = begin_write((uint64_t)st.st_ino, (uint64_t)st.st_nlink, path, offset, size, &m);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  struct fuse_bufvec out = FUSE_BUFVEC_INIT(size);
  out.buf[0].flags = FUSE_BUF_IS_FD | FUSE_BUF_FD_SEEK;
  out.buf[0].fd = (int)fi->fh;
  out.buf[0].pos = offset;
  ssize_t n = fuse_buf_copy(&out, in, 0);
  release_mutation(&m);
  pthread_mutex_lock(&state.queue_lock);
  state.writes++;
  pthread_mutex_unlock(&state.queue_lock);
  if (n < 0) reply_errno(req, (int)n);
  else fuse_reply_write(req, (size_t)n);
}

/* A caller's fsync still flushes the file it named: that is the durability the
 * caller asked for, and it is the only sync left on a reply path. */
static void ll_fsync(fuse_req_t req, fuse_ino_t ino, int datasync, struct fuse_file_info *fi) {
  const char *op = datasync ? "fdatasync" : "fsync";
  char path[PATH_CAP];
  struct mutation m;
  bool journaled;
  int rc = inode_mutation(ino, op, "", &m, &journaled, path);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int fd = (int)fi->fh;
  int result = (datasync ? fdatasync(fd) : fsync(fd)) == 0 ? 0 : neg_errno();
  pthread_mutex_lock(&state.queue_lock);
  state.backing_fsyncs++;
  pthread_mutex_unlock(&state.queue_lock);
  reply_errno(req, end_inode_mutation(&m, journaled, op, path, "", result));
}

static void ll_fallocate(fuse_req_t req, fuse_ino_t ino, int mode, off_t offset, off_t length,
                         struct fuse_file_info *fi) {
  char path[PATH_CAP];
  struct mutation m;
  bool journaled;
  int rc = inode_mutation(ino, "fallocate", "", &m, &journaled, path);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int result = fallocate((int)fi->fh, mode, offset, length) == 0 ? 0 : neg_errno();
  reply_errno(req, end_inode_mutation(&m, journaled, "fallocate", path, "", result));
}

static void ll_lseek(fuse_req_t req, fuse_ino_t ino, off_t offset, int whence, struct fuse_file_info *fi) {
  (void)ino;
  off_t at = lseek((int)fi->fh, offset, whence);
  if (at < 0) reply_errno(req, neg_errno());
  else fuse_reply_lseek(req, at);
}

/* Extended attributes need a readable handle: the kernel allows them only on
 * regular files and directories, so a symlink is reported unsupported. */
static int xattr_target(fuse_ino_t ino, char procname[64]) {
  int fd = fd_of(ino);
  if (fd < 0) return -ESTALE;
  struct stat st;
  if (fstatat(fd, "", &st, AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW) != 0) return neg_errno();
  if (S_ISLNK(st.st_mode)) return -EOPNOTSUPP;
  snprintf(procname, 64, "/proc/self/fd/%d", fd);
  return 0;
}

static void ll_setxattr(fuse_req_t req, fuse_ino_t ino, const char *name, const char *value, size_t size,
                        int flags) {
  if (ino == FUSE_ROOT_ID) {
    reply_errno(req, -EOPNOTSUPP);
    return;
  }
  if (!valid_utf8(name)) {
    reply_errno(req, -EILSEQ);
    return;
  }
  char procname[64];
  int rc = xattr_target(ino, procname);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  char path[PATH_CAP];
  struct mutation m;
  bool journaled;
  rc = inode_mutation(ino, "setxattr", name, &m, &journaled, path);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int result = setxattr(procname, name, value, size, flags) == 0 ? 0 : neg_errno();
  reply_errno(req, end_inode_mutation(&m, journaled, "setxattr", path, name, result));
}

static void ll_getxattr(fuse_req_t req, fuse_ino_t ino, const char *name, size_t size) {
  if (!valid_utf8(name)) {
    reply_errno(req, -EILSEQ);
    return;
  }
  char procname[64];
  int rc = xattr_target(ino, procname);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  if (size == 0) {
    ssize_t length = getxattr(procname, name, NULL, 0);
    if (length < 0) reply_errno(req, neg_errno());
    else fuse_reply_xattr(req, (size_t)length);
    return;
  }
  char *value = malloc(size);
  if (value == NULL) {
    reply_errno(req, -ENOMEM);
    return;
  }
  ssize_t length = getxattr(procname, name, value, size);
  if (length < 0) reply_errno(req, neg_errno());
  else fuse_reply_buf(req, value, (size_t)length);
  free(value);
}

static void ll_listxattr(fuse_req_t req, fuse_ino_t ino, size_t size) {
  char procname[64];
  int rc = xattr_target(ino, procname);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  if (size == 0) {
    ssize_t length = listxattr(procname, NULL, 0);
    if (length < 0) reply_errno(req, neg_errno());
    else fuse_reply_xattr(req, (size_t)length);
    return;
  }
  char *list = malloc(size);
  if (list == NULL) {
    reply_errno(req, -ENOMEM);
    return;
  }
  ssize_t length = listxattr(procname, list, size);
  if (length < 0) reply_errno(req, neg_errno());
  else fuse_reply_buf(req, list, (size_t)length);
  free(list);
}

static void ll_removexattr(fuse_req_t req, fuse_ino_t ino, const char *name) {
  if (ino == FUSE_ROOT_ID) {
    reply_errno(req, -EOPNOTSUPP);
    return;
  }
  if (!valid_utf8(name)) {
    reply_errno(req, -EILSEQ);
    return;
  }
  char procname[64];
  int rc = xattr_target(ino, procname);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  char path[PATH_CAP];
  struct mutation m;
  bool journaled;
  rc = inode_mutation(ino, "removexattr", name, &m, &journaled, path);
  if (rc != 0) {
    reply_errno(req, rc);
    return;
  }
  int result = removexattr(procname, name) == 0 ? 0 : neg_errno();
  reply_errno(req, end_inode_mutation(&m, journaled, "removexattr", path, name, result));
}

static const struct fuse_lowlevel_ops operations = {
  .init = ll_init,
  .lookup = ll_lookup,
  .forget = ll_forget,
  .forget_multi = ll_forget_multi,
  .getattr = ll_getattr,
  .setattr = ll_setattr,
  .readlink = ll_readlink,
  .access = ll_access,
  .statfs = ll_statfs,
  .mknod = ll_mknod,
  .mkdir = ll_mkdir,
  .symlink = ll_symlink,
  .unlink = ll_unlink,
  .rmdir = ll_rmdir,
  .rename = ll_rename,
  .link = ll_link,
  .opendir = ll_opendir,
  .readdir = ll_readdir,
  .readdirplus = ll_readdirplus,
  .releasedir = ll_releasedir,
  .fsyncdir = ll_fsyncdir,
  .open = ll_open,
  .create = ll_create,
  .release = ll_release,
  .flush = ll_flush,
  .read = ll_read,
  .write_buf = ll_write_buf,
  .fsync = ll_fsync,
  .fallocate = ll_fallocate,
  .lseek = ll_lseek,
  .setxattr = ll_setxattr,
  .getxattr = ll_getxattr,
  .listxattr = ll_listxattr,
  .removexattr = ll_removexattr,
};

/* The root node: the retained root directory as an O_PATH handle, id 1. */
static int open_root_node(const char *root_path) {
  int fd = open(root_path, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return neg_errno();
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int rc = neg_errno();
    close(fd);
    return rc;
  }
  pthread_mutex_init(&nodes.lock, NULL);
  pthread_mutex_lock(&nodes.lock);
  struct node *root = node_insert(fd, &st);
  pthread_mutex_unlock(&nodes.lock);
  if (root == NULL) {
    close(fd);
    return -ENOMEM;
  }
  if (root->id != FUSE_ROOT_ID) return -EIO;
  root->nlookup = 1;
  return 0;
}

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
  /* A base names the head the next fence is partial against. It is accepted
   * fresh, or when it names the cut of the latest fence and moves forward:
   * the ordinary hand-back after a fence, or a re-root of the same cut at a
   * higher generation, which is what a compaction publishes without a fence
   * (measured 2026-09-06, sidecar-real-daemon-run.ts: the old rule refused
   * every hand-back after the first compaction). A lower cut, a cut this
   * daemon never fenced, or a different root at the same cut and generation
   * is refused. */
  bool fresh = !state.has_base && !state.has_fence && state.sequence == 0 && state.generation == 1;
  bool at_fence = state.has_fence && cut == state.fence_cut && generation >= state.fence_generation;
  bool forward = !state.has_base || cut > state.base_cut
                 || (cut == state.base_cut && generation > state.base_generation);
  if (!fresh && !(at_fence && forward)) {
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
    if (fresh) state.sequence = cut;
    /* The next fence continues the head's generation, so a publish the
     * daemon did not fence (a compaction) does not leave the two counters
     * one apart for the rest of the boot. */
    if (generation + 1 > state.generation) state.generation = generation + 1;
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
  fuse_session_exit(state.session);
  fuse_session_unmount(state.session);
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
    /* The same rule `run_base` applied when it wrote the record: a base names
     * the latest fence's cut at that fence's generation or a later one (a
     * compaction re-roots the same cut), and never moves backwards. */
    if (r->has_base) {
      bool identical = r->base_cut == sequence && r->base_generation == generation
                       && strcmp(r->base_root, fields[5]) == 0;
      bool forward = sequence > r->base_cut || (sequence == r->base_cut && generation > r->base_generation);
      if (!identical && !forward) return -EUCLEAN;
    }
    if (r->has_fence && (sequence != r->fence_cut || generation < r->fence_generation)) return -EUCLEAN;
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
  int rooted = open_root_node(argv[2]);
  if (rooted != 0) {
    fprintf(stderr, "journal-daemon: cannot open the root node: %s\n", strerror(-rooted));
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
  state.session = fuse_session_new(&args, &operations, sizeof(operations), NULL);
  fuse_opt_free_args(&args);
  if (state.session == NULL) {
    fprintf(stderr, "journal-daemon: cannot create the session\n");
    return 3;
  }
  if (fuse_session_mount(state.session, argv[4]) != 0) {
    fprintf(stderr, "journal-daemon: cannot mount %s\n", argv[4]);
    fuse_session_destroy(state.session);
    return 3;
  }
  if (start_control() != 0) {
    fprintf(stderr, "journal-daemon: cannot serve the control socket\n");
    detach_session();
    fuse_session_destroy(state.session);
    return 3;
  }

  /* A loop that cannot be configured still leaves a mount and two threads, so it
   * reports a failure through the one teardown rather than returning early. */
  int status = -ENOMEM;
  struct fuse_loop_config *loop = fuse_loop_cfg_create();
  if (loop != NULL) {
    fuse_loop_cfg_set_clone_fd(loop, 1);
    fuse_loop_cfg_set_max_threads(loop, 16);
    status = fuse_session_loop_mt(state.session, loop);
    fuse_loop_cfg_destroy(loop);
  }

  /* The loop also ends on its own, so main closes admission and detaches the
   * mount for the shutdowns nobody asked for.  Destroying the session waits for
   * the control thread, the last thread besides main that can still reach it. */
  begin_shutdown();
  wake_control();
  pthread_join(state.control_thread, NULL);
  fuse_session_destroy(state.session);
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
