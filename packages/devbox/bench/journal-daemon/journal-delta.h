/*
 * Dirty-range, delta-manifest and published-boundary policy for the journal
 * daemon.  This module owns everything the O(k) fence needs that is not a FUSE
 * callback: the write records a mutation appends, their exact per-inode union,
 * the staged clusters a fence copies, the delta manifest it writes, and the
 * published chunk-boundary map the sidecar merges in after a head CAS.
 *
 * `journal-daemon.c` keeps the FUSE callbacks, admission and the process
 * lifecycle.  It reaches this module through five verbs:
 *
 *   journal_write_record()      formats one W record for the write path
 *   journal_delta_stage()       the whole fence body, admission already closed
 *   journal_boundaries_parse()  decodes one `boundaries` control request
 *   journal_boundaries_merge()  merges that request into the live map
 *   journal_record_split()      the one WAL line splitter, shared with recovery
 *
 * Nothing here touches FUSE, admission or signals; nothing in the daemon
 * beyond those call sites knows a dirty range exists.
 */

#ifndef KINU_JOURNAL_DELTA_H
#define KINU_JOURNAL_DELTA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define JOURNAL_PATH_CAP 4096
/* One staged extent never exceeds this, so a digest covers a bounded read. */
#define JOURNAL_EXTENT_CAP (512 * 1024)
/* The WAL frame: sequence, kind, op, outcome, generation, path, aux. */
#define JOURNAL_RECORD_FIELDS 7

/* ---------------------------------------------------------------- dirty --- */

/* Per-inode union of written ranges, exact to the byte.  Ranges are kept
 * sorted and disjoint, so the union is canonical no matter what order the
 * writes arrived in and `count` is the exact number of maximal ranges. */
struct journal_dirty_file {
  uint64_t ino;
  uint64_t size;
  char *path; /* the path a write named, owned */
  uint64_t *offsets; /* sorted, disjoint, owned */
  uint64_t *lengths; /* parallel to offsets, owned */
  size_t count;
  size_t capacity;
};

struct journal_dirty_set {
  struct journal_dirty_file *files;
  size_t count;
  size_t capacity;
};

void journal_dirty_init(struct journal_dirty_set *set);
void journal_dirty_release(struct journal_dirty_set *set);

/* Unions [offset, offset+length) into the file named by ino, creating it when
 * absent.  `path` is copied.  Returns 0 or -ENOMEM.  Deterministic: the same
 * multiset of writes yields the same maximal ranges in the same order. */
int journal_dirty_add(struct journal_dirty_set *set, uint64_t ino, const char *path, uint64_t offset,
                     uint64_t length);

/* The file whose ino matches, or NULL. */
struct journal_dirty_file *journal_dirty_find(struct journal_dirty_set *set, uint64_t ino);

/* ------------------------------------------------------------ boundaries --- */

/* Published chunk boundaries for one file, as the sidecar reported them after
 * the head CAS that published the generation they belong to.  An empty map
 * (no boundaries op yet) is valid: the first generation's deltas stage whole
 * files, which the manifest marks with `whole: true`. */
struct journal_boundaries_file {
  uint64_t ino;
  char *path; /* owned, canonical relative */
  uint64_t size;
  uint64_t *boundaries; /* sorted strictly ascending, owned */
  size_t count;
};

struct journal_boundaries {
  struct journal_boundaries_file *files;
  size_t count;
  size_t capacity;
};

void journal_boundaries_init(struct journal_boundaries *map);
void journal_boundaries_release(struct journal_boundaries *map);

/*
 * Merges one published generation's boundary updates into the map: a file
 * whose boundaries changed replaces its previous row by ino, and `removed`
 * paths are dropped (an unlink or a rename away).  A full map per publish
 * would be O(total extents); this is O(changed).  Returns 0 or -ENOMEM, and
 * -EINVAL when an incoming boundary list is not strictly ascending.
 */
int journal_boundaries_merge(struct journal_boundaries *map, const struct journal_boundaries_file *files,
                             size_t count, const char *const *removed, size_t removed_count);

/* The file whose ino matches, or NULL. */
struct journal_boundaries_file *journal_boundaries_find(struct journal_boundaries *map, uint64_t ino);

/* One decoded `boundaries` control request: the head it belongs to, the CDC
 * parameter its boundaries were cut with, the files whose boundaries changed
 * and the paths this generation stopped needing. */
struct journal_boundaries_update {
  uint64_t cut;
  uint64_t generation;
  char root[65];
  uint64_t max_chunk;
  struct journal_boundaries_file *files;
  size_t count;
  char **removed;
  size_t removed_count;
};

/* Decodes one request line.  Returns 0, -EINVAL (malformed or an invariant
 * the map refuses) or -ENOMEM.  Release with the call below either way. */
int journal_boundaries_parse(const char *request, struct journal_boundaries_update *out);
void journal_boundaries_update_release(struct journal_boundaries_update *out);

/* --------------------------------------------------------------- windows --- */

/* One staged window: [start, start + length) of a dirty file, expressed with
 * CDC boundary context. */
struct journal_stage_window {
  uint64_t start;
  uint64_t length;
};

struct journal_stage_windows {
  struct journal_stage_window *items;
  size_t count;
  size_t capacity;
};

/*
 * The staged clusters for one dirty file: each maximal dirty range grows left
 * to the previous generation's boundary at or before its first byte and right
 * to last_dirty + 4 * max_chunk, clamped to the file size.  Adjacent windows
 * merge, so the list is minimal and canonical.  With no published boundaries
 * for the file the plan is the whole file, which is the only O(file) path and
 * is named as `whole` in the manifest and counted in `wholeFiles`.
 */
int journal_stage_plan(const struct journal_dirty_file *file, const struct journal_boundaries_file *boundaries,
                       uint64_t max_chunk, struct journal_stage_windows *windows, uint64_t *bytes, bool *whole);

void journal_stage_windows_release(struct journal_stage_windows *windows);

/* ----------------------------------------------------------- SealWork row --- */

/* The exact SealWork counter row the fence publishes.  bytesChunked,
 * chunksHashed and nodesRewritten belong to the sidecar's incremental build
 * and stay zero here; the daemon fills bytesStaged and wholeFiles. */
struct journal_seal_work {
  uint64_t bytes_staged;
  uint64_t bytes_chunked;
  uint64_t chunks_hashed;
  uint64_t nodes_rewritten;
  uint64_t whole_files;
};

/* ------------------------------------------------------------- records --- */

/* Splits one WAL line in place into its seven fields.  Returns 0 or -EUCLEAN.
 * The daemon's recovery and the fence both read the journal through this, so
 * there is one frame parser rather than two that can drift. */
int journal_record_split(char *line, char *fields[JOURNAL_RECORD_FIELDS]);

/* Undoes the WAL's tab and newline escaping in place. */
void journal_field_unescape(char *field);

/* Parses one unsigned decimal field.  Returns false on anything else. */
bool journal_parse_counter(const char *text, uint64_t *out);

/* Writes one JSON string literal, escaping what JSON requires.  The daemon's
 * control replies and this module's manifests share it, so a path that needs
 * escaping is escaped the same way on both. */
void journal_json_string(FILE *out, const char *text);

/* Formats the aux field of a W record: "<ino> <offset> <length>". */
int journal_write_record(char *out, size_t cap, uint64_t ino, uint64_t offset, uint64_t length);

/* ----------------------------------------------------------------- fence --- */

/* Everything the fence body needs from the daemon.  The daemon has already
 * closed admission, drained the mutations in flight and synced the backing
 * root; this call reads the journal above `since`, stages the dirty clusters
 * and writes the delta manifest. */
struct journal_delta_request {
  int root_fd;
  int state_fd;
  const char *state_path;
  const char *wal_name;
  uint64_t cut;
  uint64_t generation;
  uint64_t since;
  uint64_t max_chunk;
  const struct journal_boundaries *boundaries;
  bool has_base;
  uint64_t base_cut;
  uint64_t base_generation;
  const char *base_root;
};

/*
 * Stages the delta and writes its manifest.  On success `manifest_path`
 * receives the absolute manifest path and `work` the SealWork row; the staged
 * bytes and the manifest are durable before it returns, in that order, so a
 * manifest never names bytes that are not on the disk.  Returns 0 or a
 * negative errno; on failure nothing is left that a FENCE record could name.
 */
int journal_delta_stage(const struct journal_delta_request *request, char manifest_path[JOURNAL_PATH_CAP],
                        struct journal_seal_work *work);

#endif /* KINU_JOURNAL_DELTA_H */
