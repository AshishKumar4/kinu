#ifndef KINU_JOURNAL_NAMESPACE_H
#define KINU_JOURNAL_NAMESPACE_H

#include <stdint.h>
#include <sys/stat.h>
#include "journal-delta.h"

struct journal_namespace;

/* The low-level daemon owns this index. Logical IDs survive daemon restart;
 * backing device/inode bindings belong to the retained local filesystem. */
int journal_namespace_open(const char *state_path, int root_fd, struct journal_namespace **out);
void journal_namespace_close(struct journal_namespace *space);
int journal_namespace_bind(struct journal_namespace *space, uint64_t parent, const char *name,
                           const struct stat *st, uint64_t *id);
int journal_namespace_remove(struct journal_namespace *space, uint64_t parent, const char *name);
int journal_namespace_rename(struct journal_namespace *space, uint64_t parent, const char *name,
                            uint64_t new_parent, const char *new_name, unsigned flags);
int journal_namespace_path(struct journal_namespace *space, uint64_t id, char path[JOURNAL_PATH_CAP]);
int journal_namespace_aliases(struct journal_namespace *space, uint64_t logical_inode,
                             int (*emit)(void *, const char *), void *context);
int journal_namespace_reconcile(struct journal_namespace *space, int root_fd, const char *path);
/* Become the published namespace, fetching pages from the sidecar's page
 * socket on demand. Refuses with -EEXIST once this daemon changed an alias. */
int journal_namespace_attach(struct journal_namespace *space, const char *socket_path, uint64_t byte_length);
/* The head that published the capture at `cut` is durable: the pages it
 * carried stop being dirty. -ESTALE when no capture at `cut` is held. */
int journal_namespace_acknowledge(struct journal_namespace *space, uint64_t cut);
int journal_namespace_lookup(struct journal_namespace *space, uint64_t parent, const char *name, uint64_t *id);
int journal_namespace_id_at(struct journal_namespace *space, const char *path, uint64_t *id);
int journal_namespace_bind_existing(struct journal_namespace *space, const struct stat *st, uint64_t id);

struct journal_namespace_work {
  uint64_t page_reads;
  uint64_t page_writes;
  uint64_t cache_hits;
  uint64_t prepared_steps;
  uint64_t prepared_fullscan_steps;
  uint64_t aliases_returned;
  uint64_t entries_ingested;
  uint64_t page_fetches;
};
int journal_namespace_work(struct journal_namespace *space, struct journal_namespace_work *out);
int journal_namespace_stage(struct journal_namespace *space, const char *state_path, const char *manifest_path,
                            uint64_t cut, uint64_t generation);

#endif
