use crate::index::{chunk_name, hash, hex, invalid, lookup, IndexRef, Source, BLOCK};
use crate::model::{path_valid, DirAttrs, Record};
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

/// A delta's block records. Before m1966b a layer listed them all in
/// `.devbox-delta/manifest.json` (v4), which a recovery read whole at start.
/// Now each is found by its path's SHA-256 (v5): `records/<2>/<sha>` holds a
/// record, and `dirs/<2>/<sha>` the names under a directory that lead to one,
/// so a recovery reads only what it is asked for.
pub enum Records {
    None,
    Listed {
        files: PathMap<Record>,
        dirs: PathMap<Vec<String>>,
    },
    Indexed(Root),
}

impl Records {
    pub fn listed(records: Vec<Record>) -> Self {
        let mut dirs: PathMap<Vec<String>> = PathMap::new();
        let mut files = PathMap::new();
        for record in records {
            let mut parent = String::new();
            for part in record.p.split('/') {
                let mut names = dirs.get(&parent).cloned().unwrap_or_default();
                if !names.iter().any(|name| name == part) {
                    names.push(part.to_owned());
                    dirs.insert(&parent, names);
                }
                parent = if parent.is_empty() {
                    part.to_owned()
                } else {
                    format!("{parent}/{part}")
                };
            }
            let path = record.p.clone();
            files.insert(&path, record);
        }
        Self::Listed { files, dirs }
    }

    /// The record this layer holds for `path`, if any.
    pub fn record(&self, path: &str) -> io::Result<Option<Record>> {
        match self {
            Self::None => Ok(None),
            Self::Listed { files, .. } => Ok(files.get(path).cloned()),
            Self::Indexed(meta) => {
                let Some(bytes) = read_named(meta, "records", path)? else {
                    return Ok(None);
                };
                let record: Record = serde_json::from_slice(&bytes)?;
                if record.p != path || record.mode > 0o7777 {
                    return Err(invalid("a record is not its path's"));
                }
                record.over.validate(record.s)?;
                Ok(Some(record))
            }
        }
    }

    /// The names directly under `dir` that lead to a record of this layer,
    /// or `None` when none is under it.
    pub fn names(&self, dir: &str) -> io::Result<Option<Vec<String>>> {
        match self {
            Self::None => Ok(None),
            Self::Listed { dirs, .. } => Ok(dirs.get(dir).cloned()),
            Self::Indexed(meta) => {
                let Some(bytes) = read_named(meta, "dirs", dir)? else {
                    return Ok(None);
                };
                let names = bytes
                    .split(|byte| *byte == 0)
                    .filter(|name| !name.is_empty())
                    .map(|name| String::from_utf8(name.to_vec()).map_err(|_| invalid("a name is not UTF-8")))
                    .collect::<io::Result<Vec<_>>>()?;
                if names.iter().any(|name| !path_valid(name) || name.contains('/')) {
                    return Err(invalid("hostile name under a directory"));
                }
                Ok(Some(names))
            }
        }
    }
}

/// `.devbox-delta/<kind>/<first two hex digits>/<sha256 of path>`, read whole.
fn read_named(meta: &Root, kind: &str, path: &str) -> io::Result<Option<Vec<u8>>> {
    let name = hex(&hash(path.as_bytes()));
    let Some(mut file) = meta.file(&format!(".devbox-delta/{kind}/{}/{name}", &name[..2]))? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    io::Read::read_to_end(&mut file, &mut bytes)?;
    Ok(Some(bytes))
}

/// One delta layer: its overlay `tree/`, and the block records of
/// `.devbox-delta/` when it has any.
pub struct Layer {
    pub tree: Root,
    pub meta: Option<Root>,
    pub records: Records,
}

impl Layer {
    pub fn new(tree: Root, meta: Option<Root>, records: Records) -> Self {
        Self {
            tree,
            meta,
            records,
        }
    }
}

/// What the block lower serves at a path: a file whose newest version is a
/// layer's record, a directory that leads to one, or nothing (the overlay's
/// other lowers answer).
pub enum Resolved {
    Absent,
    File(usize, Record),
    Dir(DirAttrs),
}

/// Where a block of a served file comes from, newest version first.
enum Version {
    /// A layer's record, with that version's own size: its index and chunks were cut to it.
    Blocks(usize, IndexRef, u64),
    /// The file's last whole copy: in that layer's tree, or the base's when `None`. Opened for each read and closed
    /// after it: a descriptor kept for every file read ran out (EMFILE) once about 4,000 files with block records had
    /// been read, and every read after failed (the recovery acceptance at 4,096 changed files, 2026-10-23).
    Whole(Option<usize>),
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

    /// What `path` is here, newest layer first, reading only that path's
    /// records: a layer's record is the file unless a newer layer replaced or
    /// removed it, and a directory is served when some layer holds records
    /// under it that no newer layer hid. A layer's own records are not hidden
    /// by its own tree.
    pub fn resolve(&self, path: &str) -> io::Result<Resolved> {
        for (at, layer) in self.layers.iter().enumerate().rev() {
            if let Some(record) = layer.records.record(path)? {
                return Ok(Resolved::File(at, record));
            }
            if !matches!(layer.tree.probe(path)?, Presence::Absent) {
                break;
            }
        }
        for layer in self.layers.iter().rev() {
            if layer.records.names(path)?.is_some() {
                return Ok(Resolved::Dir(self.directory(path)?.unwrap_or(DirAttrs {
                    mode: 0o755,
                    uid: 0,
                    gid: 0,
                    t: 0,
                })));
            }
            match layer.tree.probe(path)? {
                Presence::Absent => {}
                Presence::Hidden => return Ok(Resolved::Absent),
                Presence::Present(found) if found.st_mode & libc::S_IFMT != libc::S_IFDIR => {
                    return Ok(Resolved::Absent)
                }
                Presence::Present(_) => {}
            }
        }
        Ok(Resolved::Absent)
    }

    /// Every name any layer's records lead to under `dir`, once each, sorted:
    /// which of them are served is each one's `resolve`.
    pub fn names(&self, dir: &str) -> io::Result<Vec<String>> {
        let mut names = Vec::new();
        for layer in &self.layers {
            names.extend(layer.records.names(dir)?.unwrap_or_default());
        }
        names.sort();
        names.dedup();
        Ok(names)
    }

    /// A directory's attributes as the overlay shows them: from the newest lower holding it.
    fn directory(&self, path: &str) -> io::Result<Option<DirAttrs>> {
        let roots = self
            .layers
            .iter()
            .rev()
            .map(|layer| &layer.tree)
            .chain(std::iter::once(&self.base));
        for root in roots {
            let found = if path.is_empty() {
                root.stat_root()?
            } else {
                match root.probe(path)? {
                    Presence::Present(stat) => stat,
                    Presence::Hidden => return Ok(None),
                    Presence::Absent => continue,
                }
            };
            if found.st_mode & libc::S_IFMT != libc::S_IFDIR {
                return Ok(None);
            }
            let t = u64::try_from(found.st_mtime).unwrap_or(0) * 1_000_000_000
                + u64::try_from(found.st_mtime_nsec).unwrap_or(0);
            return Ok(Some(DirAttrs {
                mode: (found.st_mode & 0o7777) as u16,
                uid: found.st_uid,
                gid: found.st_gid,
                t,
            }));
        }
        Ok(None)
    }

    /// The root's attributes, as `directory` reads them.
    pub fn root_attrs(&self) -> io::Result<DirAttrs> {
        Ok(self.directory("")?.unwrap_or(DirAttrs {
            mode: 0o755,
            uid: 0,
            gid: 0,
            t: 0,
        }))
    }

    /// The versions a block of `path` resolves through, from `layer` down to
    /// the base: each record falls through to the one below for the blocks it
    /// does not hold, and the first whole file ends the chain.
    fn chain(&self, layer: usize, path: &str) -> io::Result<Vec<Version>> {
        let mut out = Vec::new();
        for at in (0..=layer).rev() {
            let current = &self.layers[at];
            if let Some(record) = current.records.record(path)? {
                out.push(Version::Blocks(at, record.over, record.s));
                continue;
            }
            match current.tree.probe(path)? {
                Presence::Absent => continue,
                Presence::Hidden => return Err(invalid("a block record has no earlier version")),
                Presence::Present(_) => {
                    current.tree.required(path)?;
                    out.push(Version::Whole(Some(at)));
                    return Ok(out);
                }
            }
        }
        self.base
            .file(path)?
            .ok_or_else(|| invalid("a block record has no earlier version"))?;
        out.push(Version::Whole(None));
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
        // The whole version, opened by the first block that reaches it and closed with this read.
        let mut whole = None;
        while cursor < offset + count {
            let block = cursor / BLOCK * BLOCK;
            let end = (block + BLOCK).min(offset + count);
            let start = usize::try_from(cursor - offset).map_err(|_| invalid("read offset"))?;
            let stop = usize::try_from(end - offset).map_err(|_| invalid("read offset"))?;
            self.block(path, (block, cursor), &mut result[start..stop], &mut whole)?;
            cursor = end;
        }
        Ok(result)
    }

    /// Fills `out` with `path`'s bytes from `cursor`, all within `block`; a version shorter than
    /// the served file reads as zeros past its end. `whole`: the whole version, once opened.
    fn block(
        &mut self,
        path: &str,
        (block, cursor): (u64, u64),
        out: &mut [u8],
        whole: &mut Option<File>,
    ) -> io::Result<()> {
        let Self {
            versions,
            layers,
            metrics,
            base,
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
                            let chunk = meta.required(&chunk_name(&digest))?;
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
                Version::Whole(at) => {
                    let file = match whole {
                        Some(file) => file,
                        None => whole.insert(match at {
                            Some(at) => layers[*at].tree.required(path)?,
                            None => base.required(path)?,
                        }),
                    };
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
            let mut entries = Vec::new();
            for (at, bytes) in blocks {
                let digest = bytes.as_ref().map(|bytes| {
                    let digest = hash(bytes);
                    let chunk = dir.join(chunk_name(&digest));
                    std::fs::create_dir_all(chunk.parent().unwrap()).unwrap();
                    std::fs::write(chunk, bytes).unwrap();
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
        Layer::new(Root::open(&dir.join("tree")).unwrap(), meta, Records::listed(files))
    }

    /// `layer`, its records found by path as a v5 delta writes them (disk-delta.ts).
    fn indexed(dir: &Path, layer: Layer) -> Layer {
        let name = |path: &str| {
            let name = hex(&hash(path.as_bytes()));
            format!("{}/{name}", &name[..2])
        };
        let Records::Listed { files, dirs } = &layer.records else {
            panic!("a listed layer");
        };
        let mut paths = vec![String::new()];
        while let Some(parent) = paths.pop() {
            let Some(names) = dirs.get(&parent) else {
                continue;
            };
            let at = dir.join(".devbox-delta/dirs").join(name(&parent));
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, names.iter().map(|n| format!("{n}\0")).collect::<String>()).unwrap();
            for child in names {
                let path = if parent.is_empty() { child.clone() } else { format!("{parent}/{child}") };
                if let Some(record) = files.get(&path) {
                    let at = dir.join(".devbox-delta/records").join(name(&path));
                    std::fs::create_dir_all(at.parent().unwrap()).unwrap();
                    let over = &record.over;
                    std::fs::write(at, format!(
                        r#"{{"p":"{path}","s":{},"mode":{},"uid":0,"gid":0,"t":0,"over":{{"index":"{}","root":"{}","count":{}}}}}"#,
                        record.s, record.mode, over.index, over.root, over.count
                    )).unwrap();
                }
                paths.push(path);
            }
        }
        Layer::new(layer.tree, layer.meta, Records::Indexed(Root::open(dir).unwrap()))
    }

    fn served(storage: &Storage, path: &str) -> String {
        match storage.resolve(path).unwrap() {
            Resolved::Absent => "absent".to_owned(),
            Resolved::File(at, record) => format!("file of layer {at}, {} bytes", record.s),
            Resolved::Dir(attrs) => format!("directory {:o}", attrs.mode),
        }
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
        assert_eq!(served(&storage, "file"), "file of layer 1, 49157 bytes");
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
        assert_eq!(served(&storage, "file"), "absent");
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
        std::fs::write(
            path.join("again").join(chunk_name(&hash(&vec![66; 16384]))),
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

    /// The descriptors this process holds.
    fn descriptors() -> usize {
        std::fs::read_dir("/proc/self/fd").unwrap().count()
    }

    // The recovery acceptance at 4,096 changed files (2026-10-23): every file read through a block record kept its
    // whole version open, and past about 4,000 the process had no descriptor left (EMFILE) and every read failed.
    #[test]
    fn a_file_read_through_its_blocks_holds_no_descriptor_after_the_read() {
        let path = std::env::temp_dir().join(format!("devbox-descriptors-test-{}", std::process::id()));
        let files = 300;
        std::fs::create_dir_all(path.join("base")).unwrap();
        std::fs::create_dir_all(path.join("one/tree")).unwrap();
        let mut records = Vec::new();
        let block = vec![66; 16384];
        let digest = hash(&block);
        let chunk = path.join("one").join(chunk_name(&digest));
        std::fs::create_dir_all(chunk.parent().unwrap()).unwrap();
        std::fs::write(chunk, &block).unwrap();
        let (over, bytes) = index(&[(0, Some(digest))]);
        std::fs::write(path.join(format!("one/.devbox-delta/{}", over.index)), bytes).unwrap();
        for n in 0..files {
            std::fs::write(path.join(format!("base/f{n}")), vec![65; 2 * 16384]).unwrap();
            records.push(Record { p: format!("f{n}"), s: 2 * 16384, mode: 0o644, uid: 0, gid: 0, t: 0, over: over.clone() });
        }
        let one = Layer::new(Root::open(&path.join("one/tree")).unwrap(), Some(Root::open(&path.join("one")).unwrap()), Records::listed(records));
        let mut storage = Storage::new(Root::open(&path.join("base")).unwrap(), vec![one], path.join("stats"));
        let before = descriptors();
        let mut wanted = vec![66; 16384];
        wanted.extend(vec![65; 16384]);
        for n in 0..files {
            assert_eq!(storage.read(&format!("f{n}"), 0, 2 * 16384, 0, 2 * 16384).unwrap(), wanted);
        }
        // Other tests run beside this one and hold a few of their own: a kept descriptor per file is 300.
        assert!(descriptors() < before + 50, "{} descriptors held after reading {files} files", descriptors() - before);
        std::fs::remove_dir_all(path).unwrap();
    }

    /// A layer whose record sits at `record` (16 KiB, block 0 rewritten), with `tree` beside it.
    fn holding(dir: &Path, record: &str, tree: &[(&str, Option<&[u8]>)]) -> Layer {
        for (path, bytes) in tree {
            let at = dir.join("tree").join(path);
            match bytes {
                Some(bytes) => {
                    std::fs::create_dir_all(at.parent().unwrap()).unwrap();
                    std::fs::write(at, bytes).unwrap();
                }
                None => std::fs::create_dir_all(at).unwrap(),
            }
        }
        let mut made = layer(dir, &[], &[(0, Some(vec![66; 16384]))], 16384);
        let Records::Listed { files, .. } = &mut made.records else {
            panic!("a listed layer");
        };
        let mut moved = files.get("file").cloned().unwrap();
        moved.p = record.to_owned();
        made.records = Records::listed(vec![moved]);
        made
    }

    // m1966b: a v5 layer's records are found by path, read only when asked for, and answer as a v4 manifest's did.
    #[test]
    fn a_path_resolves_through_indexed_records_as_through_a_manifest() {
        let path = std::env::temp_dir().join(format!("devbox-indexed-test-{}", std::process::id()));
        std::fs::create_dir_all(path.join("base/src/deep")).unwrap();
        // The directories' own mode, whatever the umask the test runs under (0o002 on gcp-vm read 775).
        for dir in ["base/src", "base/src/deep"] {
            std::fs::set_permissions(path.join(dir), std::os::unix::fs::PermissionsExt::from_mode(0o750)).unwrap();
        }
        std::fs::write(path.join("base/src/deep/db.bin"), vec![65; 16384]).unwrap();
        std::fs::write(path.join("base/src/old.bin"), vec![65; 16384]).unwrap();
        std::fs::write(path.join("base/moved"), vec![65; 16384]).unwrap();
        for v5 in [false, true] {
            let at = path.join(if v5 { "v5" } else { "v4" });
            let made = |name: &str, record: &str, tree: &[(&str, Option<&[u8]>)]| {
                let layer = holding(&at.join(name), record, tree);
                if v5 { indexed(&at.join(name), layer) } else { layer }
            };
            // 0: db.bin's blocks; 1: old.bin's, and moved became a directory; 2: old.bin whited out, db.bin's blocks again.
            let layers = vec![
                made("zero", "src/deep/db.bin", &[]),
                made("one", "src/old.bin", &[("moved", None), ("moved/x", Some(b"x"))]),
                made("two", "src/deep/db.bin", &[("src/.wh.old.bin", Some(b""))]),
            ];
            // The trees' directories as the base's: the newest lower holding one names its mode, whatever the umask.
            for name in ["zero", "one", "two"] {
                for dir in ["tree/src", "tree/src/deep", "tree/moved"] {
                    if at.join(name).join(dir).is_dir() {
                        std::fs::set_permissions(at.join(name).join(dir), std::os::unix::fs::PermissionsExt::from_mode(0o750)).unwrap();
                    }
                }
            }
            let storage = Storage::new(Root::open(&path.join("base")).unwrap(), layers, path.join("stats"));
            let seen: Vec<String> = ["src/deep/db.bin", "src/old.bin", "src", "src/deep", "moved", "missing", "src/deep/db.bin/x"]
                .iter()
                .map(|p| format!("{p}: {}", served(&storage, p)))
                .collect();
            assert_eq!(
                seen,
                [
                    "src/deep/db.bin: file of layer 2, 16384 bytes",
                    "src/old.bin: absent",
                    "src: directory 750",
                    "src/deep: directory 750",
                    "moved: absent",
                    "missing: absent",
                    "src/deep/db.bin/x: absent",
                ],
                "v5 {v5}"
            );
            assert_eq!(storage.names("").unwrap(), ["src"]);
            assert_eq!(storage.names("src").unwrap(), ["deep", "old.bin"]);
            assert_eq!(storage.names("src/deep").unwrap(), ["db.bin"]);
        }
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn a_record_found_under_another_path_is_refused() {
        let path = std::env::temp_dir().join(format!("devbox-misfiled-test-{}", std::process::id()));
        std::fs::create_dir_all(path.join("base")).unwrap();
        let layer = indexed(&path.join("one"), holding(&path.join("one"), "a", &[]));
        let name = |p: &str| {
            let name = hex(&hash(p.as_bytes()));
            path.join("one/.devbox-delta/records").join(format!("{}/{name}", &name[..2]))
        };
        std::fs::create_dir_all(name("b").parent().unwrap()).unwrap();
        std::fs::copy(name("a"), name("b")).unwrap();
        let storage = Storage::new(Root::open(&path.join("base")).unwrap(), vec![layer], path.join("stats"));
        assert!(storage.resolve("b").is_err());
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
