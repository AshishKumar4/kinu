use crate::index::{hash, hex, invalid, lookup, IndexRef, Source, BLOCK};
use crate::model::{path_valid, Record};
use crate::namespace::PathMap;
use serde::Serialize;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub struct Root {
    file: File,
}

impl Root {
    pub fn open(path: &Path) -> io::Result<Self> {
        Ok(Self {
            file: OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(path)?,
        })
    }

    /// Resolve from an anchored directory fd; no component follows a symlink.
    pub fn file(&self, path: &str) -> io::Result<Option<File>> {
        if !path_valid(path) {
            return Err(invalid("hostile relative path"));
        }
        let mut directory = self.file.try_clone()?;
        let parts: Vec<_> = path.split('/').collect();
        for (i, part) in parts.iter().enumerate() {
            let name = CString::new(*part).map_err(|_| invalid("nul in path"))?;
            let flags = libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if i + 1 < parts.len() {
                    libc::O_DIRECTORY
                } else {
                    0
                };
            // SAFETY: directory owns a live fd; name is NUL-terminated. The
            // returned descriptor is owned once, immediately below.
            let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ENOENT) {
                    return Ok(None);
                }
                if error.raw_os_error() == Some(libc::ENOTDIR) {
                    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                    // SAFETY: stat is writable storage and both fd/name are live.
                    let checked = unsafe {
                        libc::fstatat(
                            directory.as_raw_fd(),
                            name.as_ptr(),
                            stat.as_mut_ptr(),
                            libc::AT_SYMLINK_NOFOLLOW,
                        )
                    };
                    if checked != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    // SAFETY: successful fstatat initialized every field.
                    if unsafe { stat.assume_init() }.st_mode & libc::S_IFMT == libc::S_IFLNK {
                        return Err(invalid("symlink ancestor refused"));
                    }
                    return Ok(None);
                }
                return Err(error);
            }
            // SAFETY: openat returned this fresh descriptor successfully.
            directory = unsafe { File::from_raw_fd(fd) };
        }
        if !directory.metadata()?.is_file() {
            return Err(invalid("source is not a regular file"));
        }
        Ok(Some(directory))
    }

    pub fn required(&self, path: &str) -> io::Result<File> {
        self.file(path)?
            .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "missing delta source"))
    }

    pub fn stat_root(&self) -> io::Result<libc::stat> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: stat is writable storage and the fd is live.
        if unsafe { libc::fstat(self.file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful fstat initialized every field.
        Ok(unsafe { stat.assume_init() })
    }

    /// What an overlay lower holds at `path`, walking from the anchored root
    /// without following a symlink. A whiteout or a non-directory at an
    /// ancestor hides the path, as an opaque ancestor does.
    pub fn probe(&self, path: &str) -> io::Result<Presence> {
        if !path_valid(path) {
            return Err(invalid("hostile relative path"));
        }
        let mut directory = self.file.try_clone()?;
        let parts: Vec<_> = path.split('/').collect();
        for (i, part) in parts.iter().enumerate() {
            if stat_at(&directory, &format!(".wh.{part}"))?.is_some() {
                return Ok(Presence::Hidden);
            }
            let Some(found) = stat_at(&directory, part)? else {
                // An opaque directory hides what the lowers hold beneath it.
                return Ok(if stat_at(&directory, ".wh..wh..opq")?.is_some() {
                    Presence::Hidden
                } else {
                    Presence::Absent
                });
            };
            if i + 1 == parts.len() {
                return Ok(Presence::Present(found));
            }
            if found.st_mode & libc::S_IFMT != libc::S_IFDIR {
                return Ok(Presence::Hidden);
            }
            let name = CString::new(*part).map_err(|_| invalid("nul in path"))?;
            // SAFETY: directory owns a live fd; name is NUL-terminated. The
            // returned descriptor is owned once, immediately below.
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: openat returned this fresh descriptor successfully.
            directory = unsafe { File::from_raw_fd(fd) };
        }
        Ok(Presence::Absent)
    }
}

pub enum Presence {
    Absent,
    Hidden,
    Present(libc::stat),
}

fn stat_at(directory: &File, name: &str) -> io::Result<Option<libc::stat>> {
    let name = CString::new(name).map_err(|_| invalid("nul in path"))?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: stat is writable storage and both fd/name are live.
    let checked = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if checked != 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    // SAFETY: successful fstatat initialized every field.
    Ok(Some(unsafe { stat.assume_init() }))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub payload_bytes: u64,
    pub index_pages: u64,
    pub read_requests: u64,
}

/// One delta layer: its overlay `tree/`, and the block records of
/// `.devbox-delta/` when it has any.
pub struct Layer {
    pub tree: Root,
    pub meta: Option<Root>,
    pub files: Vec<Record>,
    records: PathMap<usize>,
}

impl Layer {
    pub fn new(tree: Root, meta: Option<Root>, files: Vec<Record>) -> Self {
        let records = files
            .iter()
            .enumerate()
            .map(|(at, record)| (record.p.as_str(), at))
            .collect();
        Self {
            tree,
            meta,
            files,
            records,
        }
    }

    pub fn record(&self, path: &str) -> Option<&Record> {
        self.records.get(path).map(|at| &self.files[*at])
    }
}

/// Where a block of a served file comes from, newest version first.
enum Version {
    /// A layer's record, with that version's own size: its index and chunks were cut to it.
    Blocks(usize, IndexRef, u64),
    Whole(File),
}

pub struct Storage {
    pub base: Root,
    /// Oldest first.
    pub layers: Vec<Layer>,
    pub metrics: Metrics,
    pub stats: PathBuf,
    versions: PathMap<Vec<Version>>,
}

impl Storage {
    pub fn new(base: Root, layers: Vec<Layer>, stats: PathBuf) -> Self {
        Self {
            base,
            layers,
            metrics: Metrics::default(),
            stats,
            versions: PathMap::new(),
        }
    }

    pub fn save_metrics(&self) -> io::Result<()> {
        std::fs::write(&self.stats, serde_json::to_vec(&self.metrics)?)
    }

    /// Whether a layer above `layer` replaced or removed `path`: then the
    /// overlay serves that layer's version and this record is not the file.
    pub fn shadowed(&self, layer: usize, path: &str) -> io::Result<bool> {
        for above in &self.layers[layer + 1..] {
            if above.record(path).is_some() || !matches!(above.tree.probe(path)?, Presence::Absent)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The versions a block of `path` resolves through, from `layer` down to
    /// the base: each record falls through to the one below for the blocks it
    /// does not hold, and the first whole file ends the chain.
    fn chain(&self, layer: usize, path: &str) -> io::Result<Vec<Version>> {
        let mut out = Vec::new();
        for at in (0..=layer).rev() {
            let current = &self.layers[at];
            if let Some(record) = current.record(path) {
                out.push(Version::Blocks(at, record.over.clone(), record.s));
                continue;
            }
            match current.tree.probe(path)? {
                Presence::Absent => continue,
                Presence::Hidden => return Err(invalid("a block record has no earlier version")),
                Presence::Present(_) => {
                    out.push(Version::Whole(current.tree.required(path)?));
                    return Ok(out);
                }
            }
        }
        let base = self
            .base
            .file(path)?
            .ok_or_else(|| invalid("a block record has no earlier version"))?;
        out.push(Version::Whole(base));
        Ok(out)
    }

    pub fn read(
        &mut self,
        path: &str,
        layer: usize,
        size: u64,
        offset: u64,
        length: u32,
    ) -> io::Result<Vec<u8>> {
        self.metrics.read_requests += 1;
        let count = u64::from(length).min(size.saturating_sub(offset));
        let mut result = vec![0; usize::try_from(count).map_err(|_| invalid("read length"))?];
        if count == 0 {
            return Ok(result);
        }
        if self.versions.get(path).is_none() {
            let chain = self.chain(layer, path)?;
            self.versions.insert(path, chain);
        }
        let mut cursor = offset;
        while cursor < offset + count {
            let block = cursor / BLOCK * BLOCK;
            let end = (block + BLOCK).min(offset + count);
            let start = usize::try_from(cursor - offset).map_err(|_| invalid("read offset"))?;
            let stop = usize::try_from(end - offset).map_err(|_| invalid("read offset"))?;
            self.block(path, block, cursor, &mut result[start..stop])?;
            cursor = end;
        }
        Ok(result)
    }

    /// Fills `out` with `path`'s bytes from `cursor`, all within `block`; a version shorter than
    /// the served file reads as zeros past its end.
    fn block(&mut self, path: &str, block: u64, cursor: u64, out: &mut [u8]) -> io::Result<()> {
        let Self {
            versions,
            layers,
            metrics,
            ..
        } = self;
        let chain = versions
            .get(path)
            .ok_or_else(|| invalid("unresolved file"))?;
        for version in chain {
            match version {
                Version::Blocks(at, reference, size) => {
                    let size = *size;
                    if block >= size {
                        out.fill(0);
                        return Ok(());
                    }
                    let meta = layers[*at]
                        .meta
                        .as_ref()
                        .ok_or_else(|| invalid("a record without its layer"))?;
                    let index = meta.required(&format!(".devbox-delta/{}", reference.index))?;
                    if index.metadata()?.len() != reference.count * 128 {
                        return Err(invalid("index length mismatch"));
                    }
                    match lookup(reference, size, block, |at, page| {
                        metrics.index_pages += 1;
                        index.read_exact_at(page, at)
                    })? {
                        Source::Base => continue,
                        Source::Hole => out.fill(0),
                        Source::Chunk(digest) => {
                            let chunk =
                                meta.required(&format!(".devbox-delta/chunks/{}", hex(&digest)))?;
                            let needed = (size - block).min(BLOCK);
                            if chunk.metadata()?.len() != needed {
                                return Err(invalid("chunk length mismatch"));
                            }
                            let mut bytes = vec![
                                0;
                                usize::try_from(needed)
                                    .map_err(|_| invalid("chunk size"))?
                            ];
                            chunk.read_exact_at(&mut bytes, 0)?;
                            metrics.payload_bytes += needed;
                            if hash(&bytes) != digest {
                                return Err(invalid("corrupt chunk"));
                            }
                            let from = usize::try_from(cursor - block)
                                .map_err(|_| invalid("chunk range"))?;
                            let n = bytes.len().saturating_sub(from).min(out.len());
                            out[..n].copy_from_slice(&bytes[from..from + n]);
                            out[n..].fill(0);
                        }
                    }
                    return Ok(());
                }
                Version::Whole(file) => {
                    let available = file
                        .metadata()?
                        .len()
                        .saturating_sub(cursor)
                        .min(out.len() as u64);
                    let n = usize::try_from(available).map_err(|_| invalid("earlier range"))?;
                    file.read_exact_at(&mut out[..n], cursor)?;
                    out[n..].fill(0);
                    metrics.payload_bytes += available;
                    return Ok(());
                }
            }
        }
        Err(invalid("a block resolved to no version"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The index a producer writes for `entries` (block offset, chunk or hole), sorted by offset.
    fn index(entries: &[(u64, Option<[u8; 32]>)]) -> (IndexRef, Vec<u8>) {
        let mut pages = vec![[0_u8; 128]; entries.len()];
        fn build(
            pages: &mut [[u8; 128]],
            entries: &[(u64, Option<[u8; 32]>)],
            lo: usize,
            hi: usize,
        ) -> [u8; 32] {
            if lo == hi {
                return [0; 32];
            }
            let mid = lo + (hi - lo) / 2;
            let left = build(pages, entries, lo, mid);
            let right = build(pages, entries, mid + 1, hi);
            let (at, chunk) = entries[mid];
            let page = &mut pages[mid];
            page[..8].copy_from_slice(&at.to_le_bytes());
            page[8] = if chunk.is_some() { 1 } else { 2 };
            page[16..48].copy_from_slice(&chunk.unwrap_or([0; 32]));
            page[48..80].copy_from_slice(&left);
            page[80..112].copy_from_slice(&right);
            hash(page)
        }
        let root = if entries.is_empty() {
            hash(&[])
        } else {
            build(&mut pages, entries, 0, entries.len())
        };
        let bytes: Vec<u8> = pages.iter().flatten().copied().collect();
        (
            IndexRef {
                index: hex(&hash(&bytes)),
                root: hex(&root),
                count: entries.len() as u64,
            },
            bytes,
        )
    }

    /// One layer on disk: `tree/` files, and block records of `file` overriding whole blocks.
    fn layer(
        dir: &Path,
        tree: &[(&str, Vec<u8>)],
        blocks: &[(u64, Option<Vec<u8>>)],
        size: u64,
    ) -> Layer {
        std::fs::create_dir_all(dir.join("tree")).unwrap();
        for (name, bytes) in tree {
            std::fs::write(dir.join("tree").join(name), bytes).unwrap();
        }
        let mut files = Vec::new();
        let meta = if blocks.is_empty() {
            None
        } else {
            std::fs::create_dir_all(dir.join(".devbox-delta/chunks")).unwrap();
            let mut entries = Vec::new();
            for (at, bytes) in blocks {
                let digest = bytes.as_ref().map(|bytes| {
                    let digest = hash(bytes);
                    std::fs::write(
                        dir.join(format!(".devbox-delta/chunks/{}", hex(&digest))),
                        bytes,
                    )
                    .unwrap();
                    digest
                });
                entries.push((*at, digest));
            }
            let (over, bytes) = index(&entries);
            std::fs::write(dir.join(format!(".devbox-delta/{}", over.index)), bytes).unwrap();
            files.push(Record {
                p: "file".to_owned(),
                s: size,
                mode: 0o644,
                uid: 0,
                gid: 0,
                t: 0,
                over,
            });
            Some(Root::open(dir).unwrap())
        };
        Layer::new(Root::open(&dir.join("tree")).unwrap(), meta, files)
    }

    #[test]
    fn a_block_resolves_through_every_layer_down_to_the_first_whole_version() {
        let path = std::env::temp_dir().join(format!("devbox-layers-test-{}", std::process::id()));
        std::fs::create_dir_all(path.join("base")).unwrap();
        std::fs::write(path.join("base/file"), vec![65; 3 * 16384]).unwrap();
        // Layer 1 rewrites block 1; layer 2 rewrites block 0, punches block 2 and grows the file.
        let one = layer(
            &path.join("one"),
            &[],
            &[(16384, Some(vec![66; 16384]))],
            3 * 16384,
        );
        let two = layer(
            &path.join("two"),
            &[],
            &[
                (0, Some(vec![67; 16384])),
                (2 * 16384, None),
                (3 * 16384, Some(vec![68; 5])),
            ],
            3 * 16384 + 5,
        );
        let mut storage = Storage::new(
            Root::open(&path.join("base")).unwrap(),
            vec![one, two],
            path.join("stats"),
        );

        let read = storage
            .read("file", 1, 3 * 16384 + 5, 0, 4 * 16384)
            .unwrap();
        let mut wanted = vec![67; 16384];
        wanted.extend(vec![66; 16384]);
        wanted.extend(vec![0; 16384]);
        wanted.extend(vec![68; 5]);
        assert_eq!(read, wanted);
        assert_eq!(
            storage.read("file", 1, 3 * 16384 + 5, 16380, 8).unwrap(),
            vec![67, 67, 67, 67, 66, 66, 66, 66]
        );
        assert!(!storage.shadowed(1, "file").unwrap());
        assert!(storage.shadowed(0, "file").unwrap());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn a_version_shorter_than_the_one_below_reads_through_it_by_its_own_size() {
        let path = std::env::temp_dir().join(format!("devbox-shrunk-test-{}", std::process::id()));
        std::fs::create_dir_all(path.join("base")).unwrap();
        std::fs::write(path.join("base/file"), vec![65; 4 * 16384]).unwrap();
        // Layer 1 grows the file by a block; layer 2 cuts it to one and a half blocks, changing none.
        let one = layer(
            &path.join("one"),
            &[],
            &[(4 * 16384, Some(vec![66; 100]))],
            4 * 16384 + 100,
        );
        let two = layer(
            &path.join("two"),
            &[],
            &[(16384, Some(vec![67; 8192]))],
            16384 + 8192,
        );
        let mut storage = Storage::new(
            Root::open(&path.join("base")).unwrap(),
            vec![one, two],
            path.join("stats"),
        );

        let mut wanted = vec![65; 16384];
        wanted.extend(vec![67; 8192]);
        assert_eq!(
            storage.read("file", 1, 16384 + 8192, 0, 4 * 16384).unwrap(),
            wanted
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn a_whole_version_ends_the_chain_and_a_newer_one_shadows_the_record() {
        let path = std::env::temp_dir().join(format!("devbox-whole-test-{}", std::process::id()));
        std::fs::create_dir_all(path.join("base")).unwrap();
        std::fs::write(path.join("base/file"), vec![65; 16384]).unwrap();
        let one = layer(&path.join("one"), &[("file", vec![66; 2 * 16384])], &[], 0);
        let two = layer(
            &path.join("two"),
            &[],
            &[(16384, Some(vec![67; 16384]))],
            2 * 16384,
        );
        let three = layer(&path.join("three"), &[(".wh.file", Vec::new())], &[], 0);
        let mut storage = Storage::new(
            Root::open(&path.join("base")).unwrap(),
            vec![one, two, three],
            path.join("stats"),
        );

        let mut wanted = vec![66; 16384];
        wanted.extend(vec![67; 16384]);
        assert_eq!(
            storage.read("file", 1, 2 * 16384, 0, 2 * 16384).unwrap(),
            wanted
        );
        assert!(storage.shadowed(1, "file").unwrap());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn a_record_with_no_earlier_version_or_a_corrupt_chunk_is_an_error_not_zeros() {
        let path = std::env::temp_dir().join(format!("devbox-orphan-test-{}", std::process::id()));
        std::fs::create_dir_all(path.join("base")).unwrap();
        let gone = layer(&path.join("gone"), &[(".wh.file", Vec::new())], &[], 0);
        let one = layer(
            &path.join("one"),
            &[],
            &[(16384, Some(vec![66; 16384]))],
            2 * 16384,
        );
        let mut storage = Storage::new(
            Root::open(&path.join("base")).unwrap(),
            vec![gone, one],
            path.join("stats"),
        );
        assert!(storage.read("file", 1, 2 * 16384, 0, 16384).is_err());

        std::fs::write(path.join("base/file"), vec![65; 2 * 16384]).unwrap();
        let one = layer(
            &path.join("again"),
            &[],
            &[(0, Some(vec![66; 16384]))],
            2 * 16384,
        );
        let digest = hex(&hash(&vec![66; 16384]));
        std::fs::write(
            path.join(format!("again/.devbox-delta/chunks/{digest}")),
            vec![67; 16384],
        )
        .unwrap();
        let mut storage = Storage::new(
            Root::open(&path.join("base")).unwrap(),
            vec![one],
            path.join("stats"),
        );
        assert!(storage.read("file", 0, 2 * 16384, 0, 1).is_err());
        assert_eq!(
            storage.read("file", 0, 2 * 16384, 16384, 2).unwrap(),
            vec![65, 65]
        );
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn anchored_sources_refuse_symlinks_and_escape() {
        let path = std::env::temp_dir().join(format!("devbox-root-test-{}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", path.join("link")).unwrap();
        let root = Root::open(&path).unwrap();
        assert!(root.file("../etc/passwd").is_err());
        assert!(root.file("link").is_err());
        assert!(root.file("link/child").is_err());
        assert!(root.file("missing").unwrap().is_none());
        std::fs::remove_file(path.join("link")).unwrap();
        std::fs::remove_dir(path).unwrap();
    }
}
