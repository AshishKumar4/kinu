/*
 * A minimal FUSE filesystem whose files are DIRECT-IO, so the kernel refuses
 * every mmap over them with ENODEV.
 *
 * WHY IT EXISTS. `workspace-mount-contract.test.ts` asserts that the workspace
 * upper honours writable MAP_SHARED mappings and that SQLite's WAL therefore
 * works on it. A green assertion over a property nothing can break is not
 * evidence, so the same two probes run against this filesystem, which refuses
 * exactly that one capability and nothing else: reads, writes, truncate, fsync
 * and unlink all work, and the bytes are held in memory.
 *
 * No product code: a flat in-memory directory, libfuse3's high-level API, and
 * `fi->direct_io = 1` on every open.
 */
#define FUSE_USE_VERSION 31

#include <errno.h>
#include <fuse3/fuse.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_FILES 32
#define MAX_BYTES (64u * 1024u * 1024u)

struct held {
  char name[128];
  char *data;
  size_t size;
  size_t capacity;
  int used;
};

static struct held files[MAX_FILES];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static struct held *find(const char *path) {
  if (path[0] != '/') return NULL;
  for (int i = 0; i < MAX_FILES; i += 1) {
    if (files[i].used && strcmp(files[i].name, path + 1) == 0) return &files[i];
  }
  return NULL;
}

static struct held *make(const char *path) {
  if (path[0] != '/' || strlen(path + 1) >= sizeof(files[0].name)) return NULL;
  for (int i = 0; i < MAX_FILES; i += 1) {
    if (files[i].used) continue;
    files[i].used = 1;
    files[i].size = 0;
    files[i].capacity = 0;
    files[i].data = NULL;
    snprintf(files[i].name, sizeof(files[i].name), "%s", path + 1);
    return &files[i];
  }
  return NULL;
}

static int grow(struct held *file, size_t needed) {
  if (needed <= file->capacity) return 0;
  if (needed > MAX_BYTES) return -ENOSPC;
  size_t capacity = file->capacity == 0 ? 4096 : file->capacity;
  while (capacity < needed) capacity *= 2;
  if (capacity > MAX_BYTES) capacity = MAX_BYTES;
  char *grown = realloc(file->data, capacity);
  if (grown == NULL) return -ENOMEM;
  memset(grown + file->capacity, 0, capacity - file->capacity);
  file->data = grown;
  file->capacity = capacity;
  return 0;
}

static int fs_getattr(const char *path, struct stat *out, struct fuse_file_info *fi) {
  (void)fi;
  memset(out, 0, sizeof(*out));
  if (strcmp(path, "/") == 0) {
    out->st_mode = S_IFDIR | 0755;
    out->st_nlink = 2;
    return 0;
  }
  pthread_mutex_lock(&lock);
  struct held *file = find(path);
  int status = -ENOENT;
  if (file != NULL) {
    out->st_mode = S_IFREG | 0644;
    out->st_nlink = 1;
    out->st_size = (off_t)file->size;
    out->st_blksize = 4096;
    out->st_blocks = (blkcnt_t)((file->size + 511) / 512);
    status = 0;
  }
  pthread_mutex_unlock(&lock);
  return status;
}

static int fs_readdir(
  const char *path, void *buffer, fuse_fill_dir_t fill, off_t offset,
  struct fuse_file_info *fi, enum fuse_readdir_flags flags
) {
  (void)offset; (void)fi; (void)flags;
  if (strcmp(path, "/") != 0) return -ENOENT;
  fill(buffer, ".", NULL, 0, 0);
  fill(buffer, "..", NULL, 0, 0);
  pthread_mutex_lock(&lock);
  for (int i = 0; i < MAX_FILES; i += 1) {
    if (files[i].used) fill(buffer, files[i].name, NULL, 0, 0);
  }
  pthread_mutex_unlock(&lock);
  return 0;
}

static int fs_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
  (void)mode;
  pthread_mutex_lock(&lock);
  struct held *file = find(path);
  if (file == NULL) file = make(path);
  pthread_mutex_unlock(&lock);
  if (file == NULL) return -ENOSPC;
  /* THE ONE REFUSED CAPABILITY: direct io, so the kernel answers every mmap
   * over this file with ENODEV. */
  fi->direct_io = 1;
  return 0;
}

static int fs_open(const char *path, struct fuse_file_info *fi) {
  pthread_mutex_lock(&lock);
  struct held *file = find(path);
  pthread_mutex_unlock(&lock);
  if (file == NULL) return -ENOENT;
  fi->direct_io = 1;
  return 0;
}

static int fs_read(const char *path, char *out, size_t size, off_t offset, struct fuse_file_info *fi) {
  (void)fi;
  pthread_mutex_lock(&lock);
  struct held *file = find(path);
  int read = -ENOENT;
  if (file != NULL) {
    if ((size_t)offset >= file->size) read = 0;
    else {
      size_t available = file->size - (size_t)offset;
      size_t take = size < available ? size : available;
      memcpy(out, file->data + offset, take);
      read = (int)take;
    }
  }
  pthread_mutex_unlock(&lock);
  return read;
}

static int fs_write(const char *path, const char *in, size_t size, off_t offset, struct fuse_file_info *fi) {
  (void)fi;
  pthread_mutex_lock(&lock);
  struct held *file = find(path);
  int written = -ENOENT;
  if (file != NULL) {
    int grown = grow(file, (size_t)offset + size);
    if (grown != 0) written = grown;
    else {
      memcpy(file->data + offset, in, size);
      if ((size_t)offset + size > file->size) file->size = (size_t)offset + size;
      written = (int)size;
    }
  }
  pthread_mutex_unlock(&lock);
  return written;
}

static int fs_truncate(const char *path, off_t length, struct fuse_file_info *fi) {
  (void)fi;
  pthread_mutex_lock(&lock);
  struct held *file = find(path);
  int status = -ENOENT;
  if (file != NULL) {
    int grown = grow(file, (size_t)length);
    if (grown != 0) status = grown;
    else {
      if ((size_t)length > file->size) memset(file->data + file->size, 0, (size_t)length - file->size);
      file->size = (size_t)length;
      status = 0;
    }
  }
  pthread_mutex_unlock(&lock);
  return status;
}

static int fs_unlink(const char *path) {
  pthread_mutex_lock(&lock);
  struct held *file = find(path);
  int status = -ENOENT;
  if (file != NULL) {
    free(file->data);
    file->data = NULL;
    file->size = 0;
    file->capacity = 0;
    file->used = 0;
    status = 0;
  }
  pthread_mutex_unlock(&lock);
  return status;
}

static int fs_fsync(const char *path, int datasync, struct fuse_file_info *fi) {
  (void)path; (void)datasync; (void)fi;
  return 0;
}

static int fs_utimens(const char *path, const struct timespec tv[2], struct fuse_file_info *fi) {
  (void)path; (void)tv; (void)fi;
  return 0;
}

static int fs_statfs(const char *path, struct statvfs *out) {
  (void)path;
  memset(out, 0, sizeof(*out));
  out->f_bsize = 4096;
  out->f_frsize = 4096;
  out->f_blocks = MAX_BYTES / 4096;
  out->f_bfree = MAX_BYTES / 4096;
  out->f_bavail = MAX_BYTES / 4096;
  out->f_namemax = sizeof(files[0].name) - 1;
  return 0;
}

static const struct fuse_operations operations = {
  .getattr = fs_getattr,
  .readdir = fs_readdir,
  .create = fs_create,
  .open = fs_open,
  .read = fs_read,
  .write = fs_write,
  .truncate = fs_truncate,
  .unlink = fs_unlink,
  .fsync = fs_fsync,
  .utimens = fs_utimens,
  .statfs = fs_statfs,
};

int main(int argc, char **argv) {
  return fuse_main(argc, argv, &operations, NULL);
}
