use crate::index::{invalid, IndexRef};
use crate::namespace::{DirectoryEntries, NameSet};
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
        if self.v != 4 {
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
    /// A directory's served entries, once a listing resolved them.
    pub children: Option<DirectoryEntries>,
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
            r#"{{"v":4,"files":[{},{}]}}"#,
            record("a"),
            record("a")
        ))
        .unwrap();
        assert!(twice.validate().is_err());
        let nested: Manifest = serde_json::from_str(&format!(
            r#"{{"v":4,"files":[{},{}]}}"#,
            record("a"),
            record("a/b")
        ))
        .unwrap();
        assert!(nested.validate().is_err());
        let sound: Manifest = serde_json::from_str(&format!(
            r#"{{"v":4,"files":[{},{}]}}"#,
            record("a/b"),
            record("a/c")
        ))
        .unwrap();
        assert!(sound.validate().is_ok());
    }
}
