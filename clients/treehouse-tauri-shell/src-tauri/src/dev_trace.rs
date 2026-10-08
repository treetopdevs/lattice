//! Plan 181 5b: the dev-trace identity and storage seam for the packaged R13-lite test variant.
//! Compiled only with `treehouse-dev-trace`; the ordinary and Android builds contain none of this
//! code or its marker strings. It is the only native file that reads the process environment.
//! The seed is a public test constant handed over by the harness; it never leaves env and is
//! never written to a key store, a log or a trace.
use crate::preview::PreviewStore;
use std::path::{Path, PathBuf};

/// Store directory. Two instances never share SQLite, the identity lock or a Keychain alias.
const DATA_DIR_ENV: &str = "TREEHOUSE_DEV_DATA_DIR";
/// The 32-byte Ed25519 test seed as 64 hex characters.
const SEED_ENV: &str = "TREEHOUSE_DEV_CARRIER_SEED";
/// Optional file that receives one command-name line per native command. No payloads.
const TRACE_ENV: &str = "TREEHOUSE_DEV_TRACE_FILE";
/// The only refusal label. It never echoes a configured value.
const MISCONFIGURED: &str = "dev_trace_misconfigured";

/// The store the process environment selects, or `None` when the variant was launched without the
/// seam variables and should behave like the ordinary app.
pub(crate) fn store() -> Option<Result<PreviewStore, String>> {
    from_vars(|name| std::env::var(name).ok())
}

fn from_vars(get: impl Fn(&str) -> Option<String>) -> Option<Result<PreviewStore, String>> {
    let (dir, seed) = (get(DATA_DIR_ENV), get(SEED_ENV));
    if dir.is_none() && seed.is_none() {
        return None;
    }
    Some(build(dir, seed, get(TRACE_ENV)))
}

fn build(
    dir: Option<String>,
    seed: Option<String>,
    trace: Option<String>,
) -> Result<PreviewStore, String> {
    let (Some(dir), Some(seed)) = (dir, seed) else {
        return Err(MISCONFIGURED.into());
    };
    let dir = absolute(&dir)?;
    let seed = hex_seed(&seed)?;
    let mut store = PreviewStore::at_directory_dev(&dir, seed)?;
    if let Some(trace) = trace {
        store = store.with_dev_trace(absolute(&trace)?);
    }
    Ok(store)
}

fn absolute(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || !path.is_absolute() {
        return Err(MISCONFIGURED.into());
    }
    Ok(path.to_path_buf())
}

fn hex_seed(value: &str) -> Result<[u8; 32], String> {
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return Err(MISCONFIGURED.into());
    }
    let nibble = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    };
    let mut seed = [0u8; 32];
    for (slot, pair) in seed.iter_mut().zip(bytes.chunks(2)) {
        let (Some(high), Some(low)) = (nibble(pair[0]), nibble(pair[1])) else {
            return Err(MISCONFIGURED.into());
        };
        *slot = high << 4 | low;
    }
    Ok(seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn vars(entries: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn no_seam_variables_means_the_ordinary_store() {
        assert!(from_vars(vars(&[])).is_none());
        assert!(from_vars(vars(&[(TRACE_ENV, "/tmp/x")])).is_none());
    }

    #[test]
    fn one_of_directory_or_seed_alone_fails_closed_without_echoing_values() {
        let seed = "ab".repeat(32);
        for entries in [
            vec![(DATA_DIR_ENV, "/tmp/dir-only-marker")],
            vec![(SEED_ENV, seed.as_str())],
        ] {
            let Err(reason) = from_vars(vars(&entries)).unwrap() else {
                panic!("must refuse");
            };
            assert_eq!(reason, MISCONFIGURED);
        }
    }

    #[test]
    fn malformed_values_are_refused() {
        let good = "cd".repeat(32);
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().to_str().unwrap();
        for (d, s, t) in [
            ("relative/dir", good.as_str(), None),
            ("", good.as_str(), None),
            (dir, "short", None),
            (dir, &"zz".repeat(32), None),
            (dir, &"cd".repeat(33), None),
            (dir, good.as_str(), Some("relative-trace")),
        ] {
            let mut entries = vec![(DATA_DIR_ENV, d), (SEED_ENV, s)];
            if let Some(t) = t {
                entries.push((TRACE_ENV, t));
            }
            assert!(
                matches!(from_vars(vars(&entries)), Some(Err(ref r)) if r == MISCONFIGURED),
                "{d:?} {s:?} {t:?}"
            );
        }
    }

    #[test]
    fn valid_variables_open_the_seeded_store_with_an_optional_trace() {
        let dir = tempfile::tempdir().unwrap();
        let trace = dir.path().join("trace.log");
        let data = dir.path().join("data");
        let seed = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        let store = from_vars(vars(&[
            (DATA_DIR_ENV, data.to_str().unwrap()),
            (SEED_ENV, seed),
            (TRACE_ENV, trace.to_str().unwrap()),
        ]))
        .unwrap()
        .unwrap();
        let opened = store.open().unwrap();
        assert_eq!(opened.key_status, "absent");
        assert_eq!(std::fs::read_to_string(trace).unwrap(), "treehouse_open\n");
        assert!(data.join("treehouse-v1.sqlite3").exists());
    }
}
