use crate::index::{hash, hex, invalid, lookup, IndexRef, Source, BLOCK};
use crate::model::path_valid;
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
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub payload_bytes: u64,
    pub index_pages: u64,
    pub read_requests: u64,
}

pub struct Storage {
    pub base: Root,
    pub delta: Root,
    pub metrics: Metrics,
    pub stats: PathBuf,
    pub generation: String,
}

impl Storage {
    pub fn save_metrics(&self) -> io::Result<()> {
        #[derive(Serialize)]
        struct Report<'a> {
            generation: &'a str,
            #[serde(flatten)]
            metrics: &'a Metrics,
        }
        let bytes = serde_json::to_vec(&Report {
            generation: &self.generation,
            metrics: &self.metrics,
        })?;
        std::fs::write(&self.stats, bytes)
    }

    pub fn read(
        &mut self,
        path: &str,
        size: u64,
        reference: &IndexRef,
        offset: u64,
        length: u32,
    ) -> io::Result<Vec<u8>> {
        self.metrics.read_requests += 1;
        let count = u64::from(length).min(size.saturating_sub(offset));
        let mut result = vec![0; usize::try_from(count).map_err(|_| invalid("read length"))?];
        if count == 0 {
            return Ok(result);
        }
        let index = self
            .delta
            .required(&format!(".devbox-delta/{}", reference.index))?;
        if index.metadata()?.len() != reference.count * 128 {
            return Err(invalid("index length mismatch"));
        }
        let mut cursor = offset;
        while cursor < offset + count {
            let block = cursor / BLOCK * BLOCK;
            let source = lookup(reference, size, block, |at, out| {
                self.metrics.index_pages += 1;
                index.read_exact_at(out, at)
            })?;
            let end = (block + BLOCK).min(offset + count);
            let start = usize::try_from(cursor - offset).map_err(|_| invalid("read offset"))?;
            let stop = usize::try_from(end - offset).map_err(|_| invalid("read offset"))?;
            match source {
                Source::Hole => {}
                Source::Base => {
                    if let Some(base) = self.base.file(path)? {
                        let available = base
                            .metadata()?
                            .len()
                            .saturating_sub(cursor)
                            .min(end - cursor);
                        let n = usize::try_from(available).map_err(|_| invalid("base range"))?;
                        base.read_exact_at(&mut result[start..start + n], cursor)?;
                        self.metrics.payload_bytes += available;
                    }
                }
                Source::Chunk(digest) => {
                    let chunk = self
                        .delta
                        .required(&format!(".devbox-delta/chunks/{}", hex(&digest)))?;
                    let needed = (size - block).min(BLOCK);
                    if chunk.metadata()?.len() != needed {
                        return Err(invalid("chunk length mismatch"));
                    }
                    let mut bytes =
                        vec![0; usize::try_from(needed).map_err(|_| invalid("chunk size"))?];
                    chunk.read_exact_at(&mut bytes, 0)?;
                    self.metrics.payload_bytes += needed;
                    if hash(&bytes) != digest {
                        return Err(invalid("corrupt chunk"));
                    }
                    let from =
                        usize::try_from(cursor - block).map_err(|_| invalid("chunk range"))?;
                    result[start..stop].copy_from_slice(&bytes[from..from + stop - start]);
                }
            }
            cursor = end;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipped_reads_distinguish_holes_missing_base_and_corrupt_chunks() {
        let path = std::env::temp_dir().join(format!("devbox-read-test-{}", std::process::id()));
        std::fs::create_dir_all(path.join("base")).unwrap();
        std::fs::create_dir_all(path.join("delta/.devbox-delta/chunks")).unwrap();
        std::fs::write(path.join("base/file"), vec![65; 32768]).unwrap();
        let payload = vec![66; 16384];
        let chunk = hash(&payload);
        std::fs::write(
            path.join(format!("delta/.devbox-delta/chunks/{}", hex(&chunk))),
            &payload,
        )
        .unwrap();
        let mut left = [0; 128];
        left[8] = 1;
        left[16..48].copy_from_slice(&chunk);
        let mut root = [0; 128];
        root[..8].copy_from_slice(&BLOCK.to_le_bytes());
        root[8] = 2;
        root[48..80].copy_from_slice(&hash(&left));
        let bytes = [left, root].concat();
        let reference = IndexRef {
            index: hex(&hash(&bytes)),
            root: hex(&hash(&root)),
            count: 2,
        };
        std::fs::write(
            path.join(format!("delta/.devbox-delta/{}", reference.index)),
            &bytes,
        )
        .unwrap();
        let mut storage = Storage {
            base: Root::open(&path.join("base")).unwrap(),
            delta: Root::open(&path.join("delta")).unwrap(),
            stats: path.join("stats"),
            generation: "test".to_owned(),
            metrics: Metrics::default(),
        };
        assert_eq!(storage.metrics.payload_bytes, 0);
        assert_eq!(
            storage.read("file", 32771, &reference, 16380, 8).unwrap(),
            vec![66, 66, 66, 66, 0, 0, 0, 0]
        );
        assert_eq!(
            storage.read("file", 32771, &reference, 32768, 99).unwrap(),
            vec![0; 3]
        );
        assert!(storage
            .read("file", 32771, &reference, 32771, 1)
            .unwrap()
            .is_empty());
        std::fs::write(
            path.join(format!("delta/.devbox-delta/chunks/{}", hex(&chunk))),
            vec![67; 16384],
        )
        .unwrap();
        assert!(storage.read("file", 32771, &reference, 0, 1).is_err());
        std::fs::remove_file(path.join(format!("delta/.devbox-delta/chunks/{}", hex(&chunk))))
            .unwrap();
        std::fs::remove_file(path.join(format!("delta/.devbox-delta/{}", reference.index)))
            .unwrap();
        std::fs::remove_file(path.join("base/file")).unwrap();
        std::fs::remove_dir(path.join("delta/.devbox-delta/chunks")).unwrap();
        std::fs::remove_dir(path.join("delta/.devbox-delta")).unwrap();
        std::fs::remove_dir(path.join("delta")).unwrap();
        std::fs::remove_dir(path.join("base")).unwrap();
        std::fs::remove_dir(path).unwrap();
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
