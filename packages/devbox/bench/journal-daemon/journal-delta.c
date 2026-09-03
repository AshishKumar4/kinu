/*
 * Dirty-range, delta-manifest and published-boundary policy for the journal
 * daemon.  The header states the contract; here there is only implementation.
 * Every allocation failure is -ENOMEM, every refused invariant is -EINVAL, and
 * every filesystem failure is the negated errno the kernel gave.
 */

#define _GNU_SOURCE

#include "journal-delta.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

typedef unsigned long long counter;

#define COPY_CHUNK (128 * 1024)
#define STAGE_ATTEMPT_CAP 4096

static int neg_errno(void) { return errno == 0 ? -EIO : -errno; }

static char *copy_string(const char *text) {
  size_t length = strlen(text) + 1;
  char *copy = malloc(length);
  if (copy != NULL) memcpy(copy, text, length);
  return copy;
}

/* ------------------------------------------------------------- records --- */

int journal_record_split(char *line, char *fields[JOURNAL_RECORD_FIELDS]) {
  char *cursor = line;
  for (size_t index = 0; index < JOURNAL_RECORD_FIELDS; index++) {
    fields[index] = cursor;
    char *end = strchr(cursor, index == JOURNAL_RECORD_FIELDS - 1 ? '\n' : '\t');
    if (end == NULL) return -EUCLEAN;
    *end = '\0';
    cursor = end + 1;
  }
  return 0;
}

void journal_field_unescape(char *field) {
  char *write_at = field;
  for (const char *read_at = field; *read_at != '\0'; read_at++) {
    if (*read_at != '\\') {
      *write_at++ = *read_at;
      continue;
    }
    read_at++;
    if (*read_at == 't') *write_at++ = '\t';
    else if (*read_at == 'n') *write_at++ = '\n';
    else if (*read_at == '\\') *write_at++ = '\\';
    else if (*read_at == '\0') break;
    else {
      *write_at++ = '\\';
      *write_at++ = *read_at;
    }
  }
  *write_at = '\0';
}

bool journal_parse_counter(const char *text, uint64_t *out) {
  if (text == NULL || *text == '\0') return false;
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0') return false;
  *out = (uint64_t)value;
  return true;
}

int journal_write_record(char *out, size_t cap, uint64_t ino, uint64_t offset, uint64_t length) {
  int written = snprintf(out, cap, "%llu %llu %llu", (counter)ino, (counter)offset, (counter)length);
  return written < 0 || (size_t)written >= cap ? -ENAMETOOLONG : written;
}

/* Reads back the three decimals a W record's aux carries. */
static bool parse_write_aux(const char *aux, uint64_t *ino, uint64_t *offset, uint64_t *length) {
  char scratch[96];
  if (strlen(aux) >= sizeof(scratch)) return false;
  memcpy(scratch, aux, strlen(aux) + 1);
  char *save = NULL;
  const char *first = strtok_r(scratch, " ", &save);
  const char *second = strtok_r(NULL, " ", &save);
  const char *third = strtok_r(NULL, " ", &save);
  if (first == NULL || second == NULL || third == NULL || strtok_r(NULL, " ", &save) != NULL) return false;
  return journal_parse_counter(first, ino) && journal_parse_counter(second, offset)
         && journal_parse_counter(third, length);
}

/* ---------------------------------------------------------------- dirty --- */

void journal_dirty_init(struct journal_dirty_set *set) {
  set->files = NULL;
  set->count = 0;
  set->capacity = 0;
}

void journal_dirty_release(struct journal_dirty_set *set) {
  for (size_t index = 0; index < set->count; index++) {
    free(set->files[index].path);
    free(set->files[index].offsets);
    free(set->files[index].lengths);
  }
  free(set->files);
  journal_dirty_init(set);
}

struct journal_dirty_file *journal_dirty_find(struct journal_dirty_set *set, uint64_t ino) {
  for (size_t index = 0; index < set->count; index++) {
    if (set->files[index].ino == ino) return &set->files[index];
  }
  return NULL;
}

static int grow_files(struct journal_dirty_set *set) {
  if (set->count < set->capacity) return 0;
  size_t capacity = set->capacity == 0 ? 8 : set->capacity * 2;
  struct journal_dirty_file *grown = realloc(set->files, capacity * sizeof(*grown));
  if (grown == NULL) return -1;
  set->files = grown;
  set->capacity = capacity;
  return 0;
}

/* Unions [offset, offset+length) into one file's sorted, disjoint ranges. */
static int union_range(struct journal_dirty_file *file, uint64_t offset, uint64_t length) {
  size_t first = 0;
  while (first < file->count && file->offsets[first] + file->lengths[first] < offset) first++;
  size_t last = first;
  while (last < file->count && file->offsets[last] <= offset + length) last++;
  uint64_t start = offset;
  uint64_t end = offset + length;
  if (first < last) {
    if (file->offsets[first] < start) start = file->offsets[first];
    uint64_t tail = file->offsets[last - 1] + file->lengths[last - 1];
    if (tail > end) end = tail;
  }
  size_t removed = last - first;
  size_t kept = file->count - last;
  if (file->count + 1 > file->capacity) {
    size_t capacity = file->capacity == 0 ? 8 : file->capacity * 2;
    uint64_t *offsets = realloc(file->offsets, capacity * sizeof(*offsets));
    if (offsets == NULL) return -1;
    file->offsets = offsets;
    uint64_t *lengths = realloc(file->lengths, capacity * sizeof(*lengths));
    if (lengths == NULL) return -1;
    file->lengths = lengths;
    file->capacity = capacity;
  }
  if (removed != 1 || kept != 0) {
    memmove(file->offsets + first + 1, file->offsets + last, kept * sizeof(*file->offsets));
    memmove(file->lengths + first + 1, file->lengths + last, kept * sizeof(*file->lengths));
    file->count = file->count + 1 - removed;
  }
  file->offsets[first] = start;
  file->lengths[first] = end - start;
  return 0;
}

int journal_dirty_add(struct journal_dirty_set *set, uint64_t ino, const char *path, uint64_t offset,
                     uint64_t length) {
  struct journal_dirty_file *file = journal_dirty_find(set, ino);
  if (file == NULL) {
    if (grow_files(set) != 0) return -ENOMEM;
    file = &set->files[set->count++];
    memset(file, 0, sizeof(*file));
    file->ino = ino;
    file->path = copy_string(path);
    if (file->path == NULL) {
      set->count--;
      return -ENOMEM;
    }
  } else if (strcmp(file->path, path) != 0) {
    /* The newest name a write used is the best first guess at fence time. */
    char *renamed = copy_string(path);
    if (renamed == NULL) return -ENOMEM;
    free(file->path);
    file->path = renamed;
  }
  return union_range(file, offset, length) != 0 ? -ENOMEM : 0;
}

/* ------------------------------------------------------------ boundaries --- */

void journal_boundaries_init(struct journal_boundaries *map) {
  map->files = NULL;
  map->count = 0;
  map->capacity = 0;
}

void journal_boundaries_release(struct journal_boundaries *map) {
  for (size_t index = 0; index < map->count; index++) {
    free(map->files[index].path);
    free(map->files[index].boundaries);
  }
  free(map->files);
  journal_boundaries_init(map);
}

struct journal_boundaries_file *journal_boundaries_find(struct journal_boundaries *map, uint64_t ino) {
  for (size_t index = 0; index < map->count; index++) {
    if (map->files[index].ino == ino) return &map->files[index];
  }
  return NULL;
}

static void drop_boundary_file(struct journal_boundaries *map, size_t index) {
  free(map->files[index].path);
  free(map->files[index].boundaries);
  memmove(map->files + index, map->files + index + 1, (map->count - index - 1) * sizeof(*map->files));
  map->count--;
}

int journal_boundaries_merge(struct journal_boundaries *map, const struct journal_boundaries_file *files,
                             size_t count, const char *const *removed, size_t removed_count) {
  for (size_t index = 0; index < count; index++) {
    for (size_t at = 1; at < files[index].count; at++) {
      if (files[index].boundaries[at] <= files[index].boundaries[at - 1]) return -EINVAL;
    }
  }
  for (size_t index = 0; index < removed_count; index++) {
    for (size_t at = 0; at < map->count;) {
      if (strcmp(map->files[at].path, removed[index]) == 0) drop_boundary_file(map, at);
      else at++;
    }
  }
  for (size_t index = 0; index < count; index++) {
    const struct journal_boundaries_file *incoming = &files[index];
    uint64_t *boundaries = NULL;
    if (incoming->count > 0) {
      boundaries = malloc(incoming->count * sizeof(*boundaries));
      if (boundaries == NULL) return -ENOMEM;
      memcpy(boundaries, incoming->boundaries, incoming->count * sizeof(*boundaries));
    }
    struct journal_boundaries_file *existing = journal_boundaries_find(map, incoming->ino);
    if (existing != NULL) {
      char *path = copy_string(incoming->path);
      if (path == NULL) {
        free(boundaries);
        return -ENOMEM;
      }
      free(existing->boundaries);
      free(existing->path);
      existing->path = path;
      existing->boundaries = boundaries;
      existing->count = incoming->count;
      existing->size = incoming->size;
      continue;
    }
    if (map->count == map->capacity) {
      size_t capacity = map->capacity == 0 ? 8 : map->capacity * 2;
      struct journal_boundaries_file *grown = realloc(map->files, capacity * sizeof(*grown));
      if (grown == NULL) {
        free(boundaries);
        return -ENOMEM;
      }
      map->files = grown;
      map->capacity = capacity;
    }
    struct journal_boundaries_file *slot = &map->files[map->count];
    memset(slot, 0, sizeof(*slot));
    slot->path = copy_string(incoming->path);
    if (slot->path == NULL) {
      free(boundaries);
      return -ENOMEM;
    }
    slot->ino = incoming->ino;
    slot->size = incoming->size;
    slot->count = incoming->count;
    slot->boundaries = boundaries;
    map->count++;
  }
  return 0;
}

/* ------------------------------------------------- boundaries, decoded --- */

/* A cursor over one request line.  The daemon's control requests are machine
 * written and single-line, so this reads the shapes the protocol declares and
 * refuses everything else rather than being a general JSON parser. */
struct scan {
  const char *at;
};

static void skip_space(struct scan *scan) {
  while (*scan->at == ' ' || *scan->at == '\t' || *scan->at == '\n' || *scan->at == '\r') scan->at++;
}

static bool take(struct scan *scan, char expected) {
  skip_space(scan);
  if (*scan->at != expected) return false;
  scan->at++;
  return true;
}

static bool peek(struct scan *scan, char expected) {
  skip_space(scan);
  return *scan->at == expected;
}

/* Reads one JSON string into `out`, decoding the escapes the protocol uses. */
static bool scan_string(struct scan *scan, char *out, size_t cap) {
  if (!take(scan, '"')) return false;
  size_t used = 0;
  while (*scan->at != '"') {
    if (*scan->at == '\0') return false;
    char value = *scan->at++;
    if (value == '\\') {
      char escape = *scan->at++;
      if (escape == 'n') value = '\n';
      else if (escape == 't') value = '\t';
      else if (escape == 'r') value = '\r';
      else if (escape == 'b') value = '\b';
      else if (escape == 'f') value = '\f';
      else if (escape == '"' || escape == '\\' || escape == '/') value = escape;
      else if (escape == 'u') {
        unsigned code = 0;
        for (size_t index = 0; index < 4; index++) {
          char digit = *scan->at++;
          unsigned nibble;
          if (digit >= '0' && digit <= '9') nibble = (unsigned)(digit - '0');
          else if (digit >= 'a' && digit <= 'f') nibble = (unsigned)(digit - 'a') + 10;
          else if (digit >= 'A' && digit <= 'F') nibble = (unsigned)(digit - 'A') + 10;
          else return false;
          code = code * 16 + nibble;
        }
        if (code == 0 || code > 0x7f) return false;
        value = (char)code;
      } else return false;
    }
    if (used + 1 >= cap) return false;
    out[used++] = value;
  }
  scan->at++;
  out[used] = '\0';
  return true;
}

static bool scan_number(struct scan *scan, uint64_t *out) {
  skip_space(scan);
  const char *start = scan->at;
  uint64_t value = 0;
  while (*scan->at >= '0' && *scan->at <= '9') {
    uint64_t digit = (uint64_t)(*scan->at - '0');
    if (value > (UINT64_MAX - digit) / 10) return false;
    value = value * 10 + digit;
    scan->at++;
  }
  if (scan->at == start) return false;
  *out = value;
  return true;
}

/* Finds `"<key>":` at the top level of the request and leaves the cursor on
 * its value.  The control requests are flat objects with two array members,
 * so a keyed scan is exact without tracking nesting. */
static bool find_key(const char *request, const char *key, struct scan *scan) {
  char pattern[64];
  int written = snprintf(pattern, sizeof(pattern), "\"%s\":", key);
  if (written < 0 || (size_t)written >= sizeof(pattern)) return false;
  const char *found = strstr(request, pattern);
  if (found == NULL) return false;
  scan->at = found + written;
  return true;
}

static bool scan_boundary_list(struct scan *scan, struct journal_boundaries_file *file) {
  if (!take(scan, '[')) return false;
  size_t capacity = 0;
  if (peek(scan, ']')) return take(scan, ']');
  for (;;) {
    uint64_t value = 0;
    if (!scan_number(scan, &value)) return false;
    if (file->count == capacity) {
      capacity = capacity == 0 ? 16 : capacity * 2;
      uint64_t *grown = realloc(file->boundaries, capacity * sizeof(*grown));
      if (grown == NULL) return false;
      file->boundaries = grown;
    }
    file->boundaries[file->count++] = value;
    if (take(scan, ',')) continue;
    return take(scan, ']');
  }
}

static bool scan_boundary_file(struct scan *scan, struct journal_boundaries_file *file) {
  if (!take(scan, '{')) return false;
  char key[64];
  char path[JOURNAL_PATH_CAP];
  bool have_ino = false;
  bool have_path = false;
  bool have_size = false;
  bool have_boundaries = false;
  for (;;) {
    if (!scan_string(scan, key, sizeof(key)) || !take(scan, ':')) return false;
    if (strcmp(key, "ino") == 0) {
      char text[32];
      if (!scan_string(scan, text, sizeof(text)) || !journal_parse_counter(text, &file->ino)) return false;
      have_ino = true;
    } else if (strcmp(key, "path") == 0) {
      if (!scan_string(scan, path, sizeof(path))) return false;
      file->path = copy_string(path);
      if (file->path == NULL) return false;
      have_path = true;
    } else if (strcmp(key, "size") == 0) {
      if (!scan_number(scan, &file->size)) return false;
      have_size = true;
    } else if (strcmp(key, "boundaries") == 0) {
      if (!scan_boundary_list(scan, file)) return false;
      have_boundaries = true;
    } else {
      return false;
    }
    if (take(scan, ',')) continue;
    if (!take(scan, '}')) return false;
    return have_ino && have_path && have_size && have_boundaries;
  }
}

void journal_boundaries_update_release(struct journal_boundaries_update *out) {
  for (size_t index = 0; index < out->count; index++) {
    free(out->files[index].path);
    free(out->files[index].boundaries);
  }
  free(out->files);
  for (size_t index = 0; index < out->removed_count; index++) free(out->removed[index]);
  free(out->removed);
  memset(out, 0, sizeof(*out));
}

static int parse_files(const char *request, struct journal_boundaries_update *out) {
  struct scan scan;
  if (!find_key(request, "files", &scan)) return -EINVAL;
  if (!take(&scan, '[')) return -EINVAL;
  if (peek(&scan, ']')) return take(&scan, ']') ? 0 : -EINVAL;
  size_t capacity = 0;
  for (;;) {
    if (out->count == capacity) {
      capacity = capacity == 0 ? 8 : capacity * 2;
      struct journal_boundaries_file *grown = realloc(out->files, capacity * sizeof(*grown));
      if (grown == NULL) return -ENOMEM;
      out->files = grown;
    }
    struct journal_boundaries_file *file = &out->files[out->count];
    memset(file, 0, sizeof(*file));
    out->count++;
    if (!scan_boundary_file(&scan, file)) return -EINVAL;
    if (take(&scan, ',')) continue;
    return take(&scan, ']') ? 0 : -EINVAL;
  }
}

static int parse_removed(const char *request, struct journal_boundaries_update *out) {
  struct scan scan;
  if (!find_key(request, "removed", &scan)) return 0;
  if (!take(&scan, '[')) return -EINVAL;
  if (peek(&scan, ']')) return take(&scan, ']') ? 0 : -EINVAL;
  size_t capacity = 0;
  char path[JOURNAL_PATH_CAP];
  for (;;) {
    if (!scan_string(&scan, path, sizeof(path))) return -EINVAL;
    if (out->removed_count == capacity) {
      capacity = capacity == 0 ? 8 : capacity * 2;
      char **grown = realloc(out->removed, capacity * sizeof(*grown));
      if (grown == NULL) return -ENOMEM;
      out->removed = grown;
    }
    out->removed[out->removed_count] = copy_string(path);
    if (out->removed[out->removed_count] == NULL) return -ENOMEM;
    out->removed_count++;
    if (take(&scan, ',')) continue;
    return take(&scan, ']') ? 0 : -EINVAL;
  }
}

int journal_boundaries_parse(const char *request, struct journal_boundaries_update *out) {
  memset(out, 0, sizeof(*out));
  struct scan scan;
  char text[64];
  if (!find_key(request, "cut", &scan) || !scan_string(&scan, text, sizeof(text))
      || !journal_parse_counter(text, &out->cut)) return -EINVAL;
  if (!find_key(request, "generation", &scan) || !scan_string(&scan, text, sizeof(text))
      || !journal_parse_counter(text, &out->generation)) return -EINVAL;
  if (!find_key(request, "root", &scan) || !scan_string(&scan, out->root, sizeof(out->root))) return -EINVAL;
  if (!find_key(request, "maxChunkBytes", &scan) || !scan_number(&scan, &out->max_chunk)
      || out->max_chunk == 0) return -EINVAL;
  int rc = parse_files(request, out);
  if (rc == 0) rc = parse_removed(request, out);
  return rc;
}

/* --------------------------------------------------------------- windows --- */

void journal_stage_windows_release(struct journal_stage_windows *windows) {
  free(windows->items);
  windows->items = NULL;
  windows->count = 0;
  windows->capacity = 0;
}

static int push_window(struct journal_stage_windows *windows, uint64_t start, uint64_t end) {
  if (end <= start) return 0;
  if (windows->count > 0) {
    struct journal_stage_window *last = &windows->items[windows->count - 1];
    if (last->start + last->length >= start) {
      if (end > last->start + last->length) last->length = end - last->start;
      return 0;
    }
  }
  if (windows->count == windows->capacity) {
    size_t capacity = windows->capacity == 0 ? 8 : windows->capacity * 2;
    struct journal_stage_window *grown = realloc(windows->items, capacity * sizeof(*grown));
    if (grown == NULL) return -1;
    windows->items = grown;
    windows->capacity = capacity;
  }
  windows->items[windows->count].start = start;
  windows->items[windows->count].length = end - start;
  windows->count++;
  return 0;
}

/* The largest published boundary that is <= byte, or 0 when none is. */
static uint64_t boundary_before(const struct journal_boundaries_file *boundaries, uint64_t byte) {
  if (boundaries == NULL) return 0;
  uint64_t best = 0;
  for (size_t index = 0; index < boundaries->count; index++) {
    if (boundaries->boundaries[index] > byte) break;
    best = boundaries->boundaries[index];
  }
  return best;
}

int journal_stage_plan(const struct journal_dirty_file *file, const struct journal_boundaries_file *boundaries,
                       uint64_t max_chunk, struct journal_stage_windows *windows, uint64_t *bytes, bool *whole) {
  memset(windows, 0, sizeof(*windows));
  *bytes = 0;
  *whole = false;
  bool no_boundaries = boundaries == NULL || boundaries->count == 0;
  uint64_t context = 4 * max_chunk;
  if (no_boundaries) {
    if (push_window(windows, 0, file->size) != 0) return -ENOMEM;
    *bytes = file->size;
    *whole = true;
    return 0;
  }
  for (size_t index = 0; index < file->count; index++) {
    if (file->lengths[index] == 0) continue;
    uint64_t offset = file->offsets[index];
    uint64_t end = offset + file->lengths[index];
    uint64_t start = boundary_before(boundaries, offset);
    uint64_t wanted = end + context;
    if (wanted > file->size) wanted = file->size;
    if (push_window(windows, start, wanted) != 0) {
      journal_stage_windows_release(windows);
      return -ENOMEM;
    }
  }
  for (size_t index = 0; index < windows->count; index++) *bytes += windows->items[index].length;
  *whole = windows->count == 1 && windows->items[0].start == 0 && windows->items[0].length >= file->size;
  return 0;
}

/* ----------------------------------------------------------------- fence --- */

/* One metadata operation the delta replays, in journal order. */
struct meta_op {
  uint64_t sequence;
  char op[32];
  char *path;
  char *argument;
  long result;
};

/* One path the delta describes: a dirty file, a path a metadata op named, or
 * an ancestor directory of either. */
struct touched {
  char *path;
  uint64_t ino;
  struct stat st;
  bool present;
  bool dirty;
};

struct delta {
  struct journal_dirty_set dirty;
  struct meta_op *ops;
  size_t op_count;
  size_t op_capacity;
  struct touched *paths;
  size_t path_count;
  size_t path_capacity;
};

static void delta_release(struct delta *delta) {
  journal_dirty_release(&delta->dirty);
  for (size_t index = 0; index < delta->op_count; index++) {
    free(delta->ops[index].path);
    free(delta->ops[index].argument);
  }
  free(delta->ops);
  for (size_t index = 0; index < delta->path_count; index++) free(delta->paths[index].path);
  free(delta->paths);
  memset(delta, 0, sizeof(*delta));
}

/* A journaled operation that changes no tree state and needs no replay. */
static bool is_sync_op(const char *op) {
  return strcmp(op, "fsync") == 0 || strcmp(op, "fdatasync") == 0 || strcmp(op, "fsyncdir") == 0
         || strcmp(op, "fdatasyncdir") == 0;
}

/* The ops whose aux field names a second path rather than an argument. */
static bool aux_is_path(const char *op) {
  return strcmp(op, "rename") == 0 || strcmp(op, "link") == 0;
}

static int remember_op(struct delta *delta, uint64_t sequence, const char *op, const char *path, const char *aux,
                       long result) {
  if (delta->op_count == delta->op_capacity) {
    size_t capacity = delta->op_capacity == 0 ? 16 : delta->op_capacity * 2;
    struct meta_op *grown = realloc(delta->ops, capacity * sizeof(*grown));
    if (grown == NULL) return -ENOMEM;
    delta->ops = grown;
    delta->op_capacity = capacity;
  }
  struct meta_op *slot = &delta->ops[delta->op_count];
  memset(slot, 0, sizeof(*slot));
  if (strlen(op) >= sizeof(slot->op)) return -EUCLEAN;
  memcpy(slot->op, op, strlen(op) + 1);
  slot->sequence = sequence;
  slot->result = result;
  slot->path = copy_string(path);
  slot->argument = copy_string(aux);
  if (slot->path == NULL || slot->argument == NULL) {
    free(slot->path);
    free(slot->argument);
    return -ENOMEM;
  }
  delta->op_count++;
  return 0;
}

static struct touched *find_touched(struct delta *delta, const char *path) {
  for (size_t index = 0; index < delta->path_count; index++) {
    if (strcmp(delta->paths[index].path, path) == 0) return &delta->paths[index];
  }
  return NULL;
}

/* Records a path the manifest must describe, plus every ancestor directory of
 * it, so the delta is a consistent partial tree the sidecar can apply. */
static int remember_path(struct delta *delta, const char *path) {
  if (path[0] == '\0') return 0;
  if (find_touched(delta, path) != NULL) return 0;
  if (delta->path_count == delta->path_capacity) {
    size_t capacity = delta->path_capacity == 0 ? 16 : delta->path_capacity * 2;
    struct touched *grown = realloc(delta->paths, capacity * sizeof(*grown));
    if (grown == NULL) return -ENOMEM;
    delta->paths = grown;
    delta->path_capacity = capacity;
  }
  struct touched *slot = &delta->paths[delta->path_count];
  memset(slot, 0, sizeof(*slot));
  slot->path = copy_string(path);
  if (slot->path == NULL) return -ENOMEM;
  delta->path_count++;
  char parent[JOURNAL_PATH_CAP];
  const char *slash = strrchr(path, '/');
  if (slash == NULL) return 0;
  size_t length = (size_t)(slash - path);
  if (length >= sizeof(parent)) return -ENAMETOOLONG;
  memcpy(parent, path, length);
  parent[length] = '\0';
  return remember_path(delta, parent);
}

/* The journal records a path in the FUSE namespace, which is absolute; the
 * manifest and every backing lookup use the canonical relative name, so the
 * conversion happens once, here, on the way in. */
static const char *relative_name(const char *path) {
  return path[0] == '/' ? path + 1 : path;
}

/* Reads every record above `since` and derives the dirty set, the ordered
 * metadata operations, and the set of paths the manifest describes. */
static int read_delta(const struct journal_delta_request *request, struct delta *delta) {
  int fd = openat(request->state_fd, request->wal_name, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? 0 : neg_errno();
  FILE *journal = fdopen(fd, "r");
  if (journal == NULL) {
    int rc = neg_errno();
    close(fd);
    return rc;
  }
  char line[2 * JOURNAL_PATH_CAP + 512];
  int rc = 0;
  while (rc == 0 && fgets(line, sizeof(line), journal) != NULL) {
    char *fields[JOURNAL_RECORD_FIELDS];
    if (journal_record_split(line, fields) != 0) {
      rc = -EUCLEAN;
      break;
    }
    uint64_t sequence = 0;
    if (!journal_parse_counter(fields[0], &sequence)) {
      rc = -EUCLEAN;
      break;
    }
    if (sequence <= request->since) continue;
    const char *kind = fields[1];
    journal_field_unescape(fields[5]);
    journal_field_unescape(fields[6]);
    if (strcmp(kind, "W") == 0) {
      uint64_t ino = 0;
      uint64_t offset = 0;
      uint64_t length = 0;
      if (!parse_write_aux(fields[6], &ino, &offset, &length)) {
        rc = -EUCLEAN;
        break;
      }
      const char *written = relative_name(fields[5]);
      rc = journal_dirty_add(&delta->dirty, ino, written, offset, length);
      if (rc == 0) rc = remember_path(delta, written);
      continue;
    }
    if (strcmp(kind, "RESULT") != 0) continue;
    char *end = NULL;
    errno = 0;
    long result = strtol(fields[3], &end, 10);
    if (errno != 0 || end == fields[3] || *end != '\0') {
      rc = -EUCLEAN;
      break;
    }
    if (result < 0 || is_sync_op(fields[2])) continue;
    const char *touched = relative_name(fields[5]);
    bool second_path = aux_is_path(fields[2]) && fields[6][0] != '\0';
    const char *argument = second_path ? relative_name(fields[6]) : fields[6];
    rc = remember_op(delta, sequence, fields[2], touched, argument, result);
    if (rc == 0) rc = remember_path(delta, touched);
    if (rc == 0 && second_path) rc = remember_path(delta, argument);
  }
  if (rc == 0 && ferror(journal) != 0) rc = -EIO;
  fclose(journal);
  return rc;
}

static int compare_ops(const void *left, const void *right) {
  uint64_t a = ((const struct meta_op *)left)->sequence;
  uint64_t b = ((const struct meta_op *)right)->sequence;
  return a < b ? -1 : a > b ? 1 : 0;
}

/* Stats every remembered path against the backing root at the cut.  A path
 * that is gone is not an error: its removal is in the operation list. */
static int stat_touched(const struct journal_delta_request *request, struct delta *delta) {
  for (size_t index = 0; index < delta->path_count; index++) {
    struct touched *entry = &delta->paths[index];
    if (fstatat(request->root_fd, entry->path, &entry->st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT || errno == ENOTDIR) continue;
      return neg_errno();
    }
    entry->present = true;
    entry->ino = (uint64_t)entry->st.st_ino;
  }
  return 0;
}

/* Binds each dirty inode to the name it has at the cut, which is not always
 * the name its writes used: a rename moves it, an unlink retires it. */
static void bind_dirty_paths(struct delta *delta) {
  for (size_t index = 0; index < delta->dirty.count; index++) {
    struct journal_dirty_file *file = &delta->dirty.files[index];
    struct touched *named = find_touched(delta, file->path);
    if (named != NULL && named->present && named->ino == file->ino) {
      named->dirty = true;
      file->size = (uint64_t)named->st.st_size;
      continue;
    }
    struct touched *found = NULL;
    for (size_t at = 0; at < delta->path_count; at++) {
      if (delta->paths[at].present && delta->paths[at].ino == file->ino) {
        found = &delta->paths[at];
        break;
      }
    }
    if (found == NULL) {
      /* The inode is gone at the cut; the operation list carries its removal
       * and its bytes are no longer part of the tree. */
      file->count = 0;
      file->size = 0;
      continue;
    }
    found->dirty = true;
    file->size = (uint64_t)found->st.st_size;
    char *rebound = copy_string(found->path);
    if (rebound != NULL) {
      free(file->path);
      file->path = rebound;
    }
  }
}

/* --------------------------------------------------------------- staging --- */

/* One inode that has already been staged, with the exact JSON its rows carry.
 * A hardlink reaches the manifest once per name and must carry identical runs
 * under each of them, and the stage holds one copy: the bytes live under the
 * first name, and the second name repeats what the first one recorded. */
struct staged_inode {
  uint64_t ino;
  char *dirty;
  char *ranges;
  bool whole;
  struct staged_inode *next;
};

struct stage_ctx {
  FILE *out;
  int stage_fd;
  unsigned char *buffer;
  bool first_entry;
  struct staged_inode *staged;
  struct journal_seal_work work;
};

static struct staged_inode *find_staged(struct stage_ctx *ctx, uint64_t ino) {
  for (struct staged_inode *at = ctx->staged; at != NULL; at = at->next) {
    if (at->ino == ino) return at;
  }
  return NULL;
}

static void release_staged(struct stage_ctx *ctx) {
  for (struct staged_inode *at = ctx->staged; at != NULL;) {
    struct staged_inode *next = at->next;
    free(at->dirty);
    free(at->ranges);
    free(at);
    at = next;
  }
  ctx->staged = NULL;
}

void journal_json_string(FILE *out, const char *text) {
  fputc('"', out);
  for (const unsigned char *p = (const unsigned char *)text; *p != '\0'; p++) {
    if (*p == '"' || *p == '\\') fputc('\\', out);
    if (*p >= 0x20) fputc((int)*p, out);
    else fprintf(out, "\\u%04x", (unsigned)*p);
  }
  fputc('"', out);
}

static void json_base64(FILE *out, const unsigned char *bytes, size_t length) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  fputc('"', out);
  for (size_t i = 0; i < length; i += 3) {
    unsigned value = (unsigned)bytes[i] << 16;
    if (i + 1 < length) value |= (unsigned)bytes[i + 1] << 8;
    if (i + 2 < length) value |= bytes[i + 2];
    fputc(alphabet[(value >> 18) & 63], out);
    fputc(alphabet[(value >> 12) & 63], out);
    fputc(i + 1 < length ? alphabet[(value >> 6) & 63] : '=', out);
    fputc(i + 2 < length ? alphabet[value & 63] : '=', out);
  }
  fputc('"', out);
}

static void digest_hex(const unsigned char digest[SHA256_DIGEST_LENGTH], char out[65]) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t i = 0; i < SHA256_DIGEST_LENGTH; i++) {
    out[i * 2] = alphabet[digest[i] >> 4];
    out[i * 2 + 1] = alphabet[digest[i] & 0x0f];
  }
  out[64] = '\0';
}

static bool valid_utf8(const char *text) {
  const unsigned char *at = (const unsigned char *)text;
  while (*at != '\0') {
    size_t extra = *at < 0x80 ? 0 : (*at & 0xE0) == 0xC0 ? 1 : (*at & 0xF0) == 0xE0 ? 2 : (*at & 0xF8) == 0xF0 ? 3 : 4;
    if (extra == 4) return false;
    at++;
    for (size_t index = 0; index < extra; index++) {
      if ((*at & 0xC0) != 0x80) return false;
      at++;
    }
  }
  return true;
}

/* Writes the xattr map of one backing node. */
static int json_xattrs(FILE *out, int root_fd, const char *path, bool is_symlink) {
  if (is_symlink) {
    fputs("{}", out);
    return 0;
  }
  int fd = openat(root_fd, path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NOATIME);
  if (fd < 0) {
    if (errno == EPERM || errno == EACCES) {
      fd = openat(root_fd, path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (fd < 0) return neg_errno();
  }
  ssize_t names_size = flistxattr(fd, NULL, 0);
  if (names_size < 0) {
    int rc = errno == ENOTSUP ? 0 : neg_errno();
    close(fd);
    if (rc == 0) fputs("{}", out);
    return rc;
  }
  char *names = names_size == 0 ? NULL : malloc((size_t)names_size);
  if (names_size > 0 && names == NULL) {
    close(fd);
    return -ENOMEM;
  }
  int rc = names_size == 0 || flistxattr(fd, names, (size_t)names_size) >= 0 ? 0 : neg_errno();
  fputc('{', out);
  bool first = true;
  for (char *item = names; rc == 0 && item != NULL && item < names + names_size; item += strlen(item) + 1) {
    if (!valid_utf8(item)) {
      rc = -EILSEQ;
      break;
    }
    ssize_t value_size = fgetxattr(fd, item, NULL, 0);
    if (value_size < 0) {
      rc = neg_errno();
      break;
    }
    unsigned char *value = value_size == 0 ? NULL : malloc((size_t)value_size);
    if (value_size > 0 && value == NULL) {
      rc = -ENOMEM;
      break;
    }
    if (value_size > 0 && fgetxattr(fd, item, value, (size_t)value_size) != value_size) rc = neg_errno();
    if (rc == 0) {
      if (!first) fputc(',', out);
      first = false;
      journal_json_string(out, item);
      fputc(':', out);
      json_base64(out, value, (size_t)value_size);
    }
    free(value);
  }
  fputc('}', out);
  free(names);
  close(fd);
  return rc;
}

/* Creates every missing ancestor of `path` inside the stage. */
static int stage_parents(int stage_fd, const char *path) {
  char scratch[JOURNAL_PATH_CAP];
  if (strlen(path) >= sizeof(scratch)) return -ENAMETOOLONG;
  memcpy(scratch, path, strlen(path) + 1);
  for (char *slash = strchr(scratch, '/'); slash != NULL; slash = strchr(slash + 1, '/')) {
    *slash = '\0';
    if (mkdirat(stage_fd, scratch, 0700) != 0 && errno != EEXIST) return neg_errno();
    *slash = '/';
  }
  return 0;
}

/* Copies [start, end) of one file into the stage, skipping holes, and emits
 * one manifest extent per bounded run with the digest of the staged bytes. */
static int stage_window(struct stage_ctx *ctx, int from, int to, uint64_t start, uint64_t end, bool *first) {
  for (off_t position = (off_t)start; position < (off_t)end;) {
    off_t data = lseek(from, position, SEEK_DATA);
    if (data < 0) {
      if (errno == ENXIO) break;
      return neg_errno();
    }
    if (data >= (off_t)end) break;
    off_t hole = lseek(from, data, SEEK_HOLE);
    if (hole < 0) return neg_errno();
    if (hole > (off_t)end) hole = (off_t)end;
    for (off_t at = data; at < hole;) {
      size_t want = (size_t)(hole - at > JOURNAL_EXTENT_CAP ? JOURNAL_EXTENT_CAP : hole - at);
      ssize_t got = pread(from, ctx->buffer, want, at);
      if (got <= 0) return got < 0 ? neg_errno() : -EIO;
      ssize_t put = pwrite(to, ctx->buffer, (size_t)got, at);
      if (put != got) return put < 0 ? neg_errno() : -EIO;
      unsigned char digest[SHA256_DIGEST_LENGTH];
      SHA256(ctx->buffer, (size_t)got, digest);
      char hex[65];
      digest_hex(digest, hex);
      fprintf(ctx->out, "%s{\"offset\":%llu,\"length\":%llu,\"sha256\":\"%s\"}", *first ? "" : ",", (counter)at,
              (counter)got, hex);
      *first = false;
      ctx->work.bytes_staged += (uint64_t)got;
      at += got;
    }
    position = hole;
  }
  return 0;
}

/* Stages one dirty file's planned windows.  Two facts reach the manifest and
 * they are not the same fact: `dirty` is the union of the byte ranges WRITES
 * touched since the previous fence, which is where a re-chunk has to begin,
 * and `ranges` is what the stage actually holds — each dirty cluster grown to
 * its previous CDC boundaries — with the digest of the staged bytes. */
/* Writes the `dirty` array of one file into `out`: the byte ranges writes
 * touched, clamped to the size the file has at the cut. */
static void write_dirty(FILE *out, const struct journal_dirty_file *file, uint64_t size) {
  bool first = true;
  for (size_t index = 0; index < file->count; index++) {
    uint64_t offset = file->offsets[index];
    if (file->lengths[index] == 0 || offset >= size) continue;
    uint64_t length = file->lengths[index];
    if (offset + length > size) length = size - offset;
    fprintf(out, "%s{\"offset\":%llu,\"length\":%llu}", first ? "" : ",", (counter)offset, (counter)length);
    first = false;
  }
}

/* Copies the planned windows of one file into the stage and writes its
 * `ranges` array into `out`. */
static int copy_planned(struct stage_ctx *ctx, FILE *out, int root_fd, const struct journal_dirty_file *file,
                        const struct journal_stage_windows *windows, uint64_t size) {
  if (windows->count == 0) return 0;
  int rc = stage_parents(ctx->stage_fd, file->path);
  int from = -1;
  int to = -1;
  bool first = true;
  if (rc == 0) {
    from = openat(root_fd, file->path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (from < 0) rc = neg_errno();
  }
  if (rc == 0) {
    to = openat(ctx->stage_fd, file->path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (to < 0) rc = neg_errno();
  }
  if (rc == 0 && ftruncate(to, (off_t)size) != 0) rc = neg_errno();
  FILE *previous = ctx->out;
  ctx->out = out;
  for (size_t index = 0; rc == 0 && index < windows->count; index++) {
    rc = stage_window(ctx, from, to, windows->items[index].start,
                      windows->items[index].start + windows->items[index].length, &first);
  }
  ctx->out = previous;
  if (from >= 0) close(from);
  if (to >= 0) close(to);
  return rc;
}

/*
 * Stages one dirty file and writes its rows.
 *
 * The two arrays are different facts: `dirty` is what writes touched, which is
 * where a re-chunk begins, and `ranges` is what the stage holds — each dirty
 * cluster grown to its previous CDC boundaries — with the digest of the staged
 * bytes.  An inode reached under a second name (a hardlink) repeats the rows
 * the first name recorded rather than staging its bytes twice.
 */
static int stage_ranges(struct stage_ctx *ctx, int root_fd, const struct journal_dirty_file *file,
                        const struct journal_boundaries_file *boundaries, uint64_t max_chunk, uint64_t size) {
  struct staged_inode *known = find_staged(ctx, file->ino);
  if (known != NULL) {
    fprintf(ctx->out, ",\"whole\":%s,\"dirty\":[%s],\"ranges\":[%s]", known->whole ? "true" : "false",
            known->dirty, known->ranges);
    return 0;
  }

  struct journal_stage_windows windows;
  uint64_t planned = 0;
  bool whole = false;
  struct journal_dirty_file sized = *file;
  sized.size = size;
  int rc = journal_stage_plan(&sized, boundaries, max_chunk, &windows, &planned, &whole);
  if (rc != 0) return rc;

  char *dirty_text = NULL;
  size_t dirty_length = 0;
  char *ranges_text = NULL;
  size_t ranges_length = 0;
  FILE *dirty_out = open_memstream(&dirty_text, &dirty_length);
  FILE *ranges_out = dirty_out == NULL ? NULL : open_memstream(&ranges_text, &ranges_length);
  if (ranges_out == NULL) {
    if (dirty_out != NULL) fclose(dirty_out);
    free(dirty_text);
    journal_stage_windows_release(&windows);
    return -ENOMEM;
  }
  write_dirty(dirty_out, file, size);
  rc = copy_planned(ctx, ranges_out, root_fd, file, &windows, size);
  if (rc == 0 && (ferror(dirty_out) != 0 || ferror(ranges_out) != 0)) rc = -EIO;
  fclose(dirty_out);
  fclose(ranges_out);
  journal_stage_windows_release(&windows);

  struct staged_inode *record = rc == 0 ? calloc(1, sizeof(*record)) : NULL;
  if (rc == 0 && record == NULL) rc = -ENOMEM;
  if (rc != 0) {
    free(dirty_text);
    free(ranges_text);
    free(record);
    return rc;
  }
  if (whole) ctx->work.whole_files++;
  record->ino = file->ino;
  record->dirty = dirty_text == NULL ? copy_string("") : dirty_text;
  record->ranges = ranges_text == NULL ? copy_string("") : ranges_text;
  record->whole = whole;
  record->next = ctx->staged;
  ctx->staged = record;
  fprintf(ctx->out, ",\"whole\":%s,\"dirty\":[%s],\"ranges\":[%s]", whole ? "true" : "false", record->dirty,
          record->ranges);
  return 0;
}

static const char *kind_of(const struct stat *st) {
  if (S_ISREG(st->st_mode)) return "file";
  if (S_ISDIR(st->st_mode)) return "dir";
  if (S_ISLNK(st->st_mode)) return "symlink";
  return NULL;
}

static int write_entry(struct stage_ctx *ctx, const struct journal_delta_request *request, struct delta *delta,
                       const struct touched *entry) {
  const char *kind = kind_of(&entry->st);
  if (kind == NULL) return -EOPNOTSUPP;
  fprintf(ctx->out, "%s{\"path\":", ctx->first_entry ? "" : ",");
  ctx->first_entry = false;
  journal_json_string(ctx->out, entry->path);
  fprintf(ctx->out, ",\"kind\":\"%s\",\"ino\":\"%llu\",\"mode\":%u,\"uid\":%u,\"gid\":%u", kind,
          (counter)entry->ino, (unsigned)(entry->st.st_mode & 07777), (unsigned)entry->st.st_uid,
          (unsigned)entry->st.st_gid);
  fprintf(ctx->out, ",\"atimeNs\":\"%llu\",\"mtimeNs\":\"%llu\",\"ctimeNs\":\"%llu\"",
          (counter)((uint64_t)entry->st.st_atim.tv_sec * 1000000000ULL + (uint64_t)entry->st.st_atim.tv_nsec),
          (counter)((uint64_t)entry->st.st_mtim.tv_sec * 1000000000ULL + (uint64_t)entry->st.st_mtim.tv_nsec),
          (counter)((uint64_t)entry->st.st_ctim.tv_sec * 1000000000ULL + (uint64_t)entry->st.st_ctim.tv_nsec));
  fputs(",\"xattrs\":", ctx->out);
  int rc = json_xattrs(ctx->out, request->root_fd, entry->path, S_ISLNK(entry->st.st_mode));
  if (rc != 0) return rc;
  if (S_ISLNK(entry->st.st_mode)) {
    char target[JOURNAL_PATH_CAP];
    ssize_t length = readlinkat(request->root_fd, entry->path, target, sizeof(target) - 1);
    if (length < 0) return neg_errno();
    target[length] = '\0';
    fputs(",\"target\":", ctx->out);
    journal_json_string(ctx->out, target);
  } else if (S_ISREG(entry->st.st_mode)) {
    uint64_t size = (uint64_t)entry->st.st_size;
    fprintf(ctx->out, ",\"size\":%llu", (counter)size);
    struct journal_dirty_file *dirty = journal_dirty_find(&delta->dirty, entry->ino);
    if (dirty != NULL && dirty->count > 0) {
      const struct journal_boundaries_file *boundaries =
        request->boundaries == NULL
          ? NULL
          : journal_boundaries_find((struct journal_boundaries *)request->boundaries, entry->ino);
      rc = stage_ranges(ctx, request->root_fd, dirty, boundaries, request->max_chunk, size);
      if (rc != 0) return rc;
    } else {
      fputs(",\"whole\":false,\"dirty\":[],\"ranges\":[]", ctx->out);
    }
  }
  fputc('}', ctx->out);
  return 0;
}

/* A crashed fence leaves an unreferenced stage behind; the next attempt takes
 * a fresh name rather than reusing a directory it cannot trust. */
static int create_stage(int state_fd, uint64_t cut, uint64_t generation, char name[64]) {
  for (unsigned attempt = 0; attempt < STAGE_ATTEMPT_CAP; attempt++) {
    if (attempt == 0) snprintf(name, 64, "stage-g%llu-c%llu", (counter)generation, (counter)cut);
    else snprintf(name, 64, "stage-g%llu-c%llu-a%u", (counter)generation, (counter)cut, attempt);
    if (mkdirat(state_fd, name, 0700) == 0) {
      int fd = openat(state_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      return fd < 0 ? neg_errno() : fd;
    }
    if (errno != EEXIST) return neg_errno();
  }
  return -EEXIST;
}

static void write_manifest_head(struct stage_ctx *ctx, const struct journal_delta_request *request,
                                const char *stage_abs) {
  fprintf(ctx->out, "{\"version\":2,\"cut\":%llu,\"generation\":%llu,\"stageRoot\":", (counter)request->cut,
          (counter)request->generation);
  journal_json_string(ctx->out, stage_abs);
  if (request->has_base) {
    fprintf(ctx->out, ",\"base\":{\"cut\":\"%llu\",\"generation\":\"%llu\",\"root\":",
            (counter)request->base_cut, (counter)request->base_generation);
    journal_json_string(ctx->out, request->base_root);
    fputc('}', ctx->out);
  } else {
    fputs(",\"base\":null", ctx->out);
  }
  fputs(",\"entries\":[", ctx->out);
}

static void write_manifest_ops(struct stage_ctx *ctx, struct delta *delta) {
  fputs("],\"metadataOps\":[", ctx->out);
  for (size_t index = 0; index < delta->op_count; index++) {
    const struct meta_op *op = &delta->ops[index];
    fprintf(ctx->out, "%s{\"sequence\":%llu,\"op\":", index == 0 ? "" : ",", (counter)op->sequence);
    journal_json_string(ctx->out, op->op);
    fputs(",\"path\":", ctx->out);
    journal_json_string(ctx->out, op->path);
    fputs(",\"argument\":", ctx->out);
    journal_json_string(ctx->out, op->argument);
    fprintf(ctx->out, ",\"result\":%ld}", op->result);
  }
  fprintf(ctx->out,
          "],\"sealWork\":{\"bytesStaged\":%llu,\"bytesChunked\":%llu,\"chunksHashed\":%llu,"
          "\"nodesRewritten\":%llu,\"wholeFiles\":%llu}}\n",
          (counter)ctx->work.bytes_staged, (counter)ctx->work.bytes_chunked, (counter)ctx->work.chunks_hashed,
          (counter)ctx->work.nodes_rewritten, (counter)ctx->work.whole_files);
}

static int compare_touched(const void *left, const void *right) {
  return strcmp(((const struct touched *)left)->path, ((const struct touched *)right)->path);
}

int journal_delta_stage(const struct journal_delta_request *request, char manifest_path[JOURNAL_PATH_CAP],
                        struct journal_seal_work *work) {
  struct delta delta;
  memset(&delta, 0, sizeof(delta));
  journal_dirty_init(&delta.dirty);
  int rc = read_delta(request, &delta);
  if (rc == 0) rc = stat_touched(request, &delta);
  if (rc == 0) {
    if (delta.op_count > 1) qsort(delta.ops, delta.op_count, sizeof(*delta.ops), compare_ops);
    if (delta.path_count > 1) qsort(delta.paths, delta.path_count, sizeof(*delta.paths), compare_touched);
    bind_dirty_paths(&delta);
  }

  char stage_name[64];
  int stage_fd = rc == 0 ? create_stage(request->state_fd, request->cut, request->generation, stage_name) : rc;
  if (stage_fd < 0) {
    delta_release(&delta);
    return stage_fd;
  }

  char manifest_name[80];
  char temp_name[96];
  snprintf(manifest_name, sizeof(manifest_name), "fence-c%llu-g%llu.json", (counter)request->cut,
           (counter)request->generation);
  snprintf(temp_name, sizeof(temp_name), ".fence-c%llu-g%llu.tmp", (counter)request->cut,
           (counter)request->generation);
  int temp = openat(request->state_fd, temp_name, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (temp < 0) {
    rc = neg_errno();
    close(stage_fd);
    delta_release(&delta);
    return rc;
  }
  FILE *out = fdopen(temp, "w");
  if (out == NULL) {
    rc = neg_errno();
    close(temp);
    close(stage_fd);
    delta_release(&delta);
    return rc;
  }

  struct stage_ctx ctx;
  memset(&ctx, 0, sizeof(ctx));
  ctx.out = out;
  ctx.stage_fd = stage_fd;
  ctx.buffer = malloc(JOURNAL_EXTENT_CAP);
  ctx.first_entry = true;
  rc = ctx.buffer == NULL ? -ENOMEM : 0;

  char stage_abs[JOURNAL_PATH_CAP];
  if (rc == 0) {
    int written = snprintf(stage_abs, sizeof(stage_abs), "%s/%s", request->state_path, stage_name);
    rc = written < 0 || (size_t)written >= sizeof(stage_abs) ? -ENAMETOOLONG : 0;
  }
  if (rc == 0) {
    write_manifest_head(&ctx, request, stage_abs);
    for (size_t index = 0; rc == 0 && index < delta.path_count; index++) {
      if (!delta.paths[index].present) continue;
      rc = write_entry(&ctx, request, &delta, &delta.paths[index]);
    }
    if (rc == 0) write_manifest_ops(&ctx, &delta);
  }

  if (rc == 0 && ferror(out) != 0) rc = -EIO;
  /* Staged bytes reach the disk before the manifest that names them. */
  if (rc == 0 && fflush(out) != 0) rc = neg_errno();
  if (rc == 0 && syncfs(stage_fd) != 0) rc = neg_errno();
  if (rc == 0 && fsync(temp) != 0) rc = neg_errno();
  fclose(out);
  close(stage_fd);
  free(ctx.buffer);
  release_staged(&ctx);
  if (rc == 0 && renameat(request->state_fd, temp_name, request->state_fd, manifest_name) != 0) rc = neg_errno();
  if (rc == 0 && fsync(request->state_fd) != 0) rc = neg_errno();
  if (rc == 0) {
    int written = snprintf(manifest_path, JOURNAL_PATH_CAP, "%s/%s", request->state_path, manifest_name);
    if (written < 0 || written >= JOURNAL_PATH_CAP) rc = -ENAMETOOLONG;
  }
  if (rc != 0) unlinkat(request->state_fd, temp_name, 0);
  else *work = ctx.work;
  delta_release(&delta);
  return rc;
}
