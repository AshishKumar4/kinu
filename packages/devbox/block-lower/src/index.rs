use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{self, ErrorKind};

pub const BLOCK: u64 = 16384;
pub const PAGE: usize = 128;
pub type Hash = [u8; 32];

pub fn invalid(message: &str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, message)
}
pub fn hash(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}

pub fn hex_hash(value: &str) -> io::Result<Hash> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("invalid sha256"));
    }
    let mut out = [0; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
            .map_err(|_| invalid("invalid sha256"))?;
    }
    Ok(out)
}

pub fn hex(value: &Hash) -> String {
    value.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IndexRef {
    pub index: String,
    pub root: String,
    pub count: u64,
}

impl IndexRef {
    pub fn validate(&self, size: u64) -> io::Result<()> {
        hex_hash(&self.index)?;
        hex_hash(&self.root)?;
        if size > 9007199254740991 || self.count > size.div_ceil(BLOCK) {
            return Err(invalid("index count exceeds file"));
        }
        if self.count == 0 && (self.root != hex(&hash(&[])) || self.index != self.root) {
            return Err(invalid("invalid empty index"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Base,
    Hole,
    Chunk(Hash),
}

fn part(page: &[u8; PAGE], from: usize) -> Hash {
    let mut out = [0; 32];
    out.copy_from_slice(&page[from..from + 32]);
    out
}

/// Each iteration halves an implicit rank interval. Authentication and the
/// rank-derived child shape prevent hostile pages from extending the path.
pub fn lookup(
    reference: &IndexRef,
    size: u64,
    offset: u64,
    mut read: impl FnMut(u64, &mut [u8; PAGE]) -> io::Result<()>,
) -> io::Result<Source> {
    reference.validate(size)?;
    let (mut lo, mut hi) = (0, reference.count);
    let (mut lower, mut upper) = (None, size);
    let mut expected = hex_hash(&reference.root)?;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let mut page = [0; PAGE];
        read(
            mid * u64::try_from(PAGE).map_err(|_| invalid("page size"))?,
            &mut page,
        )?;
        if hash(&page) != expected {
            return Err(invalid("corrupt index page"));
        }
        let mut word = [0; 8];
        word.copy_from_slice(&page[..8]);
        let at = u64::from_le_bytes(word);
        let (chunk, left, right) = (part(&page, 16), part(&page, 48), part(&page, 80));
        if at % BLOCK != 0
            || at >= upper
            || lower.is_some_and(|previous| at <= previous)
            || ![1, 2].contains(&page[8])
            || page[9..16]
                .iter()
                .chain(page[112..].iter())
                .any(|b| *b != 0)
            || (page[8] == 2 && chunk != [0; 32])
            || ((mid == lo) != (left == [0; 32]))
            || ((mid + 1 == hi) != (right == [0; 32]))
        {
            return Err(invalid("invalid index page"));
        }
        if offset == at {
            return Ok(if page[8] == 1 {
                Source::Chunk(chunk)
            } else {
                Source::Hole
            });
        }
        if offset < at {
            hi = mid;
            upper = at;
            expected = left;
        } else {
            lo = mid + 1;
            lower = Some(at);
            expected = right;
        }
    }
    Ok(Source::Base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(count: u64) -> (IndexRef, Vec<[u8; PAGE]>) {
        let mut pages = vec![[0; PAGE]; usize::try_from(count).unwrap()];
        fn build(pages: &mut [[u8; PAGE]], lo: usize, hi: usize) -> Hash {
            if lo == hi {
                return [0; 32];
            }
            let mid = lo + (hi - lo) / 2;
            let left = build(pages, lo, mid);
            let right = build(pages, mid + 1, hi);
            let page = &mut pages[mid];
            page[..8].copy_from_slice(&(u64::try_from(mid).unwrap() * 2 * BLOCK).to_le_bytes());
            page[8] = 2;
            page[48..80].copy_from_slice(&left);
            page[80..112].copy_from_slice(&right);
            hash(page)
        }
        let root = build(&mut pages, 0, usize::try_from(count).unwrap());
        let bytes: Vec<u8> = pages.iter().flatten().copied().collect();
        (
            IndexRef {
                index: hex(&hash(&bytes)),
                root: hex(&root),
                count,
            },
            pages,
        )
    }

    #[test]
    fn balanced_lookup_and_distinct_missing_holes() {
        let (reference, pages) = tree(1023);
        for (offset, wanted) in [
            (0, Source::Hole),
            (BLOCK, Source::Base),
            (1022 * 2 * BLOCK, Source::Hole),
        ] {
            let mut reads = 0;
            let actual = lookup(&reference, 2046 * BLOCK, offset, |at, out| {
                *out = pages[usize::try_from(at / 128).unwrap()];
                reads += 1;
                Ok(())
            })
            .unwrap();
            assert_eq!(actual, wanted);
            assert!(reads <= 10);
        }
    }

    #[test]
    fn corruption_is_not_base_fallthrough() {
        let (reference, mut pages) = tree(3);
        pages[1][0] ^= 1;
        assert!(lookup(&reference, 6 * BLOCK, 0, |at, out| {
            *out = pages[usize::try_from(at / 128).unwrap()];
            Ok(())
        })
        .is_err());
        assert!(lookup(&reference, BLOCK, 0, |_, _| panic!(
            "count refused before IO"
        ))
        .is_err());
    }
}
