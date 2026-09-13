mod index;
mod model;
mod storage;

use crate::index::invalid;
use crate::model::{Inode, Manifest};
use crate::storage::{Metrics, Root, Storage};
use fuser::{
    FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEmpty,
    ReplyEntry, ReplyOpen, ReplyXattr, Request,
};
use std::collections::BTreeMap;
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
        Some(FileAttr {
            ino,
            size: n.size,
            blocks: n.size.div_ceil(512),
            atime: SystemTime::UNIX_EPOCH,
            mtime: SystemTime::UNIX_EPOCH,
            ctime: SystemTime::UNIX_EPOCH,
            crtime: SystemTime::UNIX_EPOCH,
            kind: if n.index.is_some() {
                FileType::RegularFile
            } else {
                FileType::Directory
            },
            perm: n.mode,
            nlink: if n.index.is_some() { 1 } else { 2 },
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
            Some(n) if n.index.is_some() => reply.opened(ino, 0),
            Some(_) => reply.error(libc::EISDIR),
            None => reply.error(libc::ENOENT),
        }
    }

    fn opendir(&mut self, _: &Request<'_>, ino: u64, _: i32, reply: ReplyOpen) {
        match self.inode(ino) {
            Some(n) if n.index.is_none() => reply.opened(ino, 0),
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
        if n.index.is_some() {
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
        let Some(reference) = n.index.clone() else {
            reply.error(libc::EISDIR);
            return;
        };
        let Ok(offset) = u64::try_from(offset) else {
            reply.error(libc::EINVAL);
            return;
        };
        let (path, length) = (n.path.clone(), n.size);
        let result = self.storage.read(&path, length, &reference, offset, size);
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

fn require_mount(path: &Path, source: &str) -> io::Result<()> {
    let mounts = fs::read_to_string("/proc/self/mounts")?;
    let found = mounts.lines().any(|line| {
        let parts: Vec<_> = line.split_whitespace().collect();
        parts.len() >= 3
            && Path::new(&unescape_mount(parts[1])) == path
            && unescape_mount(parts[0]) == source
            && parts[2].contains("squashfuse")
    });
    if found {
        Ok(())
    } else {
        Err(invalid("source mount or generation mismatch"))
    }
}

fn options() -> io::Result<BTreeMap<String, String>> {
    let mut args = std::env::args().skip(1);
    let mut out = BTreeMap::new();
    while let Some(key) = args.next() {
        if ![
            "--base",
            "--delta",
            "--mount",
            "--generation",
            "--base-source",
            "--delta-source",
            "--stats",
        ]
        .contains(&key.as_str())
        {
            return Err(invalid("unknown argument"));
        }
        let value = args
            .next()
            .ok_or_else(|| invalid("missing argument value"))?;
        if out.insert(key, value).is_some() {
            return Err(invalid("duplicate argument"));
        }
    }
    Ok(out)
}

fn run() -> io::Result<()> {
    let args = options()?;
    let get = |key: &str| {
        args.get(key)
            .ok_or_else(|| invalid("missing required argument"))
    };
    let generation = get("--generation")?;
    if generation.is_empty()
        || !generation
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b':')
    {
        return Err(invalid("invalid generation"));
    }
    let base = PathBuf::from(get("--base")?);
    let delta = PathBuf::from(get("--delta")?);
    let mount = PathBuf::from(get("--mount")?);
    if delta.file_name().and_then(|name| name.to_str()) != generation.split(':').next() {
        return Err(invalid("delta mount generation mismatch"));
    }
    require_mount(&base, get("--base-source")?)?;
    require_mount(&delta, get("--delta-source")?)?;
    let delta_root = Root::open(&delta)?;
    let mut manifest_bytes = Vec::new();
    delta_root
        .required(".devbox-delta/manifest.json")?
        .read_to_end(&mut manifest_bytes)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    let nodes = model::inodes(&manifest)?;
    let storage = Storage {
        base: Root::open(&base)?,
        delta: delta_root,
        metrics: Metrics::default(),
        stats: PathBuf::from(get("--stats")?),
        generation: generation.clone(),
    };
    storage.save_metrics()?;
    let fs = BlockLower { nodes, storage };
    fuser::mount2(
        fs,
        mount,
        &[
            MountOption::RO,
            MountOption::AllowOther,
            MountOption::DefaultPermissions,
            MountOption::FSName(format!("devbox-block:{generation}")),
            MountOption::Subtype("devbox-block".to_owned()),
            MountOption::NoDev,
            MountOption::NoSuid,
        ],
    )
}

fn main() {
    if let Err(error) = run() {
        eprintln!("block-lower.start: {error}");
        std::process::exit(1);
    }
}
