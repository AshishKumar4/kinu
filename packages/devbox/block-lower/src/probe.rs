//! Enrich the upper's find records without walking excluded subtrees. `o`
//! is a directory whose overlay opacity was observed, not inferred from size.
use crate::index::invalid;
use crate::model::path_valid;
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn opaque(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path.join(".wh..wh..opq")) {
        Ok(marker) if marker.is_file() && marker.len() == 0 => return Ok(true),
        Ok(_) => return Err(invalid("invalid opaque marker")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error),
    }
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| invalid("nul in path"))?;
    for name in [
        c"trusted.overlay.opaque",
        c"user.overlay.opaque",
        c"user.fuseoverlayfs.opaque",
    ] {
        let mut bytes = [0_u8; 8];
        // SAFETY: both strings are terminated; bytes owns the supplied buffer.
        let size = unsafe {
            libc::lgetxattr(
                path.as_ptr(),
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if size < 0 {
            let error = io::Error::last_os_error();
            if matches!(
                error.raw_os_error(),
                Some(libc::ENODATA) | Some(libc::ENOTSUP)
            ) {
                continue;
            }
            return Err(error);
        }
        match &bytes[..usize::try_from(size).map_err(|_| invalid("xattr size"))?] {
            b"y" => return Ok(true),
            b"n" | b"x" | b"" => (),
            _ => return Err(invalid("unsupported opaque xattr value")),
        }
    }
    Ok(false)
}

pub fn enrich(root: &Path, input: &[u8]) -> io::Result<Vec<u8>> {
    let fields: Vec<_> = input
        .strip_suffix(&[0])
        .unwrap_or(input)
        .split(|byte| *byte == 0)
        .collect();
    if !input.is_empty() && (fields.len() % 11 != 0 || !input.ends_with(&[0])) {
        return Err(invalid("malformed find records"));
    }
    let mut output = Vec::with_capacity(input.len());
    let attr = fs::symlink_metadata(root)?;
    if !attr.is_dir() {
        return Err(invalid("upper root is not a directory"));
    }
    if opaque(root)? {
        let record = format!(
            "o\0{}\0{}\0{:o}\0{}\0{}\0{}\00\00\0\0\0",
            attr.ino(),
            attr.nlink(),
            attr.mode() & 0o7777,
            attr.uid(),
            attr.gid(),
            attr.len()
        );
        output.extend_from_slice(record.as_bytes());
    }
    if input.is_empty() {
        return Ok(output);
    }
    for record in fields.chunks_exact(11) {
        let name = std::str::from_utf8(record[10]).map_err(|_| invalid("non-UTF8 path"))?;
        if !path_valid(name) {
            return Err(invalid("hostile find path"));
        }
        let is_opaque = if record[0] == b"d" {
            let path = root.join(name);
            if !fs::symlink_metadata(&path)?.is_dir() {
                return Err(invalid("directory changed during probe"));
            }
            opaque(&path)?
        } else {
            false
        };
        for (index, field) in record.iter().enumerate() {
            output.extend_from_slice(if index == 0 && is_opaque { b"o" } else { field });
            output.push(0);
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("release probe fixture");
        }
    }

    fn xattr(path: &Path, value: &[u8]) {
        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: strings and value remain live for the call, with exact length.
        assert_eq!(
            unsafe {
                libc::lsetxattr(
                    path.as_ptr(),
                    c"user.overlay.opaque".as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            },
            0
        );
    }

    #[test]
    fn probe_distinguishes_markers_xattrs_root_and_invalid_metadata() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = Scratch(
            std::env::temp_dir().join(format!("kinu-devbox-opaque-{}-{nonce}", std::process::id())),
        );
        fs::create_dir(&root.0).unwrap();
        let dir = root.0.join("dir");
        fs::create_dir(&dir).unwrap();
        let record = b"d\01\02\0755\00\00\04096\00\00\0\0dir\0";
        assert_eq!(enrich(&root.0, record).unwrap(), record);
        fs::write(dir.join(".wh..wh..opq"), []).unwrap();
        assert_eq!(enrich(&root.0, record).unwrap()[0], b'o');
        fs::remove_file(dir.join(".wh..wh..opq")).unwrap();
        xattr(&dir, b"y");
        assert_eq!(enrich(&root.0, record).unwrap()[0], b'o');
        xattr(&dir, b"x");
        assert_eq!(enrich(&root.0, record).unwrap(), record);
        xattr(&dir, b"invalid");
        assert!(enrich(&root.0, record).is_err());
        xattr(&dir, b"n");
        xattr(&root.0, b"y");
        let enriched = enrich(&root.0, record).unwrap();
        let fields: Vec<_> = enriched.split(|b| *b == 0).collect();
        assert_eq!(fields[0], b"o");
        assert_eq!(fields[10], b"");
        assert_eq!(fields[11], b"d");
        assert!(enrich(&root.0, b"broken").is_err());
        symlink(&dir, root.0.join("link")).unwrap();
        assert!(enrich(&root.0, b"d\01\02\0755\00\00\04096\00\00\0\0link\0").is_err());
    }
}
