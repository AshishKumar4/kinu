#define _GNU_SOURCE
#include "journal-namespace.h"
#include "namespace-pages.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

struct journal_namespace {
  sqlite3 *db;
  struct namespace_pages *pages;
  pthread_mutex_t lock;
  dev_t device;
  uint64_t aliases_returned;
  uint64_t entries_ingested;
  /* No alias changed since open: an attach may still replace this namespace. */
  bool pristine;
  char state_path[JOURNAL_PATH_CAP];
  struct stat root;
  int root_fd;
  sqlite3_stmt *binding;
  sqlite3_stmt *insert_inode;
  sqlite3_stmt *insert_binding;
  sqlite3_stmt *find_alias;
  sqlite3_stmt *put_alias;
  sqlite3_stmt *delete_alias;
  sqlite3_stmt *collect_inode;
  sqlite3_stmt *collect_binding;
  sqlite3_stmt *paths;
  sqlite3_stmt *aliases;
};

static int failure(struct journal_namespace *space, int code) {
  if (code == SQLITE_OK || code == SQLITE_DONE || code == SQLITE_ROW) return 0;
  fprintf(stderr, "namespace.sqlite_failed code=%d detail=%s\n", code, sqlite3_errmsg(space->db));
  if (code == SQLITE_NOMEM) return -ENOMEM;
  if (code == SQLITE_FULL) return -ENOSPC;
  if (code == SQLITE_BUSY || code == SQLITE_LOCKED) return -EBUSY;
  return -EIO;
}

static int execute(struct journal_namespace *space, const char *sql) {
  return failure(space, sqlite3_exec(space->db, sql, NULL, NULL, NULL));
}

static int prepare(struct journal_namespace *space, const char *sql, sqlite3_stmt **out) {
  return failure(space, sqlite3_prepare_v2(space->db, sql, -1, out, NULL));
}

static void reset(sqlite3_stmt *statement) {
  sqlite3_reset(statement);
  sqlite3_clear_bindings(statement);
}

static int text(struct journal_namespace *space, sqlite3_stmt *statement, int at, const char *value) {
  return failure(space, sqlite3_bind_text(statement, at, value, -1, SQLITE_TRANSIENT));
}

static int integer(struct journal_namespace *space, sqlite3_stmt *statement, int at, uint64_t value) {
  if (value > INT64_MAX) return -EOVERFLOW;
  return failure(space, sqlite3_bind_int64(statement, at, (sqlite3_int64)value));
}

static int binding_id(struct journal_namespace *space, uint64_t ino, uint64_t *id) {
  char number[32];
  snprintf(number, sizeof(number), "%llu", (unsigned long long)ino);
  reset(space->binding);
  int rc = text(space, space->binding, 1, number);
  if (rc != 0) return rc;
  int step = sqlite3_step(space->binding);
  if (step == SQLITE_DONE) { *id = 0; return 0; }
  if (step != SQLITE_ROW) return failure(space, step);
  *id = (uint64_t)sqlite3_column_int64(space->binding, 0);
  return 0;
}

static int alias_id(struct journal_namespace *space, uint64_t parent, const char *name, uint64_t *id) {
  reset(space->find_alias);
  int rc = integer(space, space->find_alias, 1, parent);
  if (rc == 0) rc = text(space, space->find_alias, 2, name);
  if (rc != 0) return rc;
  int step = sqlite3_step(space->find_alias);
  if (step == SQLITE_DONE) { *id = 0; return 0; }
  if (step != SQLITE_ROW) return failure(space, step);
  *id = (uint64_t)sqlite3_column_int64(space->find_alias, 0);
  return 0;
}

static int put_alias(struct journal_namespace *space, uint64_t parent, const char *name, uint64_t id) {
  reset(space->put_alias);
  int rc = integer(space, space->put_alias, 1, parent);
  if (rc == 0) rc = text(space, space->put_alias, 2, name);
  if (rc == 0) rc = integer(space, space->put_alias, 3, id);
  if (rc == 0) rc = failure(space, sqlite3_step(space->put_alias));
  reset(space->put_alias);
  return rc;
}

static int delete_alias(struct journal_namespace *space, uint64_t parent, const char *name) {
  reset(space->delete_alias);
  int rc = integer(space, space->delete_alias, 1, parent);
  if (rc == 0) rc = text(space, space->delete_alias, 2, name);
  if (rc == 0) rc = failure(space, sqlite3_step(space->delete_alias));
  reset(space->delete_alias);
  return rc;
}

static int collect_inode(struct journal_namespace *space, uint64_t id) {
  reset(space->collect_inode);
  int rc = integer(space, space->collect_inode, 1, id);
  if (rc == 0) rc = failure(space, sqlite3_step(space->collect_inode));
  reset(space->collect_inode);
  if (rc == 0) {
    reset(space->collect_binding);
    rc = integer(space, space->collect_binding, 1, id);
    if (rc == 0) rc = failure(space, sqlite3_step(space->collect_binding));
    reset(space->collect_binding);
  }
  return rc;
}

static int store_binding(struct journal_namespace *space, const struct stat *st, uint64_t id) {
  if (st->st_dev != space->device) return -EXDEV;
  char number[32];
  snprintf(number, sizeof(number), "%llu", (unsigned long long)st->st_ino);
  reset(space->insert_binding);
  int rc = text(space, space->insert_binding, 1, number);
  if (rc == 0) rc = integer(space, space->insert_binding, 2, id);
  if (rc == 0) rc = failure(space, sqlite3_step(space->insert_binding));
  reset(space->insert_binding);
  return rc;
}

static int bind_inode(struct journal_namespace *space, uint64_t parent, const char *name,
                      const struct stat *st, uint64_t *id) {
  if (st->st_dev != space->device) return -EXDEV;
  int rc = binding_id(space, (uint64_t)st->st_ino, id);
  reset(space->binding);
  if (rc != 0) return rc;
  if (*id == 0) {
    reset(space->insert_inode);
    rc = failure(space, sqlite3_step(space->insert_inode));
    reset(space->insert_inode);
    if (rc != 0) return rc;
    *id = (uint64_t)sqlite3_last_insert_rowid(space->db);
    rc = store_binding(space, st, *id);
    if (rc != 0) return rc;
  }
  if (parent == 0) return 0;
  uint64_t previous = 0;
  rc = alias_id(space, parent, name, &previous);
  reset(space->find_alias);
  if (rc != 0 || previous == *id) return rc;
  rc = put_alias(space, parent, name, *id);
  space->pristine = false;
  if (rc == 0 && previous != 0) rc = collect_inode(space, previous);
  return rc;
}

/* Initial ingestion visits the existing local tree once. Later lookups and
 * reverse aliases use indexes; an ancestor rename changes one alias row. */
static int ingest(struct journal_namespace *space, int parent_fd, uint64_t parent) {
  int fd = openat(parent_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return -errno;
  DIR *directory = fdopendir(fd);
  if (directory == NULL) { int rc = -errno; close(fd); return rc; }
  int rc = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) { if (errno != 0) rc = -errno; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) { rc = -errno; break; }
    space->entries_ingested++;
    uint64_t id = 0;
    rc = bind_inode(space, parent, entry->d_name, &st, &id);
    if (rc != 0) break;
    if (S_ISDIR(st.st_mode)) {
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) { rc = -errno; break; }
      rc = ingest(space, child, id);
      close(child);
      if (rc != 0) break;
    }
  }
  closedir(directory);
  return rc;
}

static int finish(struct journal_namespace *space, int rc) {
  int ended = execute(space, rc == 0 ? "COMMIT" : "ROLLBACK");
  return ended == 0 ? rc : ended;
}

static int verify_filesystem(struct journal_namespace *space, const struct stat *root) {
  int rc = execute(space, "CREATE TABLE IF NOT EXISTS local.filesystem(singleton INTEGER PRIMARY KEY CHECK(singleton=1),device TEXT NOT NULL,root_inode TEXT NOT NULL)");
  char device[32], ino[32];
  snprintf(device, sizeof(device), "%llu", (unsigned long long)root->st_dev);
  snprintf(ino, sizeof(ino), "%llu", (unsigned long long)root->st_ino);
  sqlite3_stmt *insert = NULL, *read = NULL;
  if (rc == 0) rc = prepare(space, "INSERT OR IGNORE INTO local.filesystem VALUES(1,?,?)", &insert);
  if (rc == 0) rc = text(space, insert, 1, device);
  if (rc == 0) rc = text(space, insert, 2, ino);
  if (rc == 0) rc = failure(space, sqlite3_step(insert));
  sqlite3_finalize(insert);
  if (rc == 0) rc = prepare(space, "SELECT 1 FROM local.filesystem WHERE singleton=1 AND device=? AND root_inode=?", &read);
  if (rc == 0) rc = text(space, read, 1, device);
  if (rc == 0) rc = text(space, read, 2, ino);
  if (rc == 0) {
    int step = sqlite3_step(read);
    rc = step == SQLITE_ROW ? 0 : step == SQLITE_DONE ? -ESTALE : failure(space, step);
  }
  sqlite3_finalize(read);
  return rc;
}

static int admit_format(struct journal_namespace *space, const char *state_path, bool *genesis) {
  sqlite3_stmt *read = NULL;
  int rc = prepare(space, "PRAGMA user_version", &read);
  int version = -1;
  if (rc == 0) {
    int step = sqlite3_step(read);
    if (step == SQLITE_ROW) version = sqlite3_column_int(read, 0);
    else rc = failure(space, step);
  }
  sqlite3_finalize(read);
  if (rc != 0) return rc;
  if (version == 2) { *genesis = false; return 0; }
  if (version != 0) return -EPROTONOSUPPORT;
  rc = prepare(space, "SELECT name FROM sqlite_schema LIMIT 1", &read);
  if (rc == 0) {
    int step = sqlite3_step(read);
    if (step == SQLITE_ROW) rc = -EPROTONOSUPPORT;
    else if (step != SQLITE_DONE) rc = failure(space, step);
  }
  sqlite3_finalize(read);
  if (rc != 0) return rc;
  char wal[JOURNAL_PATH_CAP];
  int size = snprintf(wal, sizeof(wal), "%s/wal.log", state_path);
  if (size < 0 || (size_t)size >= sizeof(wal)) return -ENAMETOOLONG;
  struct stat st;
  if (stat(wal, &st) == 0) { if (st.st_size != 0) return -ESTALE; }
  else if (errno != ENOENT) return -errno;
  *genesis = true;
  return 0;
}

static void finalize_statements(struct journal_namespace *space) {
  sqlite3_finalize(space->binding);
  sqlite3_finalize(space->insert_inode);
  sqlite3_finalize(space->insert_binding);
  sqlite3_finalize(space->find_alias);
  sqlite3_finalize(space->put_alias);
  sqlite3_finalize(space->delete_alias);
  sqlite3_finalize(space->collect_inode);
  sqlite3_finalize(space->collect_binding);
  sqlite3_finalize(space->paths);
  sqlite3_finalize(space->aliases);
  space->binding = space->insert_inode = space->insert_binding = space->find_alias = space->put_alias = NULL;
  space->delete_alias = space->collect_inode = space->collect_binding = space->paths = space->aliases = NULL;
}

/* Open the namespace database through the page VFS. A genesis creates the
 * schema, binds the root as id 1 and ingests the backing tree once. An
 * attached image already carries its schema and its ids; `attached` refuses
 * a genesis. `wipe_bindings` drops backing bindings that named another
 * namespace's ids. */
static int open_database(struct journal_namespace *space, bool attached, bool wipe_bindings, bool *born) {
  char path[JOURNAL_PATH_CAP];
  int length = snprintf(path, sizeof(path), "%s/namespace.sqlite", space->state_path);
  if (length < 0 || (size_t)length >= sizeof(path)) return -ENAMETOOLONG;
  int rc = failure(space, sqlite3_open_v2(path, &space->db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, namespace_pages_vfs(space->pages)));
  bool genesis = false;
  if (rc == 0) rc = admit_format(space, space->state_path, &genesis);
  *born = genesis;
  if (rc == 0 && attached && genesis) rc = -EPROTONOSUPPORT;
  sqlite3_stmt *attach = NULL;
  length = snprintf(path, sizeof(path), "%s/namespace-local.sqlite", space->state_path);
  if (length < 0 || (size_t)length >= sizeof(path)) rc = -ENAMETOOLONG;
  if (rc == 0) rc = prepare(space, "ATTACH DATABASE ? AS local", &attach);
  if (rc == 0) rc = text(space, attach, 1, path);
  if (rc == 0) rc = failure(space, sqlite3_step(attach));
  sqlite3_finalize(attach);
  if (rc == 0) rc = execute(space,
    "PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA local.journal_mode=WAL; PRAGMA local.synchronous=NORMAL; PRAGMA foreign_keys=ON;");
  bool transaction = false;
  if (rc == 0) { rc = execute(space, "BEGIN IMMEDIATE"); transaction = rc == 0; }
  if (rc == 0 && genesis) rc = execute(space,
    "CREATE TABLE inode(id INTEGER PRIMARY KEY AUTOINCREMENT);"
    "CREATE TABLE alias(parent INTEGER NOT NULL REFERENCES inode(id),name TEXT NOT NULL,id INTEGER NOT NULL REFERENCES inode(id),PRIMARY KEY(parent,name)) WITHOUT ROWID;"
    "CREATE INDEX alias_by_inode ON alias(id,parent,name);");
  if (rc == 0) rc = execute(space, "CREATE TABLE IF NOT EXISTS local.binding(backing_inode TEXT PRIMARY KEY, id INTEGER NOT NULL) WITHOUT ROWID;");
  if (rc == 0 && wipe_bindings) rc = execute(space, "DELETE FROM local.binding");
  if (rc == 0) rc = verify_filesystem(space, &space->root);
  if (rc == 0) rc = prepare(space, "SELECT b.id FROM local.binding b JOIN inode i ON i.id=b.id WHERE b.backing_inode=?", &space->binding);
  if (rc == 0) rc = prepare(space, "INSERT INTO inode DEFAULT VALUES", &space->insert_inode);
  if (rc == 0) rc = prepare(space, "INSERT INTO local.binding VALUES(?,?) ON CONFLICT(backing_inode) DO UPDATE SET id=excluded.id", &space->insert_binding);
  if (rc == 0) rc = prepare(space, "SELECT id FROM alias WHERE parent=? AND name=?", &space->find_alias);
  if (rc == 0) rc = prepare(space, "INSERT INTO alias VALUES(?,?,?) ON CONFLICT(parent,name) DO UPDATE SET id=excluded.id", &space->put_alias);
  if (rc == 0) rc = prepare(space, "DELETE FROM alias WHERE parent=? AND name=?", &space->delete_alias);
  if (rc == 0) rc = prepare(space, "DELETE FROM inode WHERE id=? AND id<>1 AND NOT EXISTS(SELECT 1 FROM alias WHERE alias.id=inode.id) AND NOT EXISTS(SELECT 1 FROM alias WHERE alias.parent=inode.id)", &space->collect_inode);
  if (rc == 0) rc = prepare(space, "DELETE FROM local.binding WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM inode WHERE id=?1)", &space->collect_binding);
  const char *paths = "WITH RECURSIVE path(id,name) AS (SELECT ?,'' UNION ALL SELECT a.parent,'/'||a.name||path.name FROM alias a JOIN path ON a.id=path.id) SELECT name FROM path WHERE id=1";
  if (rc == 0) rc = prepare(space, "SELECT parent,name FROM alias WHERE id=? ORDER BY parent,name LIMIT 1", &space->paths);
  if (rc == 0) rc = prepare(space, paths, &space->aliases);
  uint64_t root_id = 0;
  sqlite3_stmt *root_query = NULL;
  if (rc == 0) rc = prepare(space, "SELECT id FROM inode WHERE id=1", &root_query);
  if (rc == 0) {
    int step = sqlite3_step(root_query);
    if (step == SQLITE_ROW) root_id = 1;
    else if (step != SQLITE_DONE) rc = failure(space, step);
  }
  sqlite3_finalize(root_query);
  if (rc == 0 && root_id == 0 && genesis) {
    rc = bind_inode(space, 0, "", &space->root, &root_id);
    if (rc == 0 && root_id != 1) rc = -ESTALE;
    if (rc == 0) rc = ingest(space, space->root_fd, root_id);
  }
  if (rc == 0) rc = store_binding(space, &space->root, 1);
  if (rc == 0 && root_id != 1) rc = -ESTALE;
  if (rc == 0 && genesis) rc = execute(space, "PRAGMA user_version=2");
  if (transaction) rc = finish(space, rc);
  return rc;
}

int journal_namespace_open(const char *state_path, int root_fd, struct journal_namespace **out) {
  struct journal_namespace *space = calloc(1, sizeof(*space));
  if (space == NULL) return -ENOMEM;
  pthread_mutex_init(&space->lock, NULL);
  space->root_fd = root_fd;
  space->pristine = false;
  if (fstat(root_fd, &space->root) != 0) { int rc = -errno; journal_namespace_close(space); return rc; }
  space->device = space->root.st_dev;
  if (strlen(state_path) >= sizeof(space->state_path)) { journal_namespace_close(space); return -ENAMETOOLONG; }
  memcpy(space->state_path, state_path, strlen(state_path) + 1);
  char path[JOURNAL_PATH_CAP];
  int length = snprintf(path, sizeof(path), "%s/namespace.sqlite", state_path);
  if (length < 0 || (size_t)length >= sizeof(path)) { journal_namespace_close(space); return -ENAMETOOLONG; }
  int rc = namespace_pages_open(path, state_path, &space->pages);
  bool genesis = false;
  if (rc == 0) rc = open_database(space, false, false, &genesis);
  if (rc != 0) { journal_namespace_close(space); return rc; }
  /* Only a namespace born now, holding nothing but what the backing tree
   * showed it, may be replaced by the published one at attach. */
  space->pristine = genesis;
  *out = space;
  return 0;
}

int journal_namespace_attach(struct journal_namespace *space, const char *socket_path, uint64_t byte_length) {
  pthread_mutex_lock(&space->lock);
  int rc = space->pristine ? 0 : -EEXIST;
  if (rc == 0) {
    finalize_statements(space);
    rc = failure(space, sqlite3_close(space->db));
    space->db = NULL;
  }
  if (rc == 0) rc = namespace_pages_attach(space->pages, socket_path, byte_length);
  bool born = false;
  if (rc == 0) rc = open_database(space, true, true, &born);
  if (rc == 0) space->pristine = false;
  pthread_mutex_unlock(&space->lock);
  return rc;
}

void journal_namespace_close(struct journal_namespace *space) {
  if (space == NULL) return;
  finalize_statements(space);
  if (space->db != NULL) sqlite3_close(space->db);
  namespace_pages_close(space->pages);
  pthread_mutex_destroy(&space->lock);
  free(space);
}

int journal_namespace_bind(struct journal_namespace *space, uint64_t parent, const char *name,
                           const struct stat *st, uint64_t *id) {
  pthread_mutex_lock(&space->lock);
  int rc = execute(space, "BEGIN IMMEDIATE");
  if (rc == 0) rc = finish(space, bind_inode(space, parent, name, st, id));
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_remove(struct journal_namespace *space, uint64_t parent, const char *name) {
  pthread_mutex_lock(&space->lock);
  int rc = execute(space, "BEGIN IMMEDIATE");
  space->pristine = false;
  if (rc == 0) {
    uint64_t id = 0;
    rc = alias_id(space, parent, name, &id);
    reset(space->find_alias);
    if (rc == 0) rc = delete_alias(space, parent, name);
    if (rc == 0 && id != 0) rc = collect_inode(space, id);
    rc = finish(space, rc);
  }
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_rename(struct journal_namespace *space, uint64_t parent, const char *name,
                            uint64_t new_parent, const char *new_name, unsigned flags) {
  pthread_mutex_lock(&space->lock);
  int rc = execute(space, "BEGIN IMMEDIATE");
  space->pristine = false;
  if (rc == 0) {
    uint64_t source = 0, destination = 0;
    rc = alias_id(space, parent, name, &source);
    if (rc == 0) rc = alias_id(space, new_parent, new_name, &destination);
    reset(space->find_alias);
    if (rc == 0 && source == 0) rc = -ESTALE;
    if (rc == 0 && source != destination) {
      rc = delete_alias(space, parent, name);
      if (rc == 0) rc = put_alias(space, new_parent, new_name, source);
      if (rc == 0 && (flags & RENAME_EXCHANGE) != 0) {
        rc = destination == 0 ? -ESTALE : put_alias(space, parent, name, destination);
      }
      if (rc == 0 && destination != 0 && (flags & RENAME_EXCHANGE) == 0) rc = collect_inode(space, destination);
    }
    rc = finish(space, rc);
  }
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_path(struct journal_namespace *space, uint64_t id, char path[JOURNAL_PATH_CAP]) {
  pthread_mutex_lock(&space->lock);
  int rc = 0;
  size_t cursor = JOURNAL_PATH_CAP - 1;
  path[cursor] = '\0';
  while (id != 1 && rc == 0) {
    reset(space->paths);
    rc = integer(space, space->paths, 1, id);
    if (rc != 0) break;
    int step = sqlite3_step(space->paths);
    if (step != SQLITE_ROW) { rc = step == SQLITE_DONE ? -ENOENT : failure(space, step); break; }
    const char *name = (const char *)sqlite3_column_text(space->paths, 1);
    size_t bytes = (size_t)sqlite3_column_bytes(space->paths, 1);
    if (bytes == 0 || bytes + 1 > cursor) { rc = -ENAMETOOLONG; break; }
    cursor -= bytes;
    memcpy(path + cursor, name, bytes);
    path[--cursor] = '/';
    id = (uint64_t)sqlite3_column_int64(space->paths, 0);
  }
  if (rc == 0) {
    if (cursor == JOURNAL_PATH_CAP - 1) path[--cursor] = '/';
    memmove(path, path + cursor, JOURNAL_PATH_CAP - cursor);
  }
  reset(space->paths);
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_aliases(struct journal_namespace *space, uint64_t id,
                             int (*emit)(void *, const char *), void *context) {
  pthread_mutex_lock(&space->lock);
  int rc = 0;
  reset(space->aliases);
  if (rc == 0 && id != 0) {
    rc = integer(space, space->aliases, 1, id);
    while (rc == 0) {
      int step = sqlite3_step(space->aliases);
      if (step == SQLITE_DONE) break;
      if (step != SQLITE_ROW) { rc = failure(space, step); break; }
      const char *path = (const char *)sqlite3_column_text(space->aliases, 0);
      rc = emit(context, path[0] == '/' ? path + 1 : path);
      space->aliases_returned++;
    }
  }
  reset(space->aliases);
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_bind_existing(struct journal_namespace *space, const struct stat *st, uint64_t id) {
  pthread_mutex_lock(&space->lock);
  uint64_t current = 0;
  int rc = binding_id(space, (uint64_t)st->st_ino, &current);
  reset(space->binding);
  if (rc == 0 && current != id) rc = store_binding(space, st, id);
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_work(struct journal_namespace *space, struct journal_namespace_work *out) {
  pthread_mutex_lock(&space->lock);
  memset(out, 0, sizeof(*out));
  int value = 0, high = 0;
  int rc = failure(space, sqlite3_db_status(space->db, SQLITE_DBSTATUS_CACHE_MISS, &value, &high, 0));
  if (rc == 0) out->page_reads = (uint64_t)value;
  if (rc == 0) rc = failure(space, sqlite3_db_status(space->db, SQLITE_DBSTATUS_CACHE_WRITE, &value, &high, 0));
  if (rc == 0) out->page_writes = (uint64_t)value;
  if (rc == 0) rc = failure(space, sqlite3_db_status(space->db, SQLITE_DBSTATUS_CACHE_HIT, &value, &high, 0));
  if (rc == 0) out->cache_hits = (uint64_t)value;
  sqlite3_stmt *statements[] = { space->binding, space->insert_inode, space->insert_binding, space->find_alias,
    space->put_alias, space->delete_alias, space->collect_inode, space->collect_binding, space->paths, space->aliases };
  for (size_t at = 0; at < sizeof(statements) / sizeof(statements[0]); at++) {
    out->prepared_steps += (uint64_t)sqlite3_stmt_status(statements[at], SQLITE_STMTSTATUS_VM_STEP, 0);
    out->prepared_fullscan_steps += (uint64_t)sqlite3_stmt_status(statements[at], SQLITE_STMTSTATUS_FULLSCAN_STEP, 0);
  }
  out->aliases_returned = space->aliases_returned;
  out->entries_ingested = space->entries_ingested;
  out->page_fetches = namespace_pages_fetches(space->pages);
  pthread_mutex_unlock(&space->lock);
  return rc;
}

static int capture_namespace(struct journal_namespace *space, int destination, uint64_t cut,
                              struct namespace_snapshot *snapshot) {
  pthread_mutex_lock(&space->lock);
  int rc = failure(space, sqlite3_wal_checkpoint_v2(space->db, "main", SQLITE_CHECKPOINT_TRUNCATE, NULL, NULL));
  sqlite3_stmt *count = NULL;
  uint64_t byte_length = 0;
  if (rc == 0) rc = prepare(space, "PRAGMA main.page_count", &count);
  if (rc == 0) {
    int step = sqlite3_step(count);
    if (step != SQLITE_ROW) rc = failure(space, step);
    else {
      sqlite3_int64 pages = sqlite3_column_int64(count, 0);
      if (pages <= 0 || (uint64_t)pages > UINT32_MAX) rc = -EOVERFLOW;
      else byte_length = (uint64_t)pages * NAMESPACE_PAGE_BYTES;
    }
  }
  sqlite3_finalize(count);
  if (rc == 0) rc = namespace_pages_capture(space->pages, destination, cut, byte_length, snapshot);
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_stage(struct journal_namespace *space, const char *state_path, const char *manifest_path,
                            uint64_t cut, uint64_t generation) {
  char frames[JOURNAL_PATH_CAP], metadata[JOURNAL_PATH_CAP], temporary[JOURNAL_PATH_CAP];
  int size = snprintf(frames, sizeof(frames), "%s/namespace-c%llu-g%llu-XXXXXX", state_path,
                      (unsigned long long)cut, (unsigned long long)generation);
  if (size < 0 || (size_t)size >= sizeof(frames)) return -ENAMETOOLONG;
  size = snprintf(metadata, sizeof(metadata), "%s.namespace", manifest_path);
  if (size < 0 || (size_t)size >= sizeof(metadata)) return -ENAMETOOLONG;
  size = snprintf(temporary, sizeof(temporary), "%s.tmp", metadata);
  if (size < 0 || (size_t)size >= sizeof(temporary)) return -ENAMETOOLONG;
  int fd = mkostemp(frames, O_CLOEXEC);
  if (fd < 0) return -errno;
  struct namespace_snapshot snapshot = {0};
  int rc = capture_namespace(space, fd, cut, &snapshot);
  close(fd);
  int manifest = rc == 0 ? open(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600) : -1;
  if (rc == 0 && manifest < 0) rc = -errno;
  FILE *out = manifest < 0 ? NULL : fdopen(manifest, "w");
  if (manifest >= 0 && out == NULL) { rc = -errno; close(manifest); }
  if (out != NULL) {
    fprintf(out, "{\"format\":\"sqlite-inodes/v2\",\"cut\":\"%llu\",\"generation\":\"%llu\",\"revision\":\"%llu\",\"pageBytes\":%u,\"byteLength\":\"%llu\",\"file\":",
            (unsigned long long)cut, (unsigned long long)generation, (unsigned long long)snapshot.revision,
            NAMESPACE_PAGE_BYTES, (unsigned long long)snapshot.byte_length);
    journal_json_string(out, frames);
    fputs(",\"pages\":[", out);
    for (size_t index = 0; index < snapshot.count; index++) {
      const struct namespace_page *page = &snapshot.pages[index];
      fprintf(out, "%s{\"number\":%u,\"offset\":\"%llu\",\"sha256\":\"%s\"}", index == 0 ? "" : ",",
              page->number, (unsigned long long)page->offset, page->sha256);
    }
    fputs("]}\n", out);
    if (ferror(out) != 0) rc = -EIO;
    if (rc == 0 && fflush(out) != 0) rc = -errno;
    if (rc == 0 && fsync(manifest) != 0) rc = -errno;
    fclose(out);
  }
  if (rc == 0 && rename(temporary, metadata) != 0) rc = -errno;
  if (rc == 0) {
    int directory = open(state_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory < 0) rc = -errno;
    else { if (fsync(directory) != 0) rc = -errno; close(directory); }
  }
  namespace_snapshot_release(&snapshot);
  if (rc != 0) { unlink(temporary); unlink(frames); }
  return rc;
}

int journal_namespace_lookup(struct journal_namespace *space, uint64_t parent, const char *name, uint64_t *id) {
  pthread_mutex_lock(&space->lock);
  int rc = alias_id(space, parent, name, id);
  reset(space->find_alias);
  pthread_mutex_unlock(&space->lock);
  return rc == 0 && *id == 0 ? -ENOENT : rc;
}

int journal_namespace_id_at(struct journal_namespace *space, const char *path, uint64_t *id) {
  if (strlen(path) >= JOURNAL_PATH_CAP) return -ENAMETOOLONG;
  char pending[JOURNAL_PATH_CAP];
  memcpy(pending, path, strlen(path) + 1);
  char *cursor = NULL;
  char *name = strtok_r(pending, "/", &cursor);
  uint64_t current = 1;
  int rc = 0;
  pthread_mutex_lock(&space->lock);
  while (name != NULL && rc == 0) {
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) { rc = -EPERM; break; }
    uint64_t child = 0;
    rc = alias_id(space, current, name, &child);
    if (rc == 0 && child == 0) rc = -ENOENT;
    current = child;
    name = strtok_r(NULL, "/", &cursor);
  }
  reset(space->find_alias);
  pthread_mutex_unlock(&space->lock);
  if (rc == 0) *id = current;
  return rc;
}

/* Reconcile only the named path of an interrupted effect. Parent IDs keep
 * ancestor moves local; this does not scan the namespace at restart. */
static int reconcile_path(struct journal_namespace *space, int root_fd, const char *path) {
  if (path[0] != '/' || strlen(path) >= JOURNAL_PATH_CAP) return -EINVAL;
  char pending[JOURNAL_PATH_CAP];
  memcpy(pending, path + 1, strlen(path));
  char *cursor = NULL;
  char *name = strtok_r(pending, "/", &cursor);
  uint64_t parent = 1;
  int directory = root_fd;
  int rc = 0;
  while (name != NULL && rc == 0) {
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) { rc = -EPERM; break; }
    struct stat st;
    if (fstatat(directory, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno != ENOENT) { rc = -errno; break; }
      uint64_t old = 0;
      rc = alias_id(space, parent, name, &old);
      reset(space->find_alias);
      if (rc == 0) rc = delete_alias(space, parent, name);
      if (rc == 0 && old != 0) rc = collect_inode(space, old);
      break;
    }
    uint64_t id = 0;
    rc = bind_inode(space, parent, name, &st, &id);
    char *next = strtok_r(NULL, "/", &cursor);
    if (rc != 0 || next == NULL) break;
    if (!S_ISDIR(st.st_mode)) break;
    int child = openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0) { rc = -errno; break; }
    if (directory != root_fd) close(directory);
    directory = child;
    parent = id;
    name = next;
  }
  if (directory != root_fd) close(directory);
  return rc;
}

int journal_namespace_acknowledge(struct journal_namespace *space, uint64_t cut) {
  pthread_mutex_lock(&space->lock);
  uint64_t captured_cut = 0, revision = 0;
  int rc = namespace_pages_captured(space->pages, &captured_cut, &revision) && captured_cut == cut
    ? namespace_pages_acknowledge(space->pages, cut, revision)
    : -ESTALE;
  pthread_mutex_unlock(&space->lock);
  return rc;
}

int journal_namespace_reconcile(struct journal_namespace *space, int root_fd, const char *path) {
  pthread_mutex_lock(&space->lock);
  int rc = execute(space, "BEGIN IMMEDIATE");
  space->pristine = false;
  if (rc == 0) rc = finish(space, reconcile_path(space, root_fd, path));
  pthread_mutex_unlock(&space->lock);
  return rc;
}
