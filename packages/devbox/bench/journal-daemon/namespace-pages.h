#ifndef KINU_NAMESPACE_PAGES_H
#define KINU_NAMESPACE_PAGES_H

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#define NAMESPACE_PAGE_BYTES 4096

struct namespace_pages;
struct namespace_page {
  uint32_t number;
  uint64_t offset;
  char sha256[65];
};
struct namespace_snapshot {
  uint64_t revision;
  uint64_t byte_length;
  size_t count;
  struct namespace_page *pages;
};

/* A supported SQLite VFS wraps the platform VFS. It tracks main-database
 * writes without interpreting SQL or SQLite WAL bytes. */
int namespace_pages_open(const char *database_path, const char *state_path, struct namespace_pages **out);

/* Become the published image at `byte_length`, fetching pages on demand from
 * the sidecar's page socket. Call with SQLite closed; reopen afterwards. */
int namespace_pages_attach(struct namespace_pages *pages, const char *socket_path, uint64_t byte_length);
uint64_t namespace_pages_fetches(const struct namespace_pages *pages);
const char *namespace_pages_vfs(struct namespace_pages *pages);
void namespace_pages_close(struct namespace_pages *pages);
/* Call after SQLite checkpoints under the namespace lock. The destination
 * receives only changed pages. The returned descriptors own their array. */
int namespace_pages_capture(struct namespace_pages *pages, int destination, uint64_t cut,
                            uint64_t byte_length, struct namespace_snapshot *snapshot);
void namespace_snapshot_release(struct namespace_snapshot *snapshot);
int namespace_pages_acknowledge(struct namespace_pages *pages, uint64_t cut, uint64_t revision);
/* The capture on record, if any: its cut and the revision it froze. */
bool namespace_pages_captured(const struct namespace_pages *pages, uint64_t *cut, uint64_t *revision);

#endif
