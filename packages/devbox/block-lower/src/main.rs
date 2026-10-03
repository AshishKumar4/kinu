mod index;
mod model;
mod namespace;
mod storage;

use crate::index::invalid;
use crate::model::{DirAttrs, Inode, Manifest};
use crate::storage::{Layer, Presence, Root, Storage};
use fuser::{
    FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEmpty,
    ReplyEntry, ReplyOpen, ReplyXattr, Request,
};
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const TTL: Duration = Duration::from_secs(60);

struct BlockLower {
    nodes: Vec<Inode>,
    storage: Storage,
}

impl BlockLower {
    fn inode(&self, ino: u64) -> Option<&Inode> {
        usize::try_from(ino.checked_sub(1)?)
            .ok()
            .and_then(|i| self.nodes.get(i))
    }

    fn attr(&self, ino: u64) -> Option<FileAttr> {
        let n = self.inode(ino)?;
        let at = SystemTime::UNIX_EPOCH + Duration::from_nanos(n.t);
        Some(FileAttr {
            ino,
            size: n.size,
            blocks: n.size.div_ceil(512),
            atime: at,
            mtime: at,
            ctime: at,
            crtime: at,
            kind: if n.layer.is_some() {
                FileType::RegularFile
            } else {
                FileType::Directory
            },
            perm: n.mode,
            nlink: if n.layer.is_some() { 1 } else { 2 },
            uid: n.uid,
            gid: n.gid,
            rdev: 0,
            blksize: 16384,
            flags: 0,
        })
    }
}

impl Filesystem for BlockLower {
    fn lookup(&mut self, _: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let id = self
            .inode(parent)
            .and_then(|n| name.to_str().and_then(|s| n.children.get(s)));
        match id.and_then(|id| self.attr(*id)) {
            Some(attr) => reply.entry(&TTL, &attr, 0),
            None => reply.error(libc::ENOENT),
        }
    }

    fn getattr(&mut self, _: &Request<'_>, ino: u64, _: Option<u64>, reply: ReplyAttr) {
        match self.attr(ino) {
            Some(attr) => reply.attr(&TTL, &attr),
            None => reply.error(libc::ENOENT),
        }
    }

    fn open(&mut self, _: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        if flags & libc::O_ACCMODE != libc::O_RDONLY {
            reply.error(libc::EROFS);
            return;
        }
        match self.inode(ino) {
            Some(n) if n.layer.is_some() => reply.opened(ino, 0),
            Some(_) => reply.error(libc::EISDIR),
            None => reply.error(libc::ENOENT),
        }
    }

    fn opendir(&mut self, _: &Request<'_>, ino: u64, _: i32, reply: ReplyOpen) {
        match self.inode(ino) {
            Some(n) if n.layer.is_none() => reply.opened(ino, 0),
            Some(_) => reply.error(libc::ENOTDIR),
            None => reply.error(libc::ENOENT),
        }
    }

    fn readdir(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        _: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let Some(n) = self.inode(ino) else {
            reply.error(libc::ENOENT);
            return;
        };
        if n.layer.is_some() {
            reply.error(libc::ENOTDIR);
            return;
        }
        let Ok(skip) = usize::try_from(offset) else {
            reply.error(libc::EINVAL);
            return;
        };
        let entries = [(".", ino), ("..", n.parent)]
            .into_iter()
            .chain(n.children.iter().map(|(name, id)| (name.as_str(), *id)));
        for (i, (name, id)) in entries.enumerate().skip(skip) {
            let Some(attr) = self.attr(id) else {
                reply.error(libc::EIO);
                return;
            };
            let Ok(next) = i64::try_from(i + 1) else {
                reply.error(libc::EOVERFLOW);
                return;
            };
            if reply.add(id, next, attr.kind, name) {
                break;
            }
        }
        reply.ok();
    }

    fn read(
        &mut self,
        _: &Request<'_>,
        ino: u64,
        fh: u64,
        offset: i64,
        size: u32,
        _: i32,
        _: Option<u64>,
        reply: ReplyData,
    ) {
        if fh != ino {
            reply.error(libc::EIO);
            return;
        }
        let Some(n) = self.inode(ino) else {
            reply.error(libc::ENOENT);
            return;
        };
        let Some(layer) = n.layer else {
            reply.error(libc::EISDIR);
            return;
        };
        let Ok(offset) = u64::try_from(offset) else {
            reply.error(libc::EINVAL);
            return;
        };
        let (path, length) = (n.path.clone(), n.size);
        let result = self.storage.read(&path, layer, length, offset, size);
        if let Err(error) = self.storage.save_metrics() {
            eprintln!("block-lower.metrics: {error}");
            reply.error(libc::EIO);
            return;
        }
        match result {
            Ok(bytes) => reply.data(&bytes),
            Err(error) => {
                eprintln!("block-lower.read: {path}: {error}");
                reply.error(libc::EIO);
            }
        }
    }

    fn access(&mut self, _: &Request<'_>, ino: u64, mask: i32, reply: ReplyEmpty) {
        if self.inode(ino).is_none() {
            reply.error(libc::ENOENT);
        } else if mask & libc::W_OK != 0 {
            reply.error(libc::EROFS);
        } else {
            reply.ok();
        }
    }

    fn listxattr(&mut self, _: &Request<'_>, ino: u64, size: u32, reply: ReplyXattr) {
        if self.inode(ino).is_none() {
            reply.error(libc::ENOENT);
        } else if size == 0 {
            reply.size(0);
        } else {
            reply.data(&[]);
        }
    }

    fn getxattr(&mut self, _: &Request<'_>, ino: u64, _: &OsStr, _: u32, reply: ReplyXattr) {
        reply.error(if self.inode(ino).is_none() {
            libc::ENOENT
        } else {
            libc::ENODATA
        });
    }
}

fn unescape_mount(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

fn require_mount(path: &Path) -> io::Result<()> {
    let mounts = fs::read_to_string("/proc/self/mounts")?;
    let found = mounts.lines().any(|line| {
        let parts: Vec<_> = line.split_whitespace().collect();
        parts.len() >= 3
            && Path::new(&unescape_mount(parts[1])) == path
            && parts[2].contains("squashfuse")
    });
    if found {
        Ok(())
    } else {
        Err(invalid("a layer is not a squashfs mount"))
    }
}

/// `--base <dir> --layer <dir>... --mount <dir> --stats <file>`, layers oldest first.
fn options() -> io::Result<(PathBuf, Vec<PathBuf>, PathBuf, PathBuf)> {
    let mut args = std::env::args().skip(1);
    let (mut base, mut layers, mut mount, mut stats) = (None, Vec::new(), None, None);
    while let Some(key) = args.next() {
        let value = PathBuf::from(
            args.next()
                .ok_or_else(|| invalid("missing argument value"))?,
        );
        let slot = match key.as_str() {
            "--base" => &mut base,
            "--mount" => &mut mount,
            "--stats" => &mut stats,
            "--layer" => {
                layers.push(value);
                continue;
            }
            _ => return Err(invalid("unknown argument")),
        };
        if slot.replace(value).is_some() {
            return Err(invalid("duplicate argument"));
        }
    }
    let missing = || invalid("missing required argument");
    Ok((
        base.ok_or_else(missing)?,
        layers,
        mount.ok_or_else(missing)?,
        stats.ok_or_else(missing)?,
    ))
}

fn open_layer(path: &Path) -> io::Result<Layer> {
    require_mount(path)?;
    let root = Root::open(path)?;
    let Some(mut file) = root.file(".devbox-delta/manifest.json")? else {
        return Ok(Layer::new(
            Root::open(&path.join("tree"))?,
            None,
            Vec::new(),
        ));
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    manifest.validate()?;
    Ok(Layer::new(
        Root::open(&path.join("tree"))?,
        Some(root),
        manifest.files,
    ))
}

fn run() -> io::Result<()> {
    let (base, layers, mount, stats) = options()?;
    require_mount(&base)?;
    let layers = layers
        .iter()
        .map(|path| open_layer(path))
        .collect::<io::Result<Vec<_>>>()?;
    let storage = Storage::new(Root::open(&base)?, layers, stats);
    // A record is the file only when no newer layer replaced or removed it.
    let mut served = Vec::new();
    for (at, layer) in storage.layers.iter().enumerate() {
        for record in &layer.files {
            if !storage.shadowed(at, &record.p)? {
                served.push((at, record));
            }
        }
    }
    let nodes = model::inodes(&served, |path| directory(&storage, path))?;
    storage.save_metrics()?;
    let fs = BlockLower { nodes, storage };
    fuser::mount2(
        fs,
        mount,
        &[
            MountOption::RO,
            MountOption::AllowOther,
            MountOption::DefaultPermissions,
            MountOption::FSName("devbox-block".to_owned()),
            MountOption::Subtype("devbox-block".to_owned()),
            MountOption::NoDev,
            MountOption::NoSuid,
        ],
    )
}

/// A directory's attributes as the overlay shows them: from the newest lower holding it.
fn directory(storage: &Storage, path: &str) -> io::Result<Option<DirAttrs>> {
    let roots = storage
        .layers
        .iter()
        .rev()
        .map(|layer| &layer.tree)
        .chain(std::iter::once(&storage.base));
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

fn main() {
    if let Err(error) = run() {
        eprintln!("block-lower.start: {error}");
        std::process::exit(1);
    }
}
