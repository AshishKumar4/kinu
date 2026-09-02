/**
 * The lane 0 candidate daemon: today's `journal-daemon.c` plus four compile-time
 * knobs, produced by exact-anchor edits so the probe image builds the same
 * source the tests prove, with a change a reader can diff in one screen.
 *
 * Nothing here is product code. The daemon's own recipe still builds
 * `kinu-journal-daemon` unchanged; the probe compiles THIS text beside it under
 * `-DMEASURE_*` flags and mounts each build at its own path.
 *
 *   MEASURE_KEEP_CACHE_READS   read-only opens drop `direct_io` and set
 *                              `keep_cache`, so the page cache serves re-reads
 *   MEASURE_PASSTHROUGH_READS  read-only opens register the backing fd with
 *                              FUSE_DEV_IOC_BACKING_OPEN when the kernel offers
 *                              FUSE_CAP_PASSTHROUGH, else behave as keep_cache
 *   MEASURE_NO_WAL_FSYNC       the writer thread appends records with write(2)
 *                              only; no fdatasync on the write path
 *   MEASURE_ATTR_CACHE         entry, attr and negative timeouts of 30 s
 *
 * Every anchor below is asserted to occur exactly once in the source, so a
 * daemon edit that moves a line fails this build loudly rather than measuring
 * a daemon that lacks the knob it claims.
 */

function replaceOnce(source: string, anchor: string, replacement: string, what: string): string {
  const first = source.indexOf(anchor);
  if (first === -1) throw new Error(`candidate daemon: anchor for ${what} is absent from journal-daemon.c`);
  if (source.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`candidate daemon: anchor for ${what} occurs more than once in journal-daemon.c`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`;
}

const HELPERS = `static struct journal state;

/* MEASURE (lane 0): compiled in by the measure-first probe only. */
#if defined(MEASURE_KEEP_CACHE_READS) || defined(MEASURE_PASSTHROUGH_READS)
#ifdef MEASURE_PASSTHROUGH_READS
#include <sys/ioctl.h>
#define MEASURE_BACKING_CAP 65536
static bool measure_passthrough_capable;
static int32_t measure_backing_ids[MEASURE_BACKING_CAP];
#endif
static void measure_read_open(int fd, struct fuse_file_info *fi) {
#ifdef MEASURE_PASSTHROUGH_READS
  if (measure_passthrough_capable && fd >= 0 && fd < MEASURE_BACKING_CAP) {
    struct fuse_backing_map map = {.fd = fd, .flags = 0, .padding = 0};
    int backing_id = ioctl(fuse_session_fd(fuse_get_session(state.fuse)), FUSE_DEV_IOC_BACKING_OPEN, &map);
    if (backing_id > 0) {
      measure_backing_ids[fd] = backing_id;
      fi->backing_id = backing_id;
      fi->direct_io = 0;
      fi->keep_cache = 0;
      return;
    }
    fprintf(stderr, "journal-daemon: FUSE_DEV_IOC_BACKING_OPEN failed: %s\\n", strerror(errno));
  }
#else
  (void)fd;
#endif
  fi->direct_io = 0;
  fi->keep_cache = 1;
}
static void measure_read_release(int fd) {
#ifdef MEASURE_PASSTHROUGH_READS
  if (fd >= 0 && fd < MEASURE_BACKING_CAP && measure_backing_ids[fd] > 0) {
    uint32_t backing_id = (uint32_t)measure_backing_ids[fd];
    measure_backing_ids[fd] = 0;
    if (ioctl(fuse_session_fd(fuse_get_session(state.fuse)), FUSE_DEV_IOC_BACKING_CLOSE, &backing_id) < 0) {
      fprintf(stderr, "journal-daemon: FUSE_DEV_IOC_BACKING_CLOSE failed: %s\\n", strerror(errno));
    }
  }
#else
  (void)fd;
#endif
}
#endif
`;

const INIT_ANCHOR = '  if ((conn->capable & FUSE_CAP_ATOMIC_O_TRUNC) != 0) conn->want |= FUSE_CAP_ATOMIC_O_TRUNC;\n';
const INIT_KNOBS = `${INIT_ANCHOR}#ifdef MEASURE_ATTR_CACHE
  cfg->entry_timeout = 30;
  cfg->attr_timeout = 30;
  cfg->negative_timeout = 30;
#endif
#ifdef MEASURE_PASSTHROUGH_READS
  measure_passthrough_capable = (conn->capable & FUSE_CAP_PASSTHROUGH) != 0;
  if (measure_passthrough_capable) {
    conn->want |= FUSE_CAP_PASSTHROUGH;
    conn->max_backing_stack_depth = FUSE_BACKING_STACKED_OVER;
  } else {
    fprintf(stderr, "journal-daemon: kernel offers no FUSE_CAP_PASSTHROUGH; read-only opens use keep_cache\\n");
  }
#endif
`;

const OPEN_ANCHOR = '  fi->fh = (uint64_t)fd;\n  fi->direct_io = 1;\n  return 0;\n}\n';
const OPEN_KNOBS = `  fi->fh = (uint64_t)fd;
  fi->direct_io = 1;
#if defined(MEASURE_KEEP_CACHE_READS) || defined(MEASURE_PASSTHROUGH_READS)
  if ((flags & O_ACCMODE) == O_RDONLY) measure_read_open(fd, fi);
#endif
  return 0;
}
`;

const RELEASE_ANCHOR = 'static int pass_release(const char *path, struct fuse_file_info *fi) {\n  (void)path;\n';
const RELEASE_KNOBS = `${RELEASE_ANCHOR}#if defined(MEASURE_KEEP_CACHE_READS) || defined(MEASURE_PASSTHROUGH_READS)
  measure_read_release((int)fi->fh);
#endif
`;

const FSYNC_ANCHOR = '    if (rc == 0 && fdatasync(state.wal_fd) != 0) rc = neg_errno();\n';
const FSYNC_KNOBS = `#ifndef MEASURE_NO_WAL_FSYNC
${FSYNC_ANCHOR}#endif
`;

/** The daemon text with the four knobs in place. Pure: the same input gives
 *  the same output, and the probe digests both. */
export function candidateDaemonSource(original: string): string {
  let source = replaceOnce(original, 'static struct journal state;\n', HELPERS, 'the state helpers');
  source = replaceOnce(source, INIT_ANCHOR, INIT_KNOBS, 'init');
  source = replaceOnce(source, OPEN_ANCHOR, OPEN_KNOBS, 'open_handle');
  source = replaceOnce(source, RELEASE_ANCHOR, RELEASE_KNOBS, 'pass_release');
  source = replaceOnce(source, FSYNC_ANCHOR, FSYNC_KNOBS, 'the writer fdatasync');
  return source;
}

/** One built binary per column of the section 5 table. `flags` is the whole
 *  difference between a column and today's daemon. */
export interface DaemonBuild {
  readonly name: string;
  readonly flags: readonly string[];
}

export const DAEMON_BUILDS: readonly DaemonBuild[] = [
  { name: 'jd-keepcache', flags: ['-DMEASURE_KEEP_CACHE_READS'] },
  { name: 'jd-nofsync', flags: ['-DMEASURE_NO_WAL_FSYNC'] },
  { name: 'jd-v2', flags: ['-DMEASURE_KEEP_CACHE_READS', '-DMEASURE_NO_WAL_FSYNC', '-DMEASURE_ATTR_CACHE'] },
  { name: 'jd-pt', flags: ['-DMEASURE_PASSTHROUGH_READS', '-DMEASURE_NO_WAL_FSYNC', '-DMEASURE_ATTR_CACHE'] },
];
