use crate::index::{invalid, IndexRef};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::io;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Directory {
    pub p: String,
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Record {
    Whole {
        p: String,
        s: u64,
    },
    Chunked {
        p: String,
        s: u64,
        mode: u16,
        uid: u32,
        gid: u32,
        over: IndexRef,
    },
}

impl Record {
    pub fn path(&self) -> &str {
        match self {
            Self::Whole { p, .. } | Self::Chunked { p, .. } => p,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub v: u32,
    pub files: Vec<Record>,
    pub dirs: Vec<Directory>,
    pub deleted: Vec<String>,
    pub treplace: Vec<String>,
    pub links: Vec<Vec<String>>,
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
        if self.v != 2 {
            return Err(invalid("unsupported manifest version"));
        }
        let mut names = HashSet::new();
        let mut nondirs = HashSet::new();
        for record in &self.files {
            let path = record.path();
            if !path_valid(path) || !names.insert(path) {
                return Err(invalid("invalid or duplicate file path"));
            }
            nondirs.insert(path);
            match record {
                Record::Chunked { s, mode, over, .. } => {
                    if *mode > 0o7777 {
                        return Err(invalid("unsupported file mode"));
                    }
                    over.validate(*s)?;
                }
                Record::Whole { s, .. } => {
                    if *s > 9007199254740991 {
                        return Err(invalid("invalid whole size"));
                    }
                }
            }
        }
        for dir in &self.dirs {
            if !path_valid(&dir.p) || dir.mode > 0o7777 || !names.insert(&dir.p) {
                return Err(invalid("invalid or duplicate directory"));
            }
        }
        for path in &self.deleted {
            if !path_valid(path) || !names.insert(path) {
                return Err(invalid("invalid or duplicate deletion"));
            }
            nondirs.insert(path);
        }
        for path in &names {
            if ancestors(path).any(|parent| nondirs.contains(parent)) {
                return Err(invalid("file or deletion has children"));
            }
        }
        let whole: HashSet<_> = self
            .files
            .iter()
            .filter_map(|r| match r {
                Record::Whole { p, .. } => Some(p),
                _ => None,
            })
            .collect();
        let mut linked = HashSet::new();
        for group in &self.links {
            if group.len() < 2 {
                return Err(invalid("short hardlink group"));
            }
            for path in group {
                if !whole.contains(path) || !linked.insert(path) {
                    return Err(invalid("invalid hardlink group"));
                }
            }
        }
        let deleted: HashSet<_> = self.deleted.iter().map(String::as_str).collect();
        let mut replaced = HashSet::new();
        for path in &self.treplace {
            if !nondirs.contains(path.as_str())
                || deleted.contains(path.as_str())
                || !replaced.insert(path)
            {
                return Err(invalid("invalid replacement"));
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Inode {
    pub path: String,
    pub parent: u64,
    pub size: u64,
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
    pub index: Option<IndexRef>,
    pub children: BTreeMap<String, u64>,
}

/// Only chunked inodes and their ancestor directories enter this table.
/// Whole files and other namespace entries belong to the lazy tree lower.
pub fn inodes(manifest: &Manifest) -> io::Result<Vec<Inode>> {
    manifest.validate()?;
    let root = Inode {
        path: String::new(),
        parent: 1,
        size: 0,
        mode: 0o755,
        uid: 0,
        gid: 0,
        index: None,
        children: BTreeMap::new(),
    };
    let mut rows = vec![root];
    let mut ids = BTreeMap::from([(String::new(), 1)]);
    let attrs: BTreeMap<_, _> = manifest
        .dirs
        .iter()
        .map(|dir| (dir.p.as_str(), dir))
        .collect();
    for file in &manifest.files {
        let Record::Chunked {
            p,
            s,
            mode,
            uid,
            gid,
            over,
        } = file
        else {
            continue;
        };
        for path in ancestors(p).chain(std::iter::once(p.as_str())) {
            if ids.contains_key(path) {
                continue;
            }
            let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
            let parent_id = *ids
                .get(parent)
                .ok_or_else(|| invalid("missing parent inode"))?;
            let id = u64::try_from(rows.len()).map_err(|_| invalid("inode count"))? + 1;
            let dir = attrs.get(path);
            let row = if path == p {
                Inode {
                    path: path.to_owned(),
                    parent: parent_id,
                    size: *s,
                    mode: *mode,
                    uid: *uid,
                    gid: *gid,
                    index: Some(over.clone()),
                    children: BTreeMap::new(),
                }
            } else {
                Inode {
                    path: path.to_owned(),
                    parent: parent_id,
                    size: 0,
                    mode: dir.map_or(0o755, |d| d.mode),
                    uid: dir.map_or(0, |d| d.uid),
                    gid: dir.map_or(0, |d| d.gid),
                    index: None,
                    children: BTreeMap::new(),
                }
            };
            rows[usize::try_from(parent_id - 1).map_err(|_| invalid("inode id"))?]
                .children
                .insert(name.to_owned(), id);
            rows.push(row);
            ids.insert(path.to_owned(), id);
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
        let mut m: Manifest = serde_json::from_str(
            r#"{"v":1,"files":[],"dirs":[],"deleted":[],"treplace":[],"links":[]}"#,
        )
        .unwrap();
        assert!(inodes(&m).is_err());
        m.v = 2;
        m.deleted = vec!["a".to_owned(), "a".to_owned()];
        assert!(inodes(&m).is_err());
    }
}
