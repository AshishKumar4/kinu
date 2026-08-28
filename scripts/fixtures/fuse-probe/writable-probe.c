#define FUSE_USE_VERSION 317
#define _GNU_SOURCE
#include <fuse3/fuse_lowlevel.h>
#include <fuse3/fuse_kernel.h>

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/mount.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

_Static_assert(FUSE_KERNEL_VERSION == 7, "probe requires FUSE protocol major 7");
_Static_assert(FUSE_KERNEL_MINOR_VERSION >= 39, "probe requires FUSE protocol 7.39+");
_Static_assert(FUSE_DIRECT_IO_ALLOW_MMAP == (1ULL << 36), "header ABI changed");
_Static_assert(FOPEN_DIRECT_IO == 1, "header ABI changed");

#define DATA_INO 2
#define FILE_BYTES 4096
#define FENCE_WAIT_MS 10000
#define READY_FD 3

enum mutation {
  MUTATE_NONE,
  MUTATE_REPLY_BEFORE_LOG,
  MUTATE_CLOSE_REQUEST_LOOP,
  MUTATE_OMIT_MSYNC,
  MUTATE_POST_FENCE_CONTAMINATION,
  MUTATE_INTENT_FSYNC_FAILURE,
  MUTATE_RESULT_FSYNC_FAILURE,
  MUTATE_RESTART_TRUNCATION,
  MUTATE_SKIP_RECOVERY,
};

struct state {
  int backing_fd;
  int event_fd;
  int control_fd;
  int control_stop[2];
  pthread_mutex_t lock;
  atomic_uint_fast64_t next_request;
  pthread_cond_t drained;
  atomic_uint_fast64_t next_sequence;
  uint64_t fence_cut;
  unsigned admitted_writes;
  unsigned blocked_writes;
  bool write_admission_closed;
  bool fence_started;
  bool fence_drained;
  bool designated_waiter_required;
  bool designated_waiter_blocked;
  uint64_t designated_waiter_request;
  bool fence_completed;
  bool direct_io_offered;
  bool direct_io_enabled;
  bool request_loop_served_after_fence;
  bool reply_before_log_seen;
  bool journal_failed;
  bool backing_created;
  bool backing_opened_existing;
  enum mutation mutation;
  struct fuse_session *session;
};
static bool decode_hex(const char *text, size_t bytes, unsigned char *out);
static bool value_u64(const char *line, const char *name, uint64_t *value);
static bool value_string(const char *line, const char *name, char *value, size_t size);

struct control_server {
  struct state *state;
};

static long thread_id(void) { return syscall(SYS_gettid); }

/* Each event is a complete frame that reaches stable storage before the
 * operation it authorizes. A result frame carries the actual backing outcome. */
static bool append_text(char *frame, size_t capacity, size_t *used, const char *format, ...) {
  va_list args;
  va_start(args, format);
  const int written = vsnprintf(frame + *used, capacity - *used, format, args);
  va_end(args);
  if (written < 0 || (size_t)written >= capacity - *used) return false;
  *used += (size_t)written;
  return true;
}

static int append_event(struct state *s, const char *kind, const char *phase,
                        uint64_t request, off_t offset, const char *payload,
                        size_t payload_size, ssize_t actual_length,
                        int operation_errno, const char *poststate) {
  char frame[FILE_BYTES * 2 + 1024];
  size_t used = 0;
  const uint64_t sequence = atomic_fetch_add(&s->next_sequence, 1) + 1;
  if (!append_text(frame, sizeof(frame), &used,
      "{\"sequence\":%llu,\"request\":%llu,\"thread\":%ld,\"kind\":\"%s\","
      "\"phase\":\"%s\",\"fenceCut\":%llu,\"loggedBeforeReply\":%s,"
      "\"preconditions\":{\"writeAdmissionClosed\":%s,\"fenceCompleted\":%s,\"withinFile\":true,"
      "\"offset\":%lld,\"size\":%zu},\"actualLength\":%lld,\"errno\":%d,\"poststate\":\"%s\"",
      (unsigned long long)sequence, (unsigned long long)request, thread_id(), kind, phase,
      (unsigned long long)s->fence_cut, s->reply_before_log_seen ? "false" : "true",
      s->write_admission_closed ? "true" : "false", s->fence_completed ? "true" : "false",
      (long long)offset, payload_size, (long long)actual_length, operation_errno, poststate)) {
    errno = EOVERFLOW;
    return -1;
  }
  if (payload != NULL) {
    if (!append_text(frame, sizeof(frame), &used, ",\"payloadHex\":\"")) {
      errno = EOVERFLOW;
      return -1;
    }
    for (size_t i = 0; i < payload_size; ++i) {
      if (!append_text(frame, sizeof(frame), &used, "%02x", (unsigned char)payload[i])) {
        errno = EOVERFLOW;
        return -1;
      }
    }
    if (!append_text(frame, sizeof(frame), &used, "\"")) {
      errno = EOVERFLOW;
      return -1;
    }
  }
  if (!append_text(frame, sizeof(frame), &used, "}\n")) {
    errno = EOVERFLOW;
    return -1;
  }
  size_t remaining = used;
  const char *cursor = frame;
  while (remaining > 0) {
    const ssize_t written = write(s->event_fd, cursor, remaining);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) {
      if (written == 0) errno = EIO;
      return -1;
    }
    cursor += written;
    remaining -= (size_t)written;
  }
  if ((strcmp(kind, "INTENT") == 0 && s->mutation == MUTATE_INTENT_FSYNC_FAILURE)
      || (strcmp(kind, "RESULT") == 0 && s->mutation == MUTATE_RESULT_FSYNC_FAILURE)) {
    errno = EIO;
    return -1;
  }
  return fsync(s->event_fd);
}

static void fail_journal(struct state *s) {
  s->journal_failed = true;
  if (s->session != NULL) fuse_session_exit(s->session);
}

static struct state *state_of(fuse_req_t req) {
  return fuse_req_userdata(req);
}

static uint64_t request_id(struct state *s) {
  return atomic_fetch_add(&s->next_request, 1) + 1;
}

static void attr_for(fuse_ino_t ino, struct stat *attr) {
  memset(attr, 0, sizeof(*attr));
  attr->st_ino = ino;
  attr->st_mode = ino == FUSE_ROOT_ID ? (S_IFDIR | 0755) : (S_IFREG | 0644);
  attr->st_nlink = ino == FUSE_ROOT_ID ? 2 : 1;
  attr->st_size = ino == DATA_INO ? FILE_BYTES : 0;
  attr->st_blksize = 4096;
  attr->st_blocks = ino == DATA_INO ? FILE_BYTES / 512 : 0;
}

static void ll_init(void *userdata, struct fuse_conn_info *conn) {
  struct state *s = userdata;
  if ((conn->capable & FUSE_CAP_DIRECT_IO_ALLOW_MMAP) != 0) {
    conn->want |= FUSE_CAP_DIRECT_IO_ALLOW_MMAP;
    s->direct_io_offered = true;
  }
}

static void ll_lookup(fuse_req_t req, fuse_ino_t parent, const char *name) {
  if (parent != FUSE_ROOT_ID || strcmp(name, "data") != 0) {
    fuse_reply_err(req, ENOENT);
    return;
  }
  struct fuse_entry_param entry;
  memset(&entry, 0, sizeof(entry));
  entry.ino = DATA_INO;
  attr_for(DATA_INO, &entry.attr);
  entry.attr_timeout = 0;
  entry.entry_timeout = 0;
  fuse_reply_entry(req, &entry);
}

static void ll_getattr(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  (void)fi;
  if (ino != FUSE_ROOT_ID && ino != DATA_INO) { fuse_reply_err(req, ENOENT); return; }
  struct stat attr;
  attr_for(ino, &attr);
  fuse_reply_attr(req, &attr, 0);
}

static void ll_readdir(fuse_req_t req, fuse_ino_t ino, size_t size, off_t off,
                       struct fuse_file_info *fi) {
  (void)fi;
  if (ino != FUSE_ROOT_ID) { fuse_reply_err(req, ENOTDIR); return; }
  char buffer[512];
  size_t used = 0;
  if (off == 0) {
    struct stat attr;
    attr_for(FUSE_ROOT_ID, &attr);
    used += fuse_add_direntry(req, buffer + used, size - used, ".", &attr, 1);
    used += fuse_add_direntry(req, buffer + used, size - used, "..", &attr, 2);
    attr_for(DATA_INO, &attr);
    used += fuse_add_direntry(req, buffer + used, size - used, "data", &attr, 3);
  }
  fuse_reply_buf(req, buffer, used);
}

static void ll_open(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  struct state *s = state_of(req);
  if (ino != DATA_INO) { fuse_reply_err(req, EISDIR); return; }
  if (!s->direct_io_offered) { fuse_reply_err(req, EOPNOTSUPP); return; }
  fi->direct_io = 1;
  s->direct_io_enabled = true;
  fuse_reply_open(req, fi);
}

static void ll_read(fuse_req_t req, fuse_ino_t ino, size_t size, off_t offset,
                    struct fuse_file_info *fi) {
  (void)fi;
  struct state *s = state_of(req);
  if (ino != DATA_INO || offset < 0) { fuse_reply_err(req, EINVAL); return; }
  if ((size_t)offset >= FILE_BYTES) { fuse_reply_buf(req, NULL, 0); return; }
  if (size > FILE_BYTES - (size_t)offset) size = FILE_BYTES - (size_t)offset;
  char *buf = malloc(size);
  if (buf == NULL) { fuse_reply_err(req, ENOMEM); return; }
  ssize_t got = pread(s->backing_fd, buf, size, offset);
  if (got < 0) fuse_reply_err(req, errno); else fuse_reply_buf(req, buf, (size_t)got);
  free(buf);
}

static void ll_write(fuse_req_t req, fuse_ino_t ino, const char *buf, size_t size,
                     off_t offset, struct fuse_file_info *fi) {
  (void)fi;
  struct state *s = state_of(req);
  if (ino != DATA_INO || offset < 0 || (size_t)offset + size > FILE_BYTES) {
    fuse_reply_err(req, EINVAL);
    return;
  }
  const uint64_t request = request_id(s);
  const bool tagged_waiter = offset <= 1 && size > 1 - (size_t)offset
    && (unsigned char)buf[1 - offset] == 0x22;
  pthread_mutex_lock(&s->lock);
  while (s->write_admission_closed && !s->journal_failed) {
    s->blocked_writes++;
    if (s->designated_waiter_required && !s->designated_waiter_blocked && tagged_waiter) {
      s->designated_waiter_blocked = true;
      s->designated_waiter_request = request;
      pthread_cond_broadcast(&s->drained);
    }
    pthread_cond_wait(&s->drained, &s->lock);
    s->blocked_writes--;
  }
  if (s->journal_failed) {
    pthread_mutex_unlock(&s->lock);
    fuse_reply_err(req, EIO);
    return;
  }
  const char *phase = s->fence_started ? "post" : "pre";
  s->admitted_writes++;
  if (s->mutation == MUTATE_REPLY_BEFORE_LOG) {
    const ssize_t written = pwrite(s->backing_fd, buf, size, offset);
    const int write_error = written < 0 ? errno : written == (ssize_t)size ? 0 : EIO;
    const size_t result_size = written > 0 ? (size_t)written : 0;
    s->reply_before_log_seen = true;
    pthread_mutex_unlock(&s->lock);
    if (write_error == 0) fuse_reply_write(req, size); else fuse_reply_err(req, write_error);
    pthread_mutex_lock(&s->lock);
    (void)append_event(s, "RESULT", phase, request, offset, buf, result_size, written,
      write_error, write_error == 0 ? "written" : "failed");
    s->admitted_writes--;
    pthread_cond_broadcast(&s->drained);
    pthread_mutex_unlock(&s->lock);
    return;
  }
  if (append_event(s, "INTENT", phase, request, offset, buf, size, -1, 0, "pending") != 0) {
    s->admitted_writes--;
    pthread_cond_broadcast(&s->drained);
    fail_journal(s);
    pthread_mutex_unlock(&s->lock);
    fuse_reply_err(req, EIO);
    return;
  }
  const ssize_t written = pwrite(s->backing_fd, buf, size, offset);
  const int write_error = written < 0 ? errno : written == (ssize_t)size ? 0 : EIO;
  const size_t result_size = written > 0 ? (size_t)written : 0;
  if (size > 0 && offset <= 7 && (size_t)offset + size > 7
      && (unsigned char)buf[7 - offset] == 0x77 && write_error == 0) {
    pthread_mutex_unlock(&s->lock);
    kill(getpid(), SIGKILL);
    _exit(4);
  }
  if (append_event(s, "RESULT", phase, request, offset, buf, result_size, written,
      write_error, write_error == 0 ? "written" : "failed") != 0) {
    s->admitted_writes--;
    pthread_cond_broadcast(&s->drained);
    fail_journal(s);
    pthread_mutex_unlock(&s->lock);
    fuse_reply_err(req, EIO);
    return;
  }
  s->admitted_writes--;
  if (s->fence_started) s->request_loop_served_after_fence = true;
  pthread_cond_broadcast(&s->drained);
  pthread_mutex_unlock(&s->lock);
  if (write_error == 0) fuse_reply_write(req, size); else fuse_reply_err(req, write_error);
}

static void ll_fsync(fuse_req_t req, fuse_ino_t ino, int datasync,
                     struct fuse_file_info *fi) {
  (void)datasync; (void)fi;
  struct state *s = state_of(req);
  if (ino != DATA_INO) { fuse_reply_err(req, EINVAL); return; }
  pthread_mutex_lock(&s->lock);
  if (s->journal_failed || append_event(s, "FSYNC", s->fence_started ? "post" : "pre",
      request_id(s), 0, NULL, 0, 0, 0, "pending") != 0) {
    pthread_mutex_unlock(&s->lock);
    fuse_reply_err(req, EIO);
    return;
  }
  const int rc = fsync(s->backing_fd);
  const int error = errno;
  pthread_mutex_unlock(&s->lock);
  fuse_reply_err(req, rc == 0 ? 0 : error);
}

static void ll_release(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *fi) {
  (void)ino; (void)fi;
  fuse_reply_err(req, 0);
}

static const struct fuse_lowlevel_ops ops = {
  .init = ll_init,
  .lookup = ll_lookup,
  .getattr = ll_getattr,
  .readdir = ll_readdir,
  .open = ll_open,
  .read = ll_read,
  .write = ll_write,
  .fsync = ll_fsync,
  .release = ll_release,
};

/* FUSE has no low-level syncfs callback. The daemon owns this Unix socket, so
 * the fence cannot wait for a request that its own admission closure blocks. */
static int close_write_admission(struct state *s) {
  pthread_mutex_lock(&s->lock);
  if (s->journal_failed) {
    pthread_mutex_unlock(&s->lock);
    return EIO;
  }
  s->write_admission_closed = true;
  s->fence_started = true;
  if (append_event(s, "FENCE", "closed", 0, 0, NULL, 0, 0, 0, "admission-closed") != 0) {
    fail_journal(s);
  }
  while (s->admitted_writes != 0 && !s->journal_failed)
    pthread_cond_wait(&s->drained, &s->lock);
  s->fence_drained = !s->journal_failed;
  s->designated_waiter_required = true;
  while (!s->designated_waiter_blocked && !s->journal_failed)
    pthread_cond_wait(&s->drained, &s->lock);
  const int rc = s->journal_failed ? -1 : fsync(s->backing_fd);
  const int error = rc == 0 ? 0 : errno;
  s->fence_cut = s->mutation == MUTATE_POST_FENCE_CONTAMINATION
    ? UINT64_MAX : atomic_load(&s->next_sequence);
  if (error != 0 || append_event(s, "FENCE", "cut", s->designated_waiter_request,
      0, NULL, 0, 0, error, error == 0 ? "complete" : "failed") != 0) {
    fail_journal(s);
  }
  s->fence_completed = !s->journal_failed && error == 0;
  s->write_admission_closed = false;
  pthread_cond_broadcast(&s->drained);
  pthread_mutex_unlock(&s->lock);
  if (s->mutation == MUTATE_CLOSE_REQUEST_LOOP && s->fence_completed)
    fuse_session_exit(s->session);
  return s->journal_failed ? EIO : error;
}
static void *serve_control_socket(void *opaque) {
  struct control_server *server = opaque;
  struct state *s = server->state;
  for (;;) {
    struct pollfd ready[] = {
      { .fd = s->control_fd, .events = POLLIN },
      { .fd = s->control_stop[0], .events = POLLIN },
    };
    if (poll(ready, 2, -1) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if ((ready[1].revents & POLLIN) != 0) break;
    if ((ready[0].revents & POLLIN) == 0) continue;
    const int client = accept(s->control_fd, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      break;
    }
    char command[16] = {0};
    const ssize_t received = read(client, command, sizeof(command) - 1);
    const int error = received >= 5 && memcmp(command, "FENCE", 5) == 0
      ? close_write_admission(s) : EINVAL;
    const char *reply = error == 0 ? "OK\n" : "ER\n";
    const ssize_t sent = write(client, reply, strlen(reply));
    if (sent != (ssize_t)strlen(reply)) { /* The caller observes a failed fence. */ }
    close(client);
  }
  return NULL;
}


static enum mutation parse_mutation(int argc, char **argv) {
  for (int i = 1; i < argc; ++i) {
    if (strcmp(argv[i], "--mutation=reply-before-log") == 0) return MUTATE_REPLY_BEFORE_LOG;
    if (strcmp(argv[i], "--mutation=fence-closes-request-loop") == 0) return MUTATE_CLOSE_REQUEST_LOOP;
    if (strcmp(argv[i], "--mutation=omit-msync") == 0) return MUTATE_OMIT_MSYNC;
    if (strcmp(argv[i], "--mutation=post-fence-contamination") == 0) return MUTATE_POST_FENCE_CONTAMINATION;
    if (strcmp(argv[i], "--mutation=intent-fsync-failure") == 0) return MUTATE_INTENT_FSYNC_FAILURE;
    if (strcmp(argv[i], "--mutation=result-fsync-failure") == 0) return MUTATE_RESULT_FSYNC_FAILURE;
    if (strcmp(argv[i], "--mutation=restart-truncation") == 0) return MUTATE_RESTART_TRUNCATION;
    if (strcmp(argv[i], "--mutation=skip-recovery") == 0) return MUTATE_SKIP_RECOVERY;
  }
  return MUTATE_NONE;
}

static const char *mutation_name(enum mutation mutation) {
  switch (mutation) {
    case MUTATE_REPLY_BEFORE_LOG: return "reply-before-log";
    case MUTATE_CLOSE_REQUEST_LOOP: return "fence-closes-request-loop";
    case MUTATE_OMIT_MSYNC: return "omit-msync";
    case MUTATE_POST_FENCE_CONTAMINATION: return "post-fence-contamination";
    case MUTATE_INTENT_FSYNC_FAILURE: return "intent-fsync-failure";
    case MUTATE_RESULT_FSYNC_FAILURE: return "result-fsync-failure";
    case MUTATE_RESTART_TRUNCATION: return "restart-truncation";
    case MUTATE_SKIP_RECOVERY: return "skip-recovery";
    default: return "none";
  }
}

static uint64_t last_event_sequence(const char *events) {
  FILE *file = fopen(events, "r");
  if (file == NULL) return 0;
  uint64_t last = 0;
  char *line = NULL;
  size_t capacity = 0;
  while (getline(&line, &capacity, file) >= 0) {
    const char *sequence = strstr(line, "\"sequence\":");
    if (sequence != NULL) {
      const uint64_t seen = strtoull(sequence + strlen("\"sequence\":"), NULL, 10);
      if (seen > last) last = seen;
    }
  }
  free(line);
  fclose(file);
  return last;
}
static int reconcile_unmatched_intent(struct state *s, const char *backing, const char *events) {
  FILE *file = fopen(events, "r");
  if (file == NULL) return -1;
  unsigned char rebuilt[FILE_BYTES] = {0};
  uint64_t pending = 0;
  char *line = NULL;
  size_t line_capacity = 0;
  int result = 0;
  while (getline(&line, &line_capacity, file) >= 0) {
    uint64_t request = 0;
    char kind[16] = {0};
    if (!value_u64(line, "\"request\":", &request)
        || !value_string(line, "\"kind\":\"", kind, sizeof(kind))) {
      result = -1;
      break;
    }
    if (strcmp(kind, "INTENT") == 0) {
      if (pending != 0) { result = -1; break; }
      pending = request;
      continue;
    }
    if (strcmp(kind, "RESULT") != 0) continue;
    uint64_t offset = 0, size = 0, actual = 0, operation_errno = 0;
    const char *payload = strstr(line, "\"payloadHex\":\"");
    if (pending != request || !value_u64(line, "\"offset\":", &offset)
        || !value_u64(line, "\"size\":", &size) || !value_u64(line, "\"actualLength\":", &actual)
        || !value_u64(line, "\"errno\":", &operation_errno) || operation_errno != 0
        || actual != size || payload == NULL || size > FILE_BYTES || offset + size > FILE_BYTES
        || strstr(line, "\"poststate\":\"written\"") == NULL) {
      result = -1;
      break;
    }
    payload += strlen("\"payloadHex\":\"");
    if (!decode_hex(payload, (size_t)size, rebuilt + offset)) {
      result = -1;
      break;
    }
    pending = 0;
  }
  free(line);
  fclose(file);
  if (result != 0 || pending == 0) return result;
  char replacement[1024];
  if (snprintf(replacement, sizeof(replacement), "%s.recovery", backing) >= (int)sizeof(replacement))
    return -1;
  const int replacement_fd = open(replacement, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (replacement_fd < 0) return -1;
  const bool wrote_replacement = pwrite(replacement_fd, rebuilt, sizeof(rebuilt), 0) == (ssize_t)sizeof(rebuilt)
    && fsync(replacement_fd) == 0;
  const bool replacement_closed = close(replacement_fd) == 0;
  bool rebuilt_ok = wrote_replacement && replacement_closed && rename(replacement, backing) == 0;
  char directory[1024];
  if (snprintf(directory, sizeof(directory), "%s", backing) >= (int)sizeof(directory)) rebuilt_ok = false;
  char *slash = strrchr(directory, '/');
  if (rebuilt_ok && slash != NULL) {
    if (slash == directory) slash[1] = '\0'; else *slash = '\0';
    const int directory_fd = open(directory, O_RDONLY | O_DIRECTORY);
    rebuilt_ok = directory_fd >= 0 && fsync(directory_fd) == 0;
    if (directory_fd >= 0) close(directory_fd);
  }
  if (!rebuilt_ok) {
    const int error = errno;
    if (!replacement_closed) close(replacement_fd);
    unlink(replacement);
    errno = error;
    return -1;
  }
  close(s->backing_fd);
  s->backing_fd = open(backing, O_RDWR);
  if (s->backing_fd < 0 || append_event(s, "RECOVERY", "aborted-intent", pending, 0, NULL, 0,
      0, 0, "rebuilt-from-results") != 0) {
    return -1;
  }
  return 0;
}

static int run_daemon(const char *mountpoint, const char *backing, const char *events,
                      const char *control_path, enum mutation mutation, int ready_fd) {
  bool created = false;
  int backing_fd = open(backing, O_RDWR | O_CREAT | O_EXCL, 0600);
  if (backing_fd >= 0) {
    created = true;
    if (ftruncate(backing_fd, FILE_BYTES) != 0 || fsync(backing_fd) != 0) {
      close(backing_fd);
      return 2;
    }
  } else if (errno == EEXIST) {
    const int flags = O_RDWR | (mutation == MUTATE_RESTART_TRUNCATION ? O_TRUNC : 0);
    backing_fd = open(backing, flags);
    if (backing_fd < 0) return 2;
    if (mutation == MUTATE_RESTART_TRUNCATION) {
      if (ftruncate(backing_fd, FILE_BYTES) != 0 || fsync(backing_fd) != 0) {
        close(backing_fd);
        return 2;
      }
    } else {
      struct stat attr;
      if (fstat(backing_fd, &attr) != 0 || attr.st_size != FILE_BYTES) {
        close(backing_fd);
        return 2;
      }
    }
  } else {
    return 2;
  }
  struct state state = {
    .backing_fd = backing_fd,
    .event_fd = open(events, O_WRONLY | O_CREAT | O_APPEND, 0600),
    .control_stop = { -1, -1 },
    .next_sequence = last_event_sequence(events),
    .mutation = mutation,
    .backing_created = created,
    .backing_opened_existing = !created,
  };
  if (state.event_fd < 0) {
    close(state.backing_fd);
    return 2;
  }
  pthread_mutex_init(&state.lock, NULL);
  pthread_cond_init(&state.drained, NULL);
  if (!created && mutation != MUTATE_SKIP_RECOVERY && mutation != MUTATE_RESTART_TRUNCATION
      && reconcile_unmatched_intent(&state, backing, events) != 0) {
    close(state.backing_fd);
    close(state.event_fd);
    return 2;
  }
  if (append_event(&state, "BACKING", created ? "created" : "existing", 0, 0, NULL, 0,
      FILE_BYTES, 0, created ? "initialized" : "preserved") != 0) {
    close(state.backing_fd);
    close(state.event_fd);
    return 2;
  }
  char *argv[] = { "fuse-mmap-probe", "-o", "fsname=fuse-mmap-probe", "-o", "default_permissions", NULL };
  struct fuse_args args = FUSE_ARGS_INIT(5, argv);
  struct fuse_session *session = fuse_session_new(&args, &ops, sizeof(ops), &state);
  if (session == NULL || fuse_session_mount(session, mountpoint) != 0) {
    dprintf(ready_fd, "E:%d", errno);
    return 3;
  }
  state.session = session;
  state.control_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (state.control_fd < 0 || strlen(control_path) >= sizeof(address.sun_path)) {
    dprintf(ready_fd, "E:%d", errno);
    return 3;
  }
  memcpy(address.sun_path, control_path, strlen(control_path) + 1);
  unlink(control_path);
  if (bind(state.control_fd, (const struct sockaddr *)&address, sizeof(address)) != 0
      || listen(state.control_fd, 1) != 0) {
    dprintf(ready_fd, "E:%d", errno);
    close(state.control_fd);
    return 3;
  }
  if (pipe2(state.control_stop, O_CLOEXEC) != 0) {
    dprintf(ready_fd, "E:%d", errno);
    close(state.control_fd);
    unlink(control_path);
    return 3;
  }
  struct control_server control = { .state = &state };
  pthread_t control_thread;
  if (pthread_create(&control_thread, NULL, serve_control_socket, &control) != 0) {
    dprintf(ready_fd, "E:%d", errno);
    close(state.control_stop[0]);
    close(state.control_stop[1]);
    close(state.control_fd);
    unlink(control_path);
    return 3;
  }
  dprintf(ready_fd, "R");
  close(ready_fd);
  struct fuse_loop_config *loop_config = fuse_loop_cfg_create();
  if (loop_config == NULL) return 4;
  fuse_session_loop_mt(session, loop_config);
  fuse_loop_cfg_destroy(loop_config);
  const char stop = 'x';
  if (write(state.control_stop[1], &stop, 1) != 1) { /* poll wake is best effort. */ }
  pthread_join(control_thread, NULL);
  close(state.control_stop[0]);
  close(state.control_stop[1]);
  close(state.control_fd);
  unlink(control_path);
  fuse_session_unmount(session);
  fuse_session_destroy(session);
  close(state.backing_fd);
  close(state.event_fd);
  return state.journal_failed ? 4 : 0;
}
static int wait_ready(int fd) {
  char result[32] = {0};
  const ssize_t got = read(fd, result, sizeof(result) - 1);
  close(fd);
  return got == 1 && result[0] == 'R' ? 0 : -1;
}

static pid_t start_daemon(const char *mountpoint, const char *backing, const char *events,
                          const char *control_path, enum mutation mutation) {
  int pipefd[2];
  if (pipe(pipefd) != 0) return -1;
  pid_t child = fork();
  if (child == 0) {
    close(pipefd[0]);
    const int code = run_daemon(mountpoint, backing, events, control_path, mutation, pipefd[1]);
    _exit(code);
  }
  close(pipefd[1]);
  if (child < 0 || wait_ready(pipefd[0]) != 0) return -1;
  return child;
}

static int mapped_store(const char *path, int offset, unsigned char value,
                        enum mutation mutation) {
  int fd = open(path, O_RDWR);
  if (fd < 0) return -1;
  unsigned char *map = mmap(NULL, FILE_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (map == MAP_FAILED) { close(fd); return -1; }
  map[offset] = value;
  const int msync_rc = mutation == MUTATE_OMIT_MSYNC ? 0 : msync(map, FILE_BYTES, MS_SYNC);
  const int msync_error = errno;
  munmap(map, FILE_BYTES);
  close(fd);
  if (mutation == MUTATE_OMIT_MSYNC) return 1;
  if (msync_rc != 0) { errno = msync_error; return -1; }
  return 0;
}

struct control_call { const char *path; int result; int error; };
static void *call_control_fence(void *opaque) {
  struct control_call *call = opaque;
  const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (fd < 0 || strlen(call->path) >= sizeof(address.sun_path)) {
    call->result = -1;
    call->error = errno;
    if (fd >= 0) close(fd);
    return NULL;
  }
  memcpy(address.sun_path, call->path, strlen(call->path) + 1);
  if (connect(fd, (const struct sockaddr *)&address, sizeof(address)) != 0
      || write(fd, "FENCE\n", 6) != 6) {
    call->result = -1;
    call->error = errno;
    close(fd);
    return NULL;
  }
  char reply[3] = {0};
  call->result = read(fd, reply, sizeof(reply) - 1) == 2 && strcmp(reply, "OK") == 0 ? 0 : -1;
  call->error = call->result == 0 ? 0 : EIO;
  close(fd);
  return NULL;
}

struct dirty_writer {
  const char *path;
  enum mutation mutation;
  atomic_bool running;
  bool wrote;
};

static void *continuously_dirty(void *opaque) {
  struct dirty_writer *writer = opaque;
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000 * 1000 };
  while (atomic_load(&writer->running)) {
    if (mapped_store(writer->path, 6, 0x66, writer->mutation) == 0) writer->wrote = true;
    nanosleep(&pause, NULL);
  }
  return NULL;
}

static bool value_u64(const char *line, const char *name, uint64_t *value) {
  const char *at = strstr(line, name);
  if (at == NULL) return false;
  *value = strtoull(at + strlen(name), NULL, 10);
  return true;
}

static bool value_string(const char *line, const char *name, char *value, size_t size) {
  const char *at = strstr(line, name);
  if (at == NULL) return false;
  at += strlen(name);
  const char *end = strchr(at, '"');
  if (end == NULL || (size_t)(end - at) >= size) return false;
  memcpy(value, at, (size_t)(end - at));
  value[end - at] = '\0';
  return true;
}

struct log_evidence {
  bool ordered;
  bool all_logged_before_reply;
  bool control_fence_observed;
  bool fence_closed;
  bool fence_drained;
  bool no_writes_admitted_while_closed;
  bool post_write_after_cut;
  bool designated_waiter_result_after_cut;
  bool post_before_completion;
  bool prefix_replay_ok;
  bool pre_prefix_included;
  bool excluded_writes_absent_from_prefix;
  bool intent_result_ordered;
  bool continuous_before_fence_closed;
  bool continuous_after_fence_complete;
  bool restart_opened_existing;
  bool pending_empty;
  bool recovery_abort_durable;
};

static bool decode_hex(const char *text, size_t bytes, unsigned char *out) {
  for (size_t i = 0; i < bytes; ++i) {
    unsigned parsed = 0;
    if (sscanf(text + i * 2, "%2x", &parsed) != 1) return false;
    out[i] = (unsigned char)parsed;
  }
  return true;
}

static struct log_evidence inspect_event_log(const char *events) {
  struct log_evidence evidence = {
    .ordered = true, .all_logged_before_reply = true, .intent_result_ordered = true,
    .no_writes_admitted_while_closed = true,
  };
  FILE *file = fopen(events, "r");
  if (file == NULL) { evidence.ordered = false; return evidence; }
  uint64_t last = 0, fence_cut = 0, designated_waiter_request = 0, pending_intent = 0;
  bool cut_seen = false;
  bool excluded_seen[4] = { false };
  unsigned char prefix[FILE_BYTES] = {0};
  char *line = NULL;
  size_t line_cap = 0;
  while (getline(&line, &line_cap, file) >= 0) {
    char kind[16] = {0}, phase[16] = {0};
    if (value_string(line, "\"kind\":\"", kind, sizeof(kind))
        && value_string(line, "\"phase\":\"", phase, sizeof(phase))
        && strcmp(kind, "FENCE") == 0 && strcmp(phase, "cut") == 0
        && value_u64(line, "\"fenceCut\":", &fence_cut)) {
      cut_seen = true;
      break;
    }
  }
  rewind(file);
  free(line);
  line = NULL;
  line_cap = 0;
  while (getline(&line, &line_cap, file) >= 0) {
    uint64_t sequence = 0, request = 0;
    char kind[16] = {0}, phase[16] = {0};
    if (!value_u64(line, "\"sequence\":", &sequence)
        || !value_u64(line, "\"request\":", &request)
        || !value_string(line, "\"kind\":\"", kind, sizeof(kind))
        || !value_string(line, "\"phase\":\"", phase, sizeof(phase))) {
      evidence.ordered = false;
      continue;
    }
    if (sequence <= last) evidence.ordered = false;
    last = sequence;
    if (strstr(line, "\"loggedBeforeReply\":false") != NULL) evidence.all_logged_before_reply = false;
    if (strcmp(kind, "BACKING") == 0 && strcmp(phase, "existing") == 0)
      evidence.restart_opened_existing = true;
    if (strcmp(kind, "FENCE") == 0 && strcmp(phase, "closed") == 0) evidence.fence_closed = true;
    if (strcmp(kind, "FENCE") == 0 && strcmp(phase, "cut") == 0
        && value_u64(line, "\"fenceCut\":", &fence_cut)) {
      evidence.control_fence_observed = true;
      evidence.fence_drained = strstr(line, "\"poststate\":\"complete\"") != NULL;
      designated_waiter_request = request;
      cut_seen = true;
    }
    if (strcmp(kind, "INTENT") == 0) {
      if (pending_intent != 0) evidence.intent_result_ordered = false;
      pending_intent = request;
      continue;
    }
    if (strcmp(kind, "RECOVERY") == 0 && strcmp(phase, "aborted-intent") == 0) {
      if (pending_intent != request) evidence.intent_result_ordered = false;
      pending_intent = 0;
      evidence.recovery_abort_durable = true;
      continue;
    }
    if (strcmp(kind, "RESULT") != 0) continue;
    if (pending_intent != request) evidence.intent_result_ordered = false;
    pending_intent = 0;
    uint64_t offset = 0, size = 0, actual = 0, operation_errno = 0;
    const char *payload = strstr(line, "\"payloadHex\":\"");
    if (!value_u64(line, "\"offset\":", &offset) || !value_u64(line, "\"size\":", &size)
        || !value_u64(line, "\"actualLength\":", &actual) || !value_u64(line, "\"errno\":", &operation_errno)
        || operation_errno != 0 || actual != size || payload == NULL || size > FILE_BYTES
        || offset + size > FILE_BYTES || strstr(line, "\"poststate\":\"written\"") == NULL) {
      evidence.ordered = false;
      continue;
    }
    if (strstr(line, "\"writeAdmissionClosed\":true") != NULL)
      evidence.no_writes_admitted_while_closed = false;
    payload += strlen("\"payloadHex\":\"");
    unsigned char bytes[FILE_BYTES];
    if (!decode_hex(payload, (size_t)size, bytes)) { evidence.ordered = false; continue; }
    const bool writes_continuous = offset <= 6 && size > 6 - offset && bytes[6 - offset] == 0x66;
    const bool writes_during_probe = offset <= 1 && size > 1 - offset && bytes[1 - offset] == 0x22;
    if (writes_continuous) {
      if (strcmp(phase, "pre") == 0) evidence.continuous_before_fence_closed = true;
      if (strcmp(phase, "post") == 0) evidence.continuous_after_fence_complete = true;
    }
    if (cut_seen && sequence > fence_cut && strcmp(phase, "post") == 0 && writes_during_probe) {
      evidence.post_write_after_cut = true;
      if (request == designated_waiter_request) evidence.designated_waiter_result_after_cut = true;
    }
    if (strcmp(phase, "post") == 0 && !cut_seen) evidence.post_before_completion = true;
    if (cut_seen && sequence <= fence_cut) memcpy(prefix + offset, bytes, (size_t)size);
    if (cut_seen && sequence > fence_cut && size > 0) {
      if (writes_during_probe) excluded_seen[0] = true;
      if (offset <= 2 && size > 2 - offset && bytes[2 - offset] == 0x33) excluded_seen[1] = true;
      if (offset <= 4 && size > 4 - offset && bytes[4 - offset] == 0x44) excluded_seen[2] = true;
      if (offset <= 5 && size > 5 - offset && bytes[5 - offset] == 0x55) excluded_seen[3] = true;
    }
  }
  free(line);
  fclose(file);
  evidence.pending_empty = pending_intent == 0;
  if (!evidence.pending_empty) evidence.intent_result_ordered = false;
  evidence.pre_prefix_included = cut_seen && prefix[0] == 0x11 && prefix[6] == 0x66;
  evidence.excluded_writes_absent_from_prefix = cut_seen && prefix[1] == 0 && prefix[2] == 0
    && prefix[4] == 0 && prefix[5] == 0 && excluded_seen[0] && excluded_seen[1]
    && excluded_seen[2] && excluded_seen[3];
  evidence.prefix_replay_ok = evidence.pre_prefix_included && evidence.excluded_writes_absent_from_prefix
    && evidence.intent_result_ordered;
  return evidence;
}

static bool wait_for_fence_closure(const char *events) {
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = 10 * 1000 * 1000 };
  for (int waited = 0; waited < FENCE_WAIT_MS; waited += 10) {
    if (inspect_event_log(events).fence_closed) return true;
    nanosleep(&pause, NULL);
  }
  return false;
}

static int timed_mapped_store(const char *program, const char *path, int offset,
                              unsigned char value, enum mutation mutation, bool *timed_out) {
  *timed_out = false;
  char offset_text[16], value_text[16];
  snprintf(offset_text, sizeof(offset_text), "%d", offset);
  snprintf(value_text, sizeof(value_text), "%u", value);
  const char *mutation_text = mutation == MUTATE_OMIT_MSYNC ? "omit-msync" : "none";
  const pid_t child = fork();
  if (child == 0) {
    char *const helper_argv[] = {
      (char *)program, "--mapped-store-helper", (char *)path, offset_text, value_text,
      (char *)mutation_text, NULL,
    };
    execv(program, helper_argv);
    _exit(127);
  }
  if (child < 0) return -1;
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = 10 * 1000 * 1000 };
  for (int waited = 0; waited < FENCE_WAIT_MS; waited += 10) {
    int status = 0;
    if (waitpid(child, &status, WNOHANG) == child)
      return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
    nanosleep(&pause, NULL);
  }
  *timed_out = true;
  kill(child, SIGKILL);
  waitpid(child, NULL, 0);
  return -1;
}

static bool bounded_reap(pid_t daemon, bool expect_sigkill, bool *bounded) {
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = 10 * 1000 * 1000 };
  int status = 0;
  for (int waited = 0; waited < FENCE_WAIT_MS; waited += 10) {
    if (waitpid(daemon, &status, WNOHANG) == daemon) {
      return expect_sigkill ? WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL
        : WIFEXITED(status) && WEXITSTATUS(status) == 0;
    }
    nanosleep(&pause, NULL);
  }
  *bounded = false;
  if (kill(daemon, SIGKILL) != 0 && errno != ESRCH) return false;
  for (int waited = 0; waited < FENCE_WAIT_MS; waited += 10) {
    if (waitpid(daemon, &status, WNOHANG) == daemon) return false;
    nanosleep(&pause, NULL);
  }
  return false;
}

static bool unmount_and_reap(const char *mountpoint, pid_t daemon, bool kill_before_detach,
                             bool *daemon_exit_ok, bool *detach_ok, bool *reap_bounded,
                             bool *killed_observed) {
  bool killed = false;
  if (kill_before_detach) {
    killed = kill(daemon, SIGKILL) == 0 || errno == ESRCH;
    if (killed_observed != NULL) *killed_observed = killed;
  }
  bool unmounted = false;
  bool detached = false;
  if (kill_before_detach) {
    detached = umount2(mountpoint, MNT_DETACH) == 0;
  } else {
    unmounted = umount2(mountpoint, 0) == 0;
    if (!unmounted) {
      (void)kill(daemon, SIGTERM);
      detached = umount2(mountpoint, MNT_DETACH) == 0;
    }
  }
  const bool reaped = bounded_reap(daemon, kill_before_detach, reap_bounded);
  *daemon_exit_ok = *daemon_exit_ok && reaped;
  if (kill_before_detach) *detach_ok = detached;
  return reaped && (unmounted || detached) && (!kill_before_detach || killed);
}

static bool mount_residue_absent(const char *root) {
  FILE *mounts = fopen("/proc/self/mountinfo", "r");
  if (mounts == NULL) return false;
  char *line = NULL;
  size_t capacity = 0;
  bool absent = true;
  while (getline(&line, &capacity, mounts) >= 0) {
    if (strstr(line, root) != NULL) {
      absent = false;
      break;
    }
  }
  free(line);
  fclose(mounts);
  return absent;
}

static bool backing_matches(const char *path) {
  unsigned char observed[7] = {0};
  const int fd = open(path, O_RDONLY);
  if (fd < 0) return false;
  const bool matches = pread(fd, observed, sizeof(observed), 0) == (ssize_t)sizeof(observed)
    && observed[0] == 0x11 && observed[1] == 0x22 && observed[2] == 0x33
    && observed[4] == 0x44 && observed[5] == 0x55 && observed[6] == 0x66;
  close(fd);
  return matches;
}
static void print_header_manifest(void) {
  FILE *file = fopen("/usr/local/share/fuse-mmap-header.json", "r");
  if (file == NULL) { fputs("null", stdout); return; }
  char bytes[1024];
  const size_t length = fread(bytes, 1, sizeof(bytes) - 1, file);
  fclose(file);
  bytes[length] = '\0';
  fputs(bytes, stdout);
}

static void json_bool(const char *name, bool value, bool comma) {
  printf("\"%s\":%s%s", name, value ? "true" : "false", comma ? "," : "");
}

int main(int argc, char **argv) {
  if (argc == 6 && strcmp(argv[1], "--mapped-store-helper") == 0) {
    const int offset = (int)strtol(argv[3], NULL, 10);
    const unsigned char value = (unsigned char)strtoul(argv[4], NULL, 10);
    const enum mutation helper_mutation = strcmp(argv[5], "omit-msync") == 0
      ? MUTATE_OMIT_MSYNC : MUTATE_NONE;
    return mapped_store(argv[2], offset, value, helper_mutation) == 0 ? 0 : 1;
  }
  const enum mutation mutation = parse_mutation(argc, argv);
  char root[] = "/tmp/fuse-mmap-probe.XXXXXX";
  if (mkdtemp(root) == NULL) return 2;
  char mountpoint[512], backing[512], events[512], control[512], data[1024];
  snprintf(mountpoint, sizeof(mountpoint), "%s/mnt", root);
  snprintf(backing, sizeof(backing), "%s/backing.bin", root);
  snprintf(events, sizeof(events), "%s/events.ndjson", root);
  snprintf(control, sizeof(control), "%s/fence.sock", root);
  snprintf(data, sizeof(data), "%s/data", mountpoint);
  const bool mountpoint_created = mkdir(mountpoint, 0700) == 0;

  pid_t first = mountpoint_created ? start_daemon(mountpoint, backing, events, control, mutation) : -1;
  bool mounted = first > 0;
  bool direct_mmap = false, pre_store = false, during_store = false, post_store = false;
  bool forked_mapper = false, continuous_dirtying = false, ordinary_writes = false;
  const bool msync_called = mutation != MUTATE_OMIT_MSYNC;
  bool control_fence_ok = false, fsync_ok = false, restart_ok = false, backing_order_ok = false;
  bool watchdog = false, fence_closed = false, fence_joined = false;
  bool final_unmount_ok = false, daemon_exit_ok = true, reap_bounded = true;
  bool restart_remount_read_ok = false, restart_daemon_killed = false, restart_dead_mount_detached = false;
  bool crash_cut_after_intent = false, pending_effect_excluded = false;
  bool intent_fsync_failure_refused = false, result_fsync_failure_refused = false;
  struct dirty_writer writer = { .path = data, .mutation = mutation, .running = false, .wrote = false };
  pthread_t dirty_thread;
  bool dirty_started = false;

  if (mounted) {
    const int probe = open(data, O_RDWR);
    if (probe >= 0) {
      void *map = mmap(NULL, FILE_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, probe, 0);
      direct_mmap = map != MAP_FAILED;
      if (map != MAP_FAILED) munmap(map, FILE_BYTES);
      close(probe);
    }
    pre_store = mapped_store(data, 0, 0x11, mutation) == 0;
    intent_fsync_failure_refused = mutation == MUTATE_INTENT_FSYNC_FAILURE && !pre_store;
    result_fsync_failure_refused = mutation == MUTATE_RESULT_FSYNC_FAILURE && !pre_store;
    if (pre_store) {
      const bool continuous_seed = mapped_store(data, 6, 0x66, mutation) == 0;
      atomic_store(&writer.running, continuous_seed);
      dirty_started = continuous_seed && pthread_create(&dirty_thread, NULL, continuously_dirty, &writer) == 0;
      if (!dirty_started) atomic_store(&writer.running, false);
      if (!dirty_started) {
        watchdog = true;
      } else {
        /* The kernel serializes direct-I/O writeback per inode: only one
         * writer to this single-page file can ever be in flight. The
         * continuous writer is paused before the fence closes so the
         * tagged during-fence write can reach admission uncontended and
         * become the daemon-observed blocked writer the fence waits on. */
        const struct timespec settle = { .tv_sec = 0, .tv_nsec = 20 * 1000 * 1000 };
        nanosleep(&settle, NULL);
        atomic_store(&writer.running, false);
        pthread_join(dirty_thread, NULL);
        continuous_dirtying = writer.wrote;
        dirty_started = false;
        struct control_call fence = { .path = control, .result = -1 };
        pthread_t fence_thread;
        const bool fence_started = pthread_create(&fence_thread, NULL, call_control_fence, &fence) == 0;
        fence_closed = fence_started && wait_for_fence_closure(events);
        bool store_timed_out = false;
        if (fence_closed) {
          during_store = timed_mapped_store(argv[0], data, 1, 0x22, mutation, &store_timed_out) == 0;
          watchdog = store_timed_out;
        } else {
          watchdog = true;
        }
        if (fence_started && !watchdog) {
          struct timespec deadline;
          clock_gettime(CLOCK_REALTIME, &deadline);
          deadline.tv_sec += FENCE_WAIT_MS / 1000;
          deadline.tv_nsec += (long)(FENCE_WAIT_MS % 1000) * 1000 * 1000;
          if (deadline.tv_nsec >= 1000 * 1000 * 1000) {
            deadline.tv_sec++;
            deadline.tv_nsec -= 1000 * 1000 * 1000;
          }
          if (pthread_timedjoin_np(fence_thread, NULL, &deadline) == 0) {
            fence_joined = true;
            control_fence_ok = fence.result == 0;
          } else {
            watchdog = true;
          }
        }
        if (fence_started && !fence_joined) pthread_join(fence_thread, NULL);
        if (control_fence_ok) {
          atomic_store(&writer.running, true);
          writer.wrote = false;
          dirty_started = pthread_create(&dirty_thread, NULL, continuously_dirty, &writer) == 0;
          if (!dirty_started) { atomic_store(&writer.running, false); watchdog = true; }
        }
      }
      if (dirty_started) {
        const struct timespec pause = { .tv_sec = 0, .tv_nsec = 20 * 1000 * 1000 };
        nanosleep(&pause, NULL);
        atomic_store(&writer.running, false);
        pthread_join(dirty_thread, NULL);
        continuous_dirtying = continuous_dirtying || writer.wrote;
      }
      if (!watchdog && control_fence_ok) {
        post_store = timed_mapped_store(argv[0], data, 2, 0x33, mutation, &(bool){ false }) == 0;
        bool mapper_timed_out = false;
        forked_mapper = timed_mapped_store(argv[0], data, 4, 0x44, mutation, &mapper_timed_out) == 0;
        watchdog = watchdog || mapper_timed_out;
        const int ordinary = open(data, O_RDWR);
        if (ordinary >= 0) {
          const unsigned char value = 0x55;
          ordinary_writes = pwrite(ordinary, &value, sizeof(value), 5) == (ssize_t)sizeof(value);
          close(ordinary);
        }
        const int verify = open(data, O_RDWR);
        if (verify >= 0) { fsync_ok = fsync(verify) == 0; close(verify); }
        bool crash_timed_out = false;
        crash_cut_after_intent = timed_mapped_store(argv[0], data, 7, 0x77, mutation, &crash_timed_out) != 0
          && !crash_timed_out;
      }
    }
    if (first > 0) {
      final_unmount_ok = unmount_and_reap(mountpoint, first, true, &daemon_exit_ok,
        &restart_dead_mount_detached, &reap_bounded, &restart_daemon_killed);
      first = -1;
    }
    backing_order_ok = !watchdog && backing_matches(backing);
    if (!watchdog && final_unmount_ok) {
      const pid_t second = start_daemon(mountpoint, backing, events, control, mutation);
      if (second > 0) {
        unsigned char observed[8] = {0};
        const int remounted = open(data, O_RDONLY);
        restart_remount_read_ok = remounted >= 0
          && pread(remounted, observed, sizeof(observed), 0) == (ssize_t)sizeof(observed)
          && observed[0] == 0x11 && observed[1] == 0x22 && observed[2] == 0x33
          && observed[4] == 0x44 && observed[5] == 0x55 && observed[6] == 0x66;
        pending_effect_excluded = restart_remount_read_ok && observed[7] == 0;
        if (remounted >= 0) close(remounted);
        const bool second_unmount_ok = unmount_and_reap(mountpoint, second, false, &daemon_exit_ok,
          &restart_dead_mount_detached, &reap_bounded, NULL);
        final_unmount_ok = final_unmount_ok && second_unmount_ok;
        restart_ok = backing_order_ok && restart_remount_read_ok && second_unmount_ok;
      }
    }
  }
  const struct log_evidence log = inspect_event_log(events);
  watchdog = watchdog || (mounted && pre_store && (!control_fence_ok || !log.control_fence_observed));
  const bool intent_journal_durable = mutation != MUTATE_INTENT_FSYNC_FAILURE
    && log.intent_result_ordered && log.all_logged_before_reply;
  const bool result_journal_durable = mutation != MUTATE_RESULT_FSYNC_FAILURE
    && log.intent_result_ordered && log.all_logged_before_reply;
  const bool restart_truncation_refused = mutation == MUTATE_RESTART_TRUNCATION && !restart_remount_read_ok;
  const bool restart_journal_reconciled = log.restart_opened_existing && log.ordered
    && log.intent_result_ordered && log.pending_empty && log.recovery_abort_durable;
  const bool mount_residue = mount_residue_absent(root);
  const bool removed_backing = unlink(backing) == 0 || errno == ENOENT;
  const bool removed_events = unlink(events) == 0 || errno == ENOENT;
  const bool removed_control = unlink(control) == 0 || errno == ENOENT;
  const bool removed_mountpoint = rmdir(mountpoint) == 0 || errno == ENOENT;
  const bool removed_root = rmdir(root) == 0 || errno == ENOENT;
  const bool cleanup_paths_removed = removed_backing && removed_events && removed_control
    && removed_mountpoint && removed_root;
  const bool path_residue_absent = access(root, F_OK) != 0 && errno == ENOENT;
  const bool invariants = mounted && direct_mmap && pre_store && during_store && post_store
    && forked_mapper && continuous_dirtying && ordinary_writes && msync_called
    && fence_closed && log.fence_drained && log.post_write_after_cut
    && log.designated_waiter_result_after_cut && log.prefix_replay_ok
    && control_fence_ok && fsync_ok && restart_ok && backing_order_ok && log.ordered
    && intent_journal_durable && result_journal_durable && log.continuous_before_fence_closed
    && log.continuous_after_fence_complete && log.no_writes_admitted_while_closed
    && log.restart_opened_existing && restart_daemon_killed && restart_dead_mount_detached
    && restart_journal_reconciled && crash_cut_after_intent && log.pending_empty
    && log.recovery_abort_durable && pending_effect_excluded && final_unmount_ok
    && daemon_exit_ok && reap_bounded && cleanup_paths_removed && mount_residue && path_residue_absent
    && log.all_logged_before_reply && !log.post_before_completion && !watchdog
    && mutation == MUTATE_NONE;
  printf("{\"stage\":\"stage3\",\"protocol\":{\"requested\":\"7.39\",\"kernelHeader\":");
  print_header_manifest();
  printf("},\"mutation\":\"%s\",", mutation_name(mutation));
  json_bool("mounted", mounted, true);
  json_bool("directIoMmap", direct_mmap, true);
  json_bool("preStore", pre_store, true);
  json_bool("duringStore", during_store, true);
  json_bool("postStore", post_store, true);
  json_bool("forkedMapper", forked_mapper, true);
  json_bool("continuousDirtying", continuous_dirtying, true);
  json_bool("continuousDirtyBeforeFenceClosed", log.continuous_before_fence_closed, true);
  json_bool("continuousDirtyAfterFenceComplete", log.continuous_after_fence_complete, true);
  json_bool("ordinaryWrites", ordinary_writes, true);
  json_bool("msyncCalled", msync_called, true);
  json_bool("controlFenceOk", control_fence_ok, true);
  json_bool("fsyncOk", fsync_ok, true);
  json_bool("intentJournalDurable", intent_journal_durable, true);
  json_bool("resultJournalDurable", result_journal_durable, true);
  json_bool("intentFsyncFailureRefused", intent_fsync_failure_refused, true);
  json_bool("resultFsyncFailureRefused", result_fsync_failure_refused, true);
  json_bool("restartRemountOk", restart_ok, true);
  json_bool("restartOpenedExistingBacking", log.restart_opened_existing, true);
  json_bool("restartRemountReadOk", restart_remount_read_ok, true);
  json_bool("restartTruncationRefused", restart_truncation_refused, true);
  json_bool("restartDaemonKilled", restart_daemon_killed, true);
  json_bool("restartDeadMountDetached", restart_dead_mount_detached, true);
  json_bool("restartJournalReconciled", restart_journal_reconciled, true);
  json_bool("backingOrderOk", backing_order_ok, true);
  json_bool("fenceClosed", fence_closed && log.fence_closed, true);
  json_bool("fenceDrained", log.fence_drained, true);
  json_bool("crashCutAfterIntent", crash_cut_after_intent, true);
  json_bool("journalPendingEmpty", log.pending_empty, true);
  json_bool("recoveryAbortDurable", log.recovery_abort_durable, true);
  json_bool("pendingEffectExcluded", pending_effect_excluded, true);
  json_bool("postWriteAfterFenceCut", log.post_write_after_cut, true);
  json_bool("designatedWaiterResultAfterFenceCut", log.designated_waiter_result_after_cut, true);
  json_bool("noWritesAdmittedWhileClosed", log.no_writes_admitted_while_closed, true);
  json_bool("prefixReplayOk", log.prefix_replay_ok, true);
  json_bool("prePrefixIncluded", log.pre_prefix_included, true);
  json_bool("excludedWritesAbsentFromPrefix", log.excluded_writes_absent_from_prefix, true);
  json_bool("finalBackingAllWrites", backing_order_ok, true);
  json_bool("requestLoopServedAfterFence", log.post_write_after_cut && !log.post_before_completion, true);
  json_bool("orderedLog", log.ordered, true);
  json_bool("loggedBeforeReply", log.all_logged_before_reply, true);
  json_bool("controlFenceObserved", log.control_fence_observed, true);
  json_bool("postFenceBeforeCompletion", log.post_before_completion, true);
  json_bool("watchdogDeadlock", watchdog, true);
  json_bool("finalUnmountOk", final_unmount_ok, true);
  json_bool("daemonExitOk", daemon_exit_ok, true);
  json_bool("reapBounded", reap_bounded, true);
  json_bool("cleanupPathsRemoved", cleanup_paths_removed, true);
  json_bool("mountResidueAbsent", mount_residue, true);
  json_bool("pathResidueAbsent", path_residue_absent, true);
  json_bool("linearizable", invariants, false);
  puts("}");
  return invariants ? 0 : 86;
}
