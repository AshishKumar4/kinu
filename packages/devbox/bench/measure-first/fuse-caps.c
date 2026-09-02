/* Lane 0 probe: what the platform kernel offers a FUSE filesystem.
 *
 * Mounts an empty high-level filesystem, records the negotiated connection in
 * `init`, prints one JSON line and unmounts.  Nothing else.  The one number
 * that gates the design is `FUSE_CAP_PASSTHROUGH` in `conn->capable`; the rest
 * of the line is context a reader needs to trust that bit (kernel protocol,
 * max_write, the other caps).
 */

#define FUSE_USE_VERSION 317
#define _GNU_SOURCE

#include <fuse3/fuse.h>
#include <fuse3/fuse_lowlevel.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static struct fuse *probe_fuse;

struct named_cap {
  const char *name;
  uint64_t bit;
};

static const struct named_cap CAPS[] = {
  {"ASYNC_READ", FUSE_CAP_ASYNC_READ},
  {"POSIX_LOCKS", FUSE_CAP_POSIX_LOCKS},
  {"ATOMIC_O_TRUNC", FUSE_CAP_ATOMIC_O_TRUNC},
  {"EXPORT_SUPPORT", FUSE_CAP_EXPORT_SUPPORT},
  {"DONT_MASK", FUSE_CAP_DONT_MASK},
  {"SPLICE_WRITE", FUSE_CAP_SPLICE_WRITE},
  {"SPLICE_MOVE", FUSE_CAP_SPLICE_MOVE},
  {"SPLICE_READ", FUSE_CAP_SPLICE_READ},
  {"FLOCK_LOCKS", FUSE_CAP_FLOCK_LOCKS},
  {"IOCTL_DIR", FUSE_CAP_IOCTL_DIR},
  {"AUTO_INVAL_DATA", FUSE_CAP_AUTO_INVAL_DATA},
  {"READDIRPLUS", FUSE_CAP_READDIRPLUS},
  {"READDIRPLUS_AUTO", FUSE_CAP_READDIRPLUS_AUTO},
  {"ASYNC_DIO", FUSE_CAP_ASYNC_DIO},
  {"WRITEBACK_CACHE", FUSE_CAP_WRITEBACK_CACHE},
  {"NO_OPEN_SUPPORT", FUSE_CAP_NO_OPEN_SUPPORT},
  {"PARALLEL_DIROPS", FUSE_CAP_PARALLEL_DIROPS},
  {"POSIX_ACL", FUSE_CAP_POSIX_ACL},
  {"HANDLE_KILLPRIV", FUSE_CAP_HANDLE_KILLPRIV},
  {"CACHE_SYMLINKS", FUSE_CAP_CACHE_SYMLINKS},
  {"NO_OPENDIR_SUPPORT", FUSE_CAP_NO_OPENDIR_SUPPORT},
  {"EXPLICIT_INVAL_DATA", FUSE_CAP_EXPLICIT_INVAL_DATA},
  {"EXPIRE_ONLY", FUSE_CAP_EXPIRE_ONLY},
  {"SETXATTR_EXT", FUSE_CAP_SETXATTR_EXT},
  {"HANDLE_KILLPRIV_V2", FUSE_CAP_HANDLE_KILLPRIV_V2},
  {"DIRECT_IO_ALLOW_MMAP", FUSE_CAP_DIRECT_IO_ALLOW_MMAP},
  {"PASSTHROUGH", FUSE_CAP_PASSTHROUGH},
  {"NO_EXPORT_SUPPORT", FUSE_CAP_NO_EXPORT_SUPPORT},
};

static void *caps_init(struct fuse_conn_info *conn, struct fuse_config *cfg) {
  (void)cfg;
  printf("{\"protoMajor\":%u,\"protoMinor\":%u,\"capable\":%u,\"capableExt\":%llu,\"wantExt\":%llu,"
         "\"maxWrite\":%u,\"maxRead\":%u,\"maxReadahead\":%u,\"maxBackgroundDefault\":%u,"
         "\"passthrough\":%s,\"directIoAllowMmap\":%s,\"caps\":[",
         conn->proto_major, conn->proto_minor, conn->capable, (unsigned long long)conn->capable_ext,
         (unsigned long long)conn->want_ext, conn->max_write, conn->max_read, conn->max_readahead,
         conn->max_background, (conn->capable & FUSE_CAP_PASSTHROUGH) != 0 ? "true" : "false",
         (conn->capable & FUSE_CAP_DIRECT_IO_ALLOW_MMAP) != 0 ? "true" : "false");
  bool first = true;
  for (size_t i = 0; i < sizeof(CAPS) / sizeof(CAPS[0]); i++) {
    if ((conn->capable_ext & CAPS[i].bit) == 0) continue;
    printf("%s\"%s\"", first ? "" : ",", CAPS[i].name);
    first = false;
  }
  printf("]}\n");
  fflush(stdout);
  fuse_exit(probe_fuse);
  return NULL;
}

static int caps_getattr(const char *path, struct stat *st, struct fuse_file_info *fi) {
  (void)fi;
  if (strcmp(path, "/") != 0) return -ENOENT;
  memset(st, 0, sizeof(*st));
  st->st_mode = S_IFDIR | 0755;
  st->st_nlink = 2;
  return 0;
}

static const struct fuse_operations OPERATIONS = {
  .init = caps_init,
  .getattr = caps_getattr,
};

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: %s MOUNTPOINT\n", argv[0]);
    return 2;
  }
  struct fuse_args args = FUSE_ARGS_INIT(0, NULL);
  if (fuse_opt_add_arg(&args, argv[0]) != 0) return 3;
  probe_fuse = fuse_new(&args, &OPERATIONS, sizeof(OPERATIONS), NULL);
  fuse_opt_free_args(&args);
  if (probe_fuse == NULL) {
    fprintf(stderr, "fuse-caps: cannot create the session\n");
    return 3;
  }
  if (fuse_mount(probe_fuse, argv[1]) != 0) {
    fprintf(stderr, "fuse-caps: cannot mount %s: %s\n", argv[1], strerror(errno));
    fuse_destroy(probe_fuse);
    return 3;
  }
  /* The kernel sends INIT as the first request on the connection, so the loop
   * runs exactly one request: init prints, asks the session to exit, and
   * fuse_loop returns. */
  int status = fuse_loop(probe_fuse);
  fuse_unmount(probe_fuse);
  fuse_destroy(probe_fuse);
  return status == 0 ? 0 : 1;
}
