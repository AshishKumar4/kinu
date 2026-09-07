/** The SQLite page size the daemon's namespace is written with, and the
 *  unit its page map addresses. `journal-namespace.c` sets it with
 *  `PRAGMA page_size`; the daemon's fence and the page map assume it. */
export const NAMESPACE_PAGE_BYTES = 4096;
