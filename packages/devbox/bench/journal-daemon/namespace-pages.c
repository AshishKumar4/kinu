#define _GNU_SOURCE
#include "namespace-pages.h"
#include "journal-delta.h"

#include <errno.h>
#include <fcntl.h>
#include <openssl/sha.h>
#include <sqlite3.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

struct dirty_page { uint32_t number; uint64_t revision; };
struct tracked_file;
struct namespace_pages {
  sqlite3_vfs vfs;
  sqlite3_vfs *platform;
  struct tracked_file *main;
  char name[64];
  char *database;
  int directory;
  int journal;
  int owner;
  uint64_t revision;
  uint64_t captured_cut;
  uint64_t captured_revision;
  bool captured;
  struct dirty_page *dirty;
  size_t count;
  size_t capacity;
  /* A lazily attached image: pages arrive from the sidecar's page socket the
   * first time SQLite reads them. `present` is one byte per page, on disk. */
  bool attached;
  uint64_t attached_bytes;
  char socket_path[108];
  int present;
  int fetch_fd;
  uint64_t fetches;
};
struct tracked_file {
  sqlite3_file file;
  sqlite3_file *inner;
  struct namespace_pages *owner;
  bool tracked;
  max_align_t storage[];
};

static _Atomic unsigned long next_vfs = 1;
static const char journal_name[] = "namespace-pages.log";
static const char capture_name[] = "namespace-capture";
static const char attach_name[] = "namespace-attach";
static const char present_name[] = "namespace-present.bits";
static int load_attach(struct namespace_pages *pages);


#define JOURNAL_HEADER_BYTES 48
#define DIRTY_RECORD_BYTES 44

static void seal_record(unsigned char *record, size_t payload) {
  SHA256(record, payload, record + payload);
}
static bool record_valid(const unsigned char *record, size_t payload) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(record, payload, digest);
  return memcmp(digest, record + payload, sizeof(digest)) == 0;
}
static void put32(unsigned char *out, uint32_t value) {
  for (unsigned at = 0; at < 4; at++) out[at] = (unsigned char)(value >> (at * 8));
}
static void put64(unsigned char *out, uint64_t value) {
  for (unsigned at = 0; at < 8; at++) out[at] = (unsigned char)(value >> (at * 8));
}
static uint32_t get32(const unsigned char *in) {
  uint32_t value = 0;
  for (unsigned at = 0; at < 4; at++) value |= (uint32_t)in[at] << (at * 8);
  return value;
}
static uint64_t get64(const unsigned char *in) {
  uint64_t value = 0;
  for (unsigned at = 0; at < 8; at++) value |= (uint64_t)in[at] << (at * 8);
  return value;
}
static int append(int fd, const void *bytes, size_t length) {
  const unsigned char *cursor = bytes;
  while (length > 0) {
    ssize_t wrote = write(fd, cursor, length);
    if (wrote < 0) { if (errno == EINTR) continue; return -errno; }
    if (wrote == 0) return -EIO;
    cursor += wrote;
    length -= (size_t)wrote;
  }
  return 0;
}
static size_t slot(uint32_t number, size_t capacity) {
  return ((uint64_t)number * 11400714819323198485ULL) & (capacity - 1);
}
static struct dirty_page *find(struct namespace_pages *pages, uint32_t number) {
  if (pages->capacity == 0) return NULL;
  size_t at = slot(number, pages->capacity);
  while (pages->dirty[at].number != 0 && pages->dirty[at].number != number) at = (at + 1) & (pages->capacity - 1);
  return &pages->dirty[at];
}
static int remember(struct namespace_pages *pages, uint32_t number, uint64_t revision) {
  if (number == 0) return -EINVAL;
  struct dirty_page *held = find(pages, number);
  if (held != NULL && held->number == number) { held->revision = revision; return 0; }
  if (pages->count * 2 >= pages->capacity) {
    size_t capacity = pages->capacity == 0 ? 16 : pages->capacity * 2;
    if (capacity < pages->capacity || capacity > SIZE_MAX / sizeof(*pages->dirty)) return -ENOMEM;
    struct dirty_page *grown = calloc(capacity, sizeof(*grown));
    if (grown == NULL) return -ENOMEM;
    for (size_t index = 0; index < pages->capacity; index++) {
      struct dirty_page entry = pages->dirty[index];
      if (entry.number == 0) continue;
      size_t at = slot(entry.number, capacity);
      while (grown[at].number != 0) at = (at + 1) & (capacity - 1);
      grown[at] = entry;
    }
    free(pages->dirty);
    pages->dirty = grown;
    pages->capacity = capacity;
    held = find(pages, number);
  }
  held->number = number;
  held->revision = revision;
  pages->count++;
  return 0;
}

/* A dirty record reaches the local journal before its main-file write. */
static int mark(struct namespace_pages *pages, sqlite3_int64 offset, int amount) {
  if (offset < 0 || amount < 0 || offset > INT64_MAX - amount) return SQLITE_IOERR_WRITE;
  if (amount == 0) return SQLITE_OK;
  uint64_t first = (uint64_t)offset / NAMESPACE_PAGE_BYTES + 1;
  uint64_t last = ((uint64_t)offset + (unsigned)amount - 1) / NAMESPACE_PAGE_BYTES + 1;
  if (last > UINT32_MAX) return SQLITE_FULL;
  for (uint64_t number = first; number <= last; number++) {
    if (pages->revision == UINT64_MAX) return SQLITE_FULL;
    uint64_t revision = ++pages->revision;
    int rc = remember(pages, (uint32_t)number, revision);
    if (rc != 0) return SQLITE_NOMEM;
    unsigned char record[DIRTY_RECORD_BYTES];
    put32(record, (uint32_t)number);
    put64(record + 4, revision);
    seal_record(record, 12);
    if (append(pages->journal, record, sizeof(record)) != 0) return SQLITE_IOERR_WRITE;
  }
  return SQLITE_OK;
}

static struct tracked_file *tracked(sqlite3_file *file) { return (struct tracked_file *)file; }
static int io_close(sqlite3_file *file) {
  struct tracked_file *f = tracked(file);
  if (f->owner->main == f) f->owner->main = NULL;
  return f->inner->pMethods->xClose(f->inner);
}

static int read_line(int fd, char *line, size_t cap) {
  size_t used = 0;
  while (used + 1 < cap) {
    ssize_t got = read(fd, line + used, 1);
    if (got < 0) { if (errno == EINTR) continue; return -errno; }
    if (got == 0) return -ECONNRESET;
    if (line[used] == '\n') { line[used] = '\0'; return 0; }
    used++;
  }
  return -EMSGSIZE;
}

static int read_full(int fd, void *buffer, size_t length) {
  unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t got = read(fd, cursor, length);
    if (got < 0) { if (errno == EINTR) continue; return -errno; }
    if (got == 0) return -ECONNRESET;
    cursor += got; length -= (size_t)got;
  }
  return 0;
}

/* One page from the sidecar: `page N` in, `ok` and the bytes back. The
 * connection stays open across pages; a failure closes it and the next page
 * connects again. */
static int fetch_page(struct namespace_pages *pages, uint32_t number, unsigned char out[NAMESPACE_PAGE_BYTES]) {
  int rc = 0;
  /* A connection that dropped gets one fresh attempt; a refusal is final. */
  for (int attempt = 0; attempt < 2; attempt++) {
    if (pages->fetch_fd < 0) {
      int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
      if (fd < 0) return -errno;
      struct sockaddr_un address = { .sun_family = AF_UNIX };
      memcpy(address.sun_path, pages->socket_path, sizeof(address.sun_path));
      if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { rc = -errno; close(fd); return rc; }
      pages->fetch_fd = fd;
    }
    char request[32];
    int length = snprintf(request, sizeof(request), "page %u\n", number);
    rc = append(pages->fetch_fd, request, (size_t)length);
    char line[512];
    if (rc == 0) rc = read_line(pages->fetch_fd, line, sizeof(line));
    if (rc == 0 && strcmp(line, "ok") == 0) rc = read_full(pages->fetch_fd, out, NAMESPACE_PAGE_BYTES);
    else if (rc == 0) {
      fprintf(stderr, "namespace.fetch_refused page=%u detail=%s\n", number, line);
      rc = -EIO;
    }
    if (rc == 0) { pages->fetches++; return 0; }
    close(pages->fetch_fd);
    pages->fetch_fd = -1;
    if (rc != -ECONNRESET) return rc;
  }
  return rc;
}

static int present_flag(struct namespace_pages *pages, uint32_t number, unsigned char *flag) {
  ssize_t got = pread(pages->present, flag, 1, (off_t)number - 1);
  if (got < 0) return -errno;
  if (got == 0) *flag = 0;
  return 0;
}

/* Make every page the range touches local before SQLite reads it. A page
 * lands through the inner file, so the write tracker never sees it. */
static int ensure_present(struct namespace_pages *pages, sqlite3_int64 offset, int amount) {
  if (!pages->attached || amount <= 0 || pages->main == NULL) return SQLITE_OK;
  uint64_t first = (uint64_t)offset / NAMESPACE_PAGE_BYTES + 1;
  uint64_t last = ((uint64_t)offset + (unsigned)amount - 1) / NAMESPACE_PAGE_BYTES + 1;
  for (uint64_t number = first; number <= last && number * NAMESPACE_PAGE_BYTES <= pages->attached_bytes; number++) {
    unsigned char flag = 0;
    int rc = present_flag(pages, (uint32_t)number, &flag);
    if (rc != 0) { fprintf(stderr, "namespace.present_failed page=%u code=%d\n", (unsigned)number, rc); return SQLITE_IOERR_READ; }
    if (flag != 0) continue;
    unsigned char bytes[NAMESPACE_PAGE_BYTES];
    rc = fetch_page(pages, (uint32_t)number, bytes);
    if (rc != 0) { fprintf(stderr, "namespace.fetch_failed page=%u code=%d\n", (unsigned)number, rc); return SQLITE_IOERR_READ; }
    sqlite3_file *inner = pages->main->inner;
    rc = inner->pMethods->xWrite(inner, bytes, NAMESPACE_PAGE_BYTES, (sqlite3_int64)(number - 1) * NAMESPACE_PAGE_BYTES);
    if (rc != SQLITE_OK) { fprintf(stderr, "namespace.land_failed page=%u sqlite=%d\n", (unsigned)number, rc); return rc; }
    flag = 1;
    if (pwrite(pages->present, &flag, 1, (off_t)number - 1) != 1) return SQLITE_IOERR_WRITE;
  }
  return SQLITE_OK;
}

static int mark_present(struct namespace_pages *pages, sqlite3_int64 offset, int amount) {
  if (!pages->attached || amount <= 0) return SQLITE_OK;
  uint64_t first = (uint64_t)offset / NAMESPACE_PAGE_BYTES + 1;
  uint64_t last = ((uint64_t)offset + (unsigned)amount - 1) / NAMESPACE_PAGE_BYTES + 1;
  bool whole = (uint64_t)offset % NAMESPACE_PAGE_BYTES == 0 && (unsigned)amount % NAMESPACE_PAGE_BYTES == 0;
  if (!whole) return ensure_present(pages, offset, amount);
  for (uint64_t number = first; number <= last && number * NAMESPACE_PAGE_BYTES <= pages->attached_bytes; number++) {
    unsigned char flag = 1;
    if (pwrite(pages->present, &flag, 1, (off_t)number - 1) != 1) return SQLITE_IOERR_WRITE;
  }
  return SQLITE_OK;
}
static int io_read(sqlite3_file *file, void *buffer, int amount, sqlite3_int64 offset) {
  struct tracked_file *f = tracked(file);
  if (f->tracked) {
    int rc = ensure_present(f->owner, offset, amount);
    if (rc != SQLITE_OK) return rc;
  }
  return f->inner->pMethods->xRead(f->inner, buffer, amount, offset);
}
static int io_write(sqlite3_file *file, const void *buffer, int amount, sqlite3_int64 offset) {
  struct tracked_file *f = tracked(file);
  int rc = f->tracked ? mark_present(f->owner, offset, amount) : SQLITE_OK;
  if (rc == SQLITE_OK && f->tracked) rc = mark(f->owner, offset, amount);
  return rc == SQLITE_OK ? f->inner->pMethods->xWrite(f->inner, buffer, amount, offset) : rc;
}
static int io_truncate(sqlite3_file *file, sqlite3_int64 size) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xTruncate(f->inner, size);
}
static int io_sync(sqlite3_file *file, int flags) {
  struct tracked_file *f = tracked(file);
  if (f->tracked && fsync(f->owner->journal) != 0) return SQLITE_IOERR_FSYNC;
  return f->inner->pMethods->xSync(f->inner, flags);
}
static int io_size(sqlite3_file *file, sqlite3_int64 *size) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xFileSize(f->inner, size);
}
static int io_lock(sqlite3_file *file, int lock) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xLock(f->inner, lock);
}
static int io_unlock(sqlite3_file *file, int lock) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xUnlock(f->inner, lock);
}
static int io_reserved(sqlite3_file *file, int *reserved) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xCheckReservedLock(f->inner, reserved);
}
static int io_control(sqlite3_file *file, int operation, void *argument) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xFileControl(f->inner, operation, argument);
}
static int io_sector(sqlite3_file *file) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xSectorSize(f->inner);
}
static int io_characteristics(sqlite3_file *file) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xDeviceCharacteristics(f->inner);
}
static int io_shm_map(sqlite3_file *file, int page, int size, int extend, void volatile **out) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xShmMap(f->inner, page, size, extend, out);
}
static int io_shm_lock(sqlite3_file *file, int offset, int count, int flags) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xShmLock(f->inner, offset, count, flags);
}
static void io_shm_barrier(sqlite3_file *file) {
  struct tracked_file *f = tracked(file);
  f->inner->pMethods->xShmBarrier(f->inner);
}
static int io_shm_unmap(sqlite3_file *file, int remove) {
  struct tracked_file *f = tracked(file);
  return f->inner->pMethods->xShmUnmap(f->inner, remove);
}
/* Version 2 routes reads through xRead instead of mmap/xFetch. */
static const sqlite3_io_methods methods = {
  .iVersion = 2, .xClose = io_close, .xRead = io_read, .xWrite = io_write,
  .xTruncate = io_truncate, .xSync = io_sync, .xFileSize = io_size,
  .xLock = io_lock, .xUnlock = io_unlock, .xCheckReservedLock = io_reserved,
  .xFileControl = io_control, .xSectorSize = io_sector, .xDeviceCharacteristics = io_characteristics,
  .xShmMap = io_shm_map, .xShmLock = io_shm_lock, .xShmBarrier = io_shm_barrier, .xShmUnmap = io_shm_unmap,
};

static struct namespace_pages *owner(sqlite3_vfs *vfs) { return vfs->pAppData; }
static int vfs_open(sqlite3_vfs *vfs, const char *name, sqlite3_file *file, int flags, int *out_flags) {
  struct namespace_pages *pages = owner(vfs);
  struct tracked_file *f = tracked(file);
  memset(f, 0, sizeof(*f));
  f->inner = (sqlite3_file *)f->storage;
  f->owner = pages;
  int rc = pages->platform->xOpen(pages->platform, name, f->inner, flags, out_flags);
  if (f->inner->pMethods != NULL) f->file.pMethods = &methods;
  if (rc == SQLITE_OK && name != NULL && (flags & SQLITE_OPEN_MAIN_DB) != 0 && strcmp(name, pages->database) == 0) {
    if (f->inner->pMethods->iVersion < 2) return SQLITE_CANTOPEN;
    if (pages->main != NULL) return SQLITE_BUSY;
    f->tracked = true;
    pages->main = f;
  }
  return rc;
}
static int vfs_delete(sqlite3_vfs *vfs, const char *name, int sync) { sqlite3_vfs *p = owner(vfs)->platform; return p->xDelete(p, name, sync); }
static int vfs_access(sqlite3_vfs *vfs, const char *name, int flags, int *out) { sqlite3_vfs *p = owner(vfs)->platform; return p->xAccess(p, name, flags, out); }
static int vfs_path(sqlite3_vfs *vfs, const char *name, int length, char *out) { sqlite3_vfs *p = owner(vfs)->platform; return p->xFullPathname(p, name, length, out); }
static void *vfs_dl_open(sqlite3_vfs *vfs, const char *name) { sqlite3_vfs *p = owner(vfs)->platform; return p->xDlOpen(p, name); }
static void vfs_dl_error(sqlite3_vfs *vfs, int length, char *out) { sqlite3_vfs *p = owner(vfs)->platform; p->xDlError(p, length, out); }
static void (*vfs_dl_sym(sqlite3_vfs *vfs, void *handle, const char *name))(void) { sqlite3_vfs *p = owner(vfs)->platform; return p->xDlSym(p, handle, name); }
static void vfs_dl_close(sqlite3_vfs *vfs, void *handle) { sqlite3_vfs *p = owner(vfs)->platform; p->xDlClose(p, handle); }
static int vfs_random(sqlite3_vfs *vfs, int size, char *out) { sqlite3_vfs *p = owner(vfs)->platform; return p->xRandomness(p, size, out); }
static int vfs_sleep(sqlite3_vfs *vfs, int microseconds) { sqlite3_vfs *p = owner(vfs)->platform; return p->xSleep(p, microseconds); }
static int vfs_time(sqlite3_vfs *vfs, double *out) { sqlite3_vfs *p = owner(vfs)->platform; return p->xCurrentTime(p, out); }
static int vfs_error(sqlite3_vfs *vfs, int size, char *out) { sqlite3_vfs *p = owner(vfs)->platform; return p->xGetLastError == NULL ? 0 : p->xGetLastError(p, size, out); }
static int vfs_time64(sqlite3_vfs *vfs, sqlite3_int64 *out) { sqlite3_vfs *p = owner(vfs)->platform; return p->xCurrentTimeInt64(p, out); }

static int read_exact(int fd, void *buffer, size_t length, off_t offset) {
  unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t got = pread(fd, cursor, length, offset);
    if (got < 0) { if (errno == EINTR) continue; return -errno; }
    if (got == 0) return -EUCLEAN;
    cursor += got; length -= (size_t)got; offset += got;
  }
  return 0;
}
static void journal_header(unsigned char out[JOURNAL_HEADER_BYTES], uint64_t revision) {
  memset(out, 0, JOURNAL_HEADER_BYTES); memcpy(out, "KNP2", 4); put64(out + 8, revision); seal_record(out, 16);
}
static int load_journal(struct namespace_pages *pages) {
  struct stat st;
  if (fstat(pages->journal, &st) != 0) return -errno;
  if (st.st_size == 0) {
    unsigned char header[JOURNAL_HEADER_BYTES]; journal_header(header, 0);
    return append(pages->journal, header, sizeof(header));
  }
  if (st.st_size < JOURNAL_HEADER_BYTES || (st.st_size - JOURNAL_HEADER_BYTES) % DIRTY_RECORD_BYTES != 0) return -EUCLEAN;
  unsigned char header[JOURNAL_HEADER_BYTES];
  int rc = read_exact(pages->journal, header, sizeof(header), 0);
  if (rc != 0) return rc;
  if (memcmp(header, "KNP2", 4) != 0 || !record_valid(header, 16)) return -EUCLEAN;
  pages->revision = get64(header + 8);
  for (off_t offset = JOURNAL_HEADER_BYTES; offset < st.st_size; offset += DIRTY_RECORD_BYTES) {
    unsigned char record[DIRTY_RECORD_BYTES];
    rc = read_exact(pages->journal, record, sizeof(record), offset);
    if (rc != 0) return rc;
    if (!record_valid(record, 12)) return -EUCLEAN;
    uint64_t revision = get64(record + 4);
    rc = remember(pages, get32(record), revision);
    if (rc != 0) return rc;
    if (revision > pages->revision) pages->revision = revision;
  }
  return 0;
}
static int atomic_file(struct namespace_pages *pages, const char *name, const void *bytes, size_t length) {
  char temporary[128];
  int size = snprintf(temporary, sizeof(temporary), "%s.tmp", name);
  if (size < 0 || (size_t)size >= sizeof(temporary)) return -ENAMETOOLONG;
  int fd = openat(pages->directory, temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return -errno;
  int rc = append(fd, bytes, length);
  if (rc == 0 && fsync(fd) != 0) rc = -errno;
  close(fd);
  if (rc == 0 && renameat(pages->directory, temporary, pages->directory, name) != 0) rc = -errno;
  if (rc == 0 && fsync(pages->directory) != 0) rc = -errno;
  return rc;
}

int namespace_pages_open(const char *database_path, const char *state_path, struct namespace_pages **out) {
  struct namespace_pages *pages = calloc(1, sizeof(*pages));
  if (pages == NULL) return -ENOMEM;
  pages->directory = pages->journal = pages->owner = pages->present = pages->fetch_fd = -1;
  pages->platform = sqlite3_vfs_find(NULL);
  if (pages->platform == NULL || pages->platform->iVersion < 2) { namespace_pages_close(pages); return -EOPNOTSUPP; }
  pages->database = malloc((size_t)pages->platform->mxPathname + 1);
  if (pages->database == NULL) { namespace_pages_close(pages); return -ENOMEM; }
  int rc = pages->platform->xFullPathname(pages->platform, database_path, pages->platform->mxPathname + 1, pages->database);
  if (rc != SQLITE_OK) { namespace_pages_close(pages); return -EINVAL; }
  pages->directory = open(state_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (pages->directory < 0) { rc = -errno; namespace_pages_close(pages); return rc; }
  pages->owner = openat(pages->directory, "namespace-owner.lock", O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (pages->owner < 0 || flock(pages->owner, LOCK_EX | LOCK_NB) != 0) { rc = -errno; namespace_pages_close(pages); return rc; }
  pages->journal = openat(pages->directory, journal_name, O_RDWR | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (pages->journal < 0) { rc = -errno; namespace_pages_close(pages); return rc; }
  rc = load_journal(pages);
  if (rc != 0) { namespace_pages_close(pages); return rc; }
  int captured = openat(pages->directory, capture_name, O_RDONLY | O_CLOEXEC);
  if (captured >= 0) {
    unsigned char record[48];
    struct stat st;
    rc = fstat(captured, &st) == 0 ? 0 : -errno;
    if (rc == 0 && st.st_size != (off_t)sizeof(record)) rc = -EUCLEAN;
    if (rc == 0) rc = read_exact(captured, record, sizeof(record), 0);
    close(captured);
    if (rc == 0 && (!record_valid(record, 16) || get64(record + 8) > pages->revision)) rc = -EUCLEAN;
    if (rc == 0) { pages->captured_cut = get64(record); pages->captured_revision = get64(record + 8); pages->captured = true; }
  } else if (errno != ENOENT) rc = -errno;
  if (rc != 0) { namespace_pages_close(pages); return rc; }
  snprintf(pages->name, sizeof(pages->name), "kinu-namespace-%lu", atomic_fetch_add(&next_vfs, 1));
  pages->vfs = (sqlite3_vfs){
    .iVersion = 2, .szOsFile = (int)sizeof(struct tracked_file) + pages->platform->szOsFile,
    .mxPathname = pages->platform->mxPathname, .zName = pages->name, .pAppData = pages,
    .xOpen = vfs_open, .xDelete = vfs_delete, .xAccess = vfs_access, .xFullPathname = vfs_path,
    .xDlOpen = vfs_dl_open, .xDlError = vfs_dl_error, .xDlSym = vfs_dl_sym, .xDlClose = vfs_dl_close,
    .xRandomness = vfs_random, .xSleep = vfs_sleep, .xCurrentTime = vfs_time, .xGetLastError = vfs_error,
    .xCurrentTimeInt64 = vfs_time64,
  };
  rc = load_attach(pages);
  if (rc != 0) { namespace_pages_close(pages); return rc; }
  if (sqlite3_vfs_register(&pages->vfs, 0) != SQLITE_OK) { namespace_pages_close(pages); return -EIO; }
  *out = pages;
  return 0;
}
const char *namespace_pages_vfs(struct namespace_pages *pages) { return pages->name; }
void namespace_pages_close(struct namespace_pages *pages) {
  if (pages == NULL) return;
  if (pages->vfs.zName != NULL) sqlite3_vfs_unregister(&pages->vfs);
  if (pages->journal >= 0) close(pages->journal);
  if (pages->owner >= 0) close(pages->owner);
  if (pages->present >= 0) close(pages->present);
  if (pages->fetch_fd >= 0) close(pages->fetch_fd);
  if (pages->directory >= 0) close(pages->directory);
  free(pages->database); free(pages->dirty); free(pages);
}
uint64_t namespace_pages_fetches(const struct namespace_pages *pages) { return pages->fetches; }

/* The attach record: magic, image length, socket path; sealed like the rest. */
#define ATTACH_RECORD_BYTES (4 + 8 + 108 + 32)

static int load_attach(struct namespace_pages *pages) {
  int fd = openat(pages->directory, attach_name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? 0 : -errno;
  unsigned char record[ATTACH_RECORD_BYTES];
  struct stat st;
  int rc = fstat(fd, &st) == 0 ? 0 : -errno;
  if (rc == 0 && st.st_size != (off_t)sizeof(record)) rc = -EUCLEAN;
  if (rc == 0) rc = read_exact(fd, record, sizeof(record), 0);
  close(fd);
  if (rc != 0) return rc;
  if (memcmp(record, "KNA1", 4) != 0 || !record_valid(record, 4 + 8 + 108)) return -EUCLEAN;
  uint64_t bytes = get64(record + 4);
  if (bytes == 0 || bytes % NAMESPACE_PAGE_BYTES != 0 || record[4 + 8 + 107] != 0) return -EUCLEAN;
  pages->present = openat(pages->directory, present_name, O_RDWR | O_CLOEXEC);
  if (pages->present < 0) return -errno;
  memcpy(pages->socket_path, record + 12, sizeof(pages->socket_path));
  pages->attached_bytes = bytes;
  pages->attached = true;
  return 0;
}

/* Start over as the published image: the local database, its WAL and the
 * page journal go, a sparse file of the image's length takes their place,
 * and every page is absent until a read asks for it. The caller has closed
 * SQLite and opens it again afterwards. */
int namespace_pages_attach(struct namespace_pages *pages, const char *socket_path, uint64_t byte_length) {
  if (pages->main != NULL) return -EBUSY;
  if (byte_length == 0 || byte_length % NAMESPACE_PAGE_BYTES != 0 || byte_length / NAMESPACE_PAGE_BYTES > UINT32_MAX) return -EINVAL;
  if (strlen(socket_path) >= sizeof(pages->socket_path)) return -ENAMETOOLONG;
  const char *base = strrchr(pages->database, '/');
  base = base == NULL ? pages->database : base + 1;
  char wal[256], shm[256];
  if (snprintf(wal, sizeof(wal), "%s-wal", base) >= (int)sizeof(wal) || snprintf(shm, sizeof(shm), "%s-shm", base) >= (int)sizeof(shm)) return -ENAMETOOLONG;
  const char *gone[] = { base, wal, shm, journal_name, capture_name, attach_name, present_name };
  for (size_t at = 0; at < sizeof(gone) / sizeof(gone[0]); at++) {
    if (unlinkat(pages->directory, gone[at], 0) != 0 && errno != ENOENT) return -errno;
  }
  if (pages->present >= 0) { close(pages->present); pages->present = -1; }
  if (pages->fetch_fd >= 0) { close(pages->fetch_fd); pages->fetch_fd = -1; }
  free(pages->dirty); pages->dirty = NULL; pages->count = pages->capacity = 0;
  pages->revision = 0; pages->captured = false; pages->captured_cut = pages->captured_revision = 0;
  pages->attached = false;
  int database = openat(pages->directory, base, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (database < 0) return -errno;
  int rc = ftruncate(database, (off_t)byte_length) == 0 ? 0 : -errno;
  if (rc == 0 && fsync(database) != 0) rc = -errno;
  close(database);
  if (rc != 0) return rc;
  pages->present = openat(pages->directory, present_name, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (pages->present < 0) return -errno;
  if (ftruncate(pages->present, (off_t)(byte_length / NAMESPACE_PAGE_BYTES)) != 0) return -errno;
  if (fsync(pages->present) != 0) return -errno;
  int next = openat(pages->directory, journal_name, O_RDWR | O_CREAT | O_EXCL | O_APPEND | O_CLOEXEC, 0600);
  if (next < 0) return -errno;
  close(pages->journal); pages->journal = next;
  rc = load_journal(pages);
  if (rc != 0) return rc;
  unsigned char record[ATTACH_RECORD_BYTES];
  memset(record, 0, sizeof(record));
  memcpy(record, "KNA1", 4);
  put64(record + 4, byte_length);
  memcpy(record + 12, socket_path, strlen(socket_path));
  seal_record(record, 4 + 8 + 108);
  rc = atomic_file(pages, attach_name, record, sizeof(record));
  if (rc != 0) return rc;
  memset(pages->socket_path, 0, sizeof(pages->socket_path));
  memcpy(pages->socket_path, socket_path, strlen(socket_path));
  pages->attached_bytes = byte_length;
  pages->attached = true;
  return 0;
}
static int compare_page(const void *left, const void *right) {
  uint32_t a = ((const struct namespace_page *)left)->number, b = ((const struct namespace_page *)right)->number;
  return a < b ? -1 : a > b ? 1 : 0;
}
int namespace_pages_capture(struct namespace_pages *pages, int destination, uint64_t cut,
                            uint64_t byte_length, struct namespace_snapshot *snapshot) {
  memset(snapshot, 0, sizeof(*snapshot));
  if (pages->main == NULL) return -EBADF;
  if (ftruncate(destination, 0) != 0 || lseek(destination, 0, SEEK_SET) < 0) return -errno;
  sqlite3_file *file = pages->main->inner;
  sqlite3_int64 size = 0;
  if (file->pMethods->xFileSize(file, &size) != SQLITE_OK) return -EIO;
  if (size <= 0 || byte_length == 0 || byte_length > (uint64_t)size || byte_length % NAMESPACE_PAGE_BYTES != 0) return -EINVAL;
  snapshot->byte_length = byte_length;
  snapshot->revision = pages->revision;
  if (pages->count > 0) {
    if (pages->count > SIZE_MAX / sizeof(*snapshot->pages)) return -ENOMEM;
    snapshot->pages = calloc(pages->count, sizeof(*snapshot->pages));
    if (snapshot->pages == NULL) return -ENOMEM;
  }
  for (size_t at = 0; at < pages->capacity; at++) {
    uint32_t number = pages->dirty[at].number;
    if (number == 0 || (uint64_t)(number - 1) * NAMESPACE_PAGE_BYTES >= byte_length) continue;
    snapshot->pages[snapshot->count++].number = number;
  }
  if (snapshot->count > 1) qsort(snapshot->pages, snapshot->count, sizeof(*snapshot->pages), compare_page);
  int rc = 0;
  for (size_t at = 0; at < snapshot->count; at++) {
    struct namespace_page *page = &snapshot->pages[at];
    unsigned char bytes[NAMESPACE_PAGE_BYTES], digest[SHA256_DIGEST_LENGTH];
    if (file->pMethods->xRead(file, bytes, sizeof(bytes), (sqlite3_int64)(page->number - 1) * NAMESPACE_PAGE_BYTES) != SQLITE_OK) { rc = -EIO; break; }
    SHA256(bytes, sizeof(bytes), digest);
    static const char hex[] = "0123456789abcdef";
    for (size_t index = 0; index < sizeof(digest); index++) { page->sha256[index * 2] = hex[digest[index] >> 4]; page->sha256[index * 2 + 1] = hex[digest[index] & 15]; }
    page->sha256[64] = '\0';
    page->offset = (uint64_t)at * NAMESPACE_PAGE_BYTES;
    rc = append(destination, bytes, sizeof(bytes));
    if (rc != 0) break;
  }
  if (rc == 0 && fsync(destination) != 0) rc = -errno;
  if (rc == 0) {
    unsigned char captured[48]; put64(captured, cut); put64(captured + 8, snapshot->revision); seal_record(captured, 16);
    rc = atomic_file(pages, capture_name, captured, sizeof(captured));
    if (rc == 0) { pages->captured_cut = cut; pages->captured_revision = snapshot->revision; pages->captured = true; }
  }
  if (rc != 0) namespace_snapshot_release(snapshot);
  return rc;
}
void namespace_snapshot_release(struct namespace_snapshot *snapshot) {
  free(snapshot->pages); memset(snapshot, 0, sizeof(*snapshot));
}
bool namespace_pages_captured(const struct namespace_pages *pages, uint64_t *cut, uint64_t *revision) {
  if (!pages->captured) return false;
  *cut = pages->captured_cut;
  *revision = pages->captured_revision;
  return true;
}
int namespace_pages_acknowledge(struct namespace_pages *pages, uint64_t cut, uint64_t revision) {
  if (!pages->captured || pages->captured_cut != cut || pages->captured_revision != revision) return -ESTALE;
  int fd = openat(pages->directory, "namespace-pages.tmp", O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return -errno;
  unsigned char header[JOURNAL_HEADER_BYTES]; journal_header(header, pages->revision);
  int rc = append(fd, header, sizeof(header));
  for (size_t at = 0; rc == 0 && at < pages->capacity; at++) {
    struct dirty_page entry = pages->dirty[at];
    if (entry.number == 0 || entry.revision <= pages->captured_revision) continue;
    unsigned char record[DIRTY_RECORD_BYTES]; put32(record, entry.number); put64(record + 4, entry.revision); seal_record(record, 12);
    rc = append(fd, record, sizeof(record));
  }
  if (rc == 0 && fsync(fd) != 0) rc = -errno;
  close(fd);
  if (rc == 0 && renameat(pages->directory, "namespace-pages.tmp", pages->directory, journal_name) != 0) rc = -errno;
  if (rc == 0 && fsync(pages->directory) != 0) rc = -errno;
  if (rc != 0) return rc;
  int next = openat(pages->directory, journal_name, O_RDWR | O_APPEND | O_CLOEXEC);
  if (next < 0) return -errno;
  close(pages->journal); pages->journal = next;
  free(pages->dirty); pages->dirty = NULL; pages->count = pages->capacity = 0;
  return load_journal(pages);
}
