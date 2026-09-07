#define _GNU_SOURCE
#include "namespace-pages.h"
#include <errno.h>
#include <fcntl.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void require(int condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}
static void execute(sqlite3 *db, const char *sql) {
  int rc = sqlite3_exec(db, sql, NULL, NULL, NULL);
  if (rc != SQLITE_OK) { fprintf(stderr, "sqlite=%d %s\n", rc, sqlite3_errmsg(db)); exit(1); }
}
static uint64_t scalar(sqlite3 *db, const char *sql) {
  sqlite3_stmt *statement = NULL;
  require(sqlite3_prepare_v2(db, sql, -1, &statement, NULL) == SQLITE_OK, "prepare scalar");
  require(sqlite3_step(statement) == SQLITE_ROW, "read scalar");
  uint64_t value = (uint64_t)sqlite3_column_int64(statement, 0);
  sqlite3_finalize(statement);
  return value;
}
static uint64_t rows(const char *path) {
  sqlite3 *db = NULL;
  require(sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK, "open frozen snapshot");
  uint64_t count = scalar(db, "SELECT count(*) FROM item");
  require(sqlite3_close(db) == SQLITE_OK, "close frozen snapshot");
  return count;
}
static void apply(int frames, int image, const struct namespace_snapshot *snapshot) {
  unsigned char bytes[NAMESPACE_PAGE_BYTES];
  for (size_t at = 0; at < snapshot->count; at++) {
    const struct namespace_page *page = &snapshot->pages[at];
    require(pread(frames, bytes, sizeof(bytes), (off_t)page->offset) == sizeof(bytes), "read staged page");
    require(pwrite(image, bytes, sizeof(bytes), (off_t)(page->number - 1) * NAMESPACE_PAGE_BYTES) == sizeof(bytes), "restore staged page");
  }
  require(ftruncate(image, (off_t)snapshot->byte_length) == 0, "size restored snapshot");
}
int main(int argc, char **argv) {
  require(argc == 2, "state directory required");
  char database[4096], frame_path[4096], image_path[4096], journal_path[4096];
  require(snprintf(database, sizeof(database), "%s/db.sqlite", argv[1]) < (int)sizeof(database), "database path");
  require(snprintf(frame_path, sizeof(frame_path), "%s/frames", argv[1]) < (int)sizeof(frame_path), "frame path");
  require(snprintf(image_path, sizeof(image_path), "%s/image.sqlite", argv[1]) < (int)sizeof(image_path), "image path");
  require(snprintf(journal_path, sizeof(journal_path), "%s/namespace-pages.log", argv[1]) < (int)sizeof(journal_path), "journal path");
  struct namespace_pages *pages = NULL;
  require(namespace_pages_open(database, argv[1], &pages) == 0, "open tracked VFS");
  sqlite3 *db = NULL;
  require(sqlite3_open_v2(database, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                         namespace_pages_vfs(pages)) == SQLITE_OK, "open database through VFS");
  execute(db, "PRAGMA page_size=4096; PRAGMA journal_mode=WAL; CREATE TABLE item(id INTEGER PRIMARY KEY,body TEXT);"
              "BEGIN; WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)"
              "INSERT INTO item SELECT x,printf('%0100d',x) FROM n; COMMIT;");
  require(sqlite3_wal_checkpoint_v2(db, "main", SQLITE_CHECKPOINT_TRUNCATE, NULL, NULL) == SQLITE_OK, "checkpoint A");
  int frames = open(frame_path, O_RDWR | O_CREAT | O_TRUNC, 0600);
  int image = open(image_path, O_RDWR | O_CREAT | O_TRUNC, 0600);
  require(frames >= 0 && image >= 0, "open snapshot files");
  struct namespace_snapshot first, second;
  uint64_t size = scalar(db, "PRAGMA page_count") * NAMESPACE_PAGE_BYTES;
  require(namespace_pages_capture(pages, frames, 1, size, &first) == 0, "capture A");
  apply(frames, image, &first);
  execute(db, "INSERT INTO item VALUES(1001,'later write')");
  require(sqlite3_wal_checkpoint_v2(db, "main", SQLITE_CHECKPOINT_TRUNCATE, NULL, NULL) == SQLITE_OK, "checkpoint later write");
  require(namespace_pages_acknowledge(pages, 1, first.revision + 1) == -ESTALE, "wrong revision was accepted");
  require(namespace_pages_acknowledge(pages, 1, first.revision) == 0, "acknowledge A");
  require(rows(image_path) == 1000, "snapshot A included later data");
  size = scalar(db, "PRAGMA page_count") * NAMESPACE_PAGE_BYTES;
  require(namespace_pages_capture(pages, frames, 2, size, &second) == 0, "capture B");
  require(second.count > 0 && second.count < first.count, "late acknowledgement lost the delta or exported the whole database");
  apply(frames, image, &second);
  require(rows(image_path) == 1001, "later delta did not restore its row");
  require(sqlite3_close(db) == SQLITE_OK, "close live database");
  namespace_pages_close(pages);
  pages = NULL;
  require(namespace_pages_open(database, argv[1], &pages) == 0, "reopen page journal");
  require(namespace_pages_acknowledge(pages, 2, second.revision) == 0, "capture acknowledgement did not survive restart");
  namespace_pages_close(pages);
  pages = NULL;
  int broken = open(journal_path, O_RDWR);
  require(broken >= 0, "open journal corruption target");
  unsigned char byte;
  require(pread(broken, &byte, 1, 8) == 1, "read corruption target");
  byte ^= 1;
  require(pwrite(broken, &byte, 1, 8) == 1, "inject journal corruption");
  close(broken);
  require(namespace_pages_open(database, argv[1], &pages) == -EUCLEAN, "corrupt page journal was accepted");
  printf("{\"firstRows\":1000,\"secondRows\":1001,\"fullPages\":%zu,\"deltaPages\":%zu,\"wrongRevisionRefused\":true,\"corruptJournalRefused\":true}\n", first.count, second.count);
  namespace_snapshot_release(&first);
  namespace_snapshot_release(&second);
  close(frames);
  close(image);
  return 0;
}
