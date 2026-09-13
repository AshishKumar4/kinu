use std::collections::BTreeMap;

/// Each branch is one byte: fanout is at most 256, independent of namespace
/// size. A lookup or insertion visits at most the platform-bounded path length.
#[derive(Clone)]
pub struct PathMap<T> {
    value: Option<T>,
    children: BTreeMap<u8, PathMap<T>>,
}

impl<T> PathMap<T> {
    pub fn new() -> Self {
        Self {
            value: None,
            children: BTreeMap::new(),
        }
    }
    pub fn get(&self, path: &str) -> Option<&T> {
        let mut node = self;
        for byte in path.bytes() {
            node = node.children.get(&byte)?;
        }
        node.value.as_ref()
    }
    pub fn insert(&mut self, path: &str, value: T) -> Option<T> {
        let mut node = self;
        for byte in path.bytes() {
            node = node.children.entry(byte).or_insert_with(Self::new);
        }
        node.value.replace(value)
    }
    pub fn contains_key(&self, path: &str) -> bool {
        self.get(path).is_some()
    }
}

impl<'a, T> FromIterator<(&'a str, T)> for PathMap<T> {
    fn from_iter<I: IntoIterator<Item = (&'a str, T)>>(iter: I) -> Self {
        let mut map = Self::new();
        for (path, value) in iter {
            map.insert(path, value);
        }
        map
    }
}

pub struct NameSet<'a> {
    map: PathMap<()>,
    names: Vec<&'a str>,
}
impl<'a> NameSet<'a> {
    pub fn new() -> Self {
        Self {
            map: PathMap::new(),
            names: Vec::new(),
        }
    }
    pub fn insert(&mut self, name: &'a str) -> bool {
        if self.map.insert(name, ()).is_some() {
            return false;
        }
        self.names.push(name);
        true
    }
    pub fn contains(&self, name: &str) -> bool {
        self.map.contains_key(name)
    }
    pub fn iter(&self) -> impl Iterator<Item = &&'a str> {
        self.names.iter()
    }
}

impl<'a> FromIterator<&'a str> for NameSet<'a> {
    fn from_iter<I: IntoIterator<Item = &'a str>>(iter: I) -> Self {
        let mut set = Self::new();
        for path in iter {
            set.insert(path);
        }
        set
    }
}

#[derive(Clone)]
pub struct DirectoryEntries {
    ids: PathMap<u64>,
    names: Vec<(String, u64)>,
}
impl DirectoryEntries {
    pub fn new() -> Self {
        Self {
            ids: PathMap::new(),
            names: Vec::new(),
        }
    }
    pub fn insert(&mut self, name: String, id: u64) {
        self.ids.insert(&name, id);
        self.names.push((name, id));
    }
    pub fn get(&self, name: &str) -> Option<&u64> {
        self.ids.get(name)
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, u64)> {
        self.names.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_prefixes_and_repeated_names_keep_distinct_values() {
        let mut names = PathMap::new();
        assert_eq!(names.insert("a/b", 3), None);
        assert_eq!(names.insert("a/b/c", 4), None);
        assert_eq!(names.insert("a/b", 5), Some(3));
        assert_eq!(names.get("a/b"), Some(&5));
        assert_eq!(names.get("a/b/c"), Some(&4));
        assert_eq!(names.get("a"), None);
    }
}
