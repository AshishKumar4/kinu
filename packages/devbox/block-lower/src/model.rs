use crate::index::{invalid, IndexRef};
use crate::namespace::{DirectoryEntries, NameSet, PathMap};
use serde::Deserialize;
use std::io;

/// A file this layer stores as the blocks that changed since the layer below.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub p: String,
    pub s: u64,
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
    /// Modification time in nanoseconds since the epoch.
    pub t: u64,
    pub over: IndexRef,
}

/// `.devbox-delta/manifest.json` of one layer. Whole files and deletions are in
/// the layer's `tree/`, which the overlay reads directly.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub v: u32,
    pub files: Vec<Record>,
}

pub fn path_valid(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 4096
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && part.len() <= 255)
}

pub fn ancestors(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(|(at, _)| &path[..at])
}

impl Manifest {
    pub fn validate(&self) -> io::Result<()> {
        if self.v != 3 {
            return Err(invalid("unsupported manifest version"));
        }
        let mut names = NameSet::new();
        for record in &self.files {
            if !path_valid(&record.p) || !names.insert(&record.p) {
                return Err(invalid("invalid or duplicate file path"));
            }
            if record.mode > 0o7777 {
                return Err(invalid("unsupported file mode"));
            }
            record.over.validate(record.s)?;
        }
        for path in names.iter() {
            if ancestors(path).any(|parent| names.contains(parent)) {
                return Err(invalid("file has children"));
            }
        }
        Ok(())
    }
}

/// Attributes of a directory the table synthesises above a served file.
#[derive(Clone, Copy)]
pub struct DirAttrs {
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
    pub t: u64,
}

#[derive(Clone)]
pub struct Inode {
    pub path: String,
    pub parent: u64,
    pub size: u64,
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
    pub t: u64,
    /// The layer whose record serves this file; `None` for a directory.
    pub layer: Option<usize>,
    pub children: DirectoryEntries,
}

/// Only served files and their ancestor directories enter this table: every
/// other path belongs to the layers' trees beneath it in the overlay.
pub fn inodes(
    served: &[(usize, &Record)],
    dir: impl Fn(&str) -> io::Result<Option<DirAttrs>>,
) -> io::Result<Vec<Inode>> {
    let attrs = |path: &str| -> io::Result<DirAttrs> {
        Ok(dir(path)?.unwrap_or(DirAttrs {
            mode: 0o755,
            uid: 0,
            gid: 0,
            t: 0,
        }))
    };
    let root = attrs("")?;
    let mut rows = vec![Inode {
        path: String::new(),
        parent: 1,
        size: 0,
        mode: root.mode,
        uid: root.uid,
        gid: root.gid,
        t: root.t,
        layer: None,
        children: DirectoryEntries::new(),
    }];
    let mut ids = PathMap::new();
    ids.insert("", 1);
    for (layer, record) in served {
        let p = record.p.as_str();
        for path in ancestors(p).chain(std::iter::once(p)) {
            if ids.contains_key(path) {
                continue;
            }
            let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
            let parent_id = *ids
                .get(parent)
                .ok_or_else(|| invalid("missing parent inode"))?;
            let id = u64::try_from(rows.len()).map_err(|_| invalid("inode count"))? + 1;
            let row = if path == p {
                Inode {
                    path: path.to_owned(),
                    parent: parent_id,
                    size: record.s,
                    mode: record.mode,
                    uid: record.uid,
                    gid: record.gid,
                    t: record.t,
                    layer: Some(*layer),
                    children: DirectoryEntries::new(),
                }
            } else {
                let found = attrs(path)?;
                Inode {
                    path: path.to_owned(),
                    parent: parent_id,
                    size: 0,
                    mode: found.mode,
                    uid: found.uid,
                    gid: found.gid,
                    t: found.t,
                    layer: None,
                    children: DirectoryEntries::new(),
                }
            };
            rows[usize::try_from(parent_id - 1).map_err(|_| invalid("inode id"))?]
                .children
                .insert(name.to_owned(), id);
            rows.push(row);
            ids.insert(path, id);
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hostile_names_and_versions_fail_before_io() {
        for path in ["", "/etc/passwd", "a/../b", "a//b", "./a", "a\0b"] {
            assert!(!path_valid(path));
        }
        let empty = r#"{"index":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","root":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","count":0}"#;
        let record = |p: &str| {
            format!(r#"{{"p":"{p}","s":1,"mode":420,"uid":0,"gid":0,"t":0,"over":{empty}}}"#)
        };
        let old: Manifest =
            serde_json::from_str(&format!(r#"{{"v":2,"files":[{}]}}"#, record("a"))).unwrap();
        assert!(old.validate().is_err());
        let twice: Manifest = serde_json::from_str(&format!(
            r#"{{"v":3,"files":[{},{}]}}"#,
            record("a"),
            record("a")
        ))
        .unwrap();
        assert!(twice.validate().is_err());
        let nested: Manifest = serde_json::from_str(&format!(
            r#"{{"v":3,"files":[{},{}]}}"#,
            record("a"),
            record("a/b")
        ))
        .unwrap();
        assert!(nested.validate().is_err());
        let sound: Manifest = serde_json::from_str(&format!(
            r#"{{"v":3,"files":[{},{}]}}"#,
            record("a/b"),
            record("a/c")
        ))
        .unwrap();
        assert!(sound.validate().is_ok());
    }
}
