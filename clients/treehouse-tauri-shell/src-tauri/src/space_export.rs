//! Minimal native writer for a Space frames export. It writes bytes the webview passes and nothing else:
//! no application state, preview store or key store is reachable from here.
use std::io::Write as _;
use std::path::{Path, PathBuf};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const FORMAT: &str = "lattice-space-frames-export-v1";

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    name.len() <= 101
        && name.ends_with(".json")
        && !name.contains("..")
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn valid_shape(contents: &str) -> bool {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(contents)
    else {
        return false;
    };
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys == ["format", "frames", "root", "space"]
        && map["format"].as_str() == Some(FORMAT)
        && map["space"].is_string()
        && map["root"].is_string()
        && map["frames"].as_array().is_some_and(|f| !f.is_empty())
}

/// Create `dir/file_name` with exactly `contents`. Never overwrites and never follows a pre-existing link.
pub fn write_export(dir: &Path, file_name: &str, contents: &str) -> Result<PathBuf, String> {
    if !valid_name(file_name) {
        return Err("invalid_export_name".into());
    }
    if contents.len() > MAX_BYTES {
        return Err("export_too_large".into());
    }
    if !valid_shape(contents) {
        return Err("invalid_export_contents".into());
    }
    // `create_new` protects only the final component, so the directory itself must be a real directory, not a
    // link that could redirect the write (for example into custody storage).
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_dir() => {}
        _ => return Err("export_unavailable".into()),
    }
    let path = dir.join(file_name);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o644);
    }
    let mut file = options.open(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "export_exists".to_string()
        } else {
            "export_failed".to_string()
        }
    })?;
    discard_on_error(
        &path,
        file.write_all(contents.as_bytes())
            .and_then(|()| file.sync_all()),
    )?;
    Ok(path)
}

/// A failed write must not leave a truncated file under a burned name.
fn discard_on_error(path: &Path, result: std::io::Result<()>) -> Result<(), String> {
    result.map_err(|_| {
        let _ = std::fs::remove_file(path);
        "export_failed".to_string()
    })
}

#[tauri::command]
pub fn treehouse_export_space_frames<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    #[cfg(mobile)]
    {
        let _ = (&app, &file_name, &contents);
        Err("export_unavailable".into())
    }
    #[cfg(not(mobile))]
    {
        use tauri::Manager as _;
        let dir = app
            .path()
            .download_dir()
            .map_err(|_| "export_unavailable".to_string())?;
        let path = write_export(&dir, &file_name, &contents)?;
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "export_failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> String {
        serde_json::json!({"format": FORMAT, "space": "s", "root": "r", "frames": [{"id": "a"}]})
            .to_string()
    }

    #[test]
    fn writes_exact_bytes_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let text = good();
        let path = write_export(dir.path(), "space.frames.json", &text).unwrap();
        assert_eq!(path, dir.path().join("space.frames.json"));
        assert_eq!(std::fs::read(&path).unwrap(), text.as_bytes());
        assert_eq!(
            write_export(dir.path(), "space.frames.json", &text).unwrap_err(),
            "export_exists"
        );
        assert_eq!(std::fs::read(&path).unwrap(), text.as_bytes());
    }

    #[test]
    fn refuses_bad_names() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "../x.json",
            ".hidden.json",
            "a/b.json",
            "a\\b.json",
            "x.txt",
            "x",
            "a..b.json",
            "",
            ".json",
            &format!("{}.json", "a".repeat(97)),
        ] {
            assert_eq!(
                write_export(dir.path(), name, &good()).unwrap_err(),
                "invalid_export_name",
                "{name}"
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        let longest = format!("{}.json", "a".repeat(96));
        write_export(dir.path(), &longest, &good()).unwrap();
    }

    #[test]
    fn refuses_oversize_and_wrong_shape() {
        let dir = tempfile::tempdir().unwrap();
        let big = " ".repeat(MAX_BYTES + 1);
        assert_eq!(
            write_export(dir.path(), "a.json", &big).unwrap_err(),
            "export_too_large"
        );
        let bad = [
            "not json".to_string(),
            "[]".to_string(),
            serde_json::json!({"format": FORMAT, "space": "s", "root": "r"}).to_string(),
            serde_json::json!({"format": FORMAT, "space": "s", "root": "r", "frames": [{}], "x": 1})
                .to_string(),
            serde_json::json!({"format": "other", "space": "s", "root": "r", "frames": [{}]})
                .to_string(),
            serde_json::json!({"format": FORMAT, "space": "s", "root": "r", "frames": []})
                .to_string(),
        ];
        for text in bad {
            assert_eq!(
                write_export(dir.path(), "a.json", &text).unwrap_err(),
                "invalid_export_contents",
                "{text}"
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn failed_write_removes_the_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("half.json");
        std::fs::write(&path, b"{\"for").unwrap();
        let err = std::io::Error::other("disk full");
        assert_eq!(
            discard_on_error(&path, Err(err)).unwrap_err(),
            "export_failed"
        );
        assert!(!path.exists());
        assert!(discard_on_error(&path, Ok(())).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_directory() {
        let root = tempfile::tempdir().unwrap();
        let custody = root.path().join("custody");
        std::fs::create_dir(&custody).unwrap();
        let downloads = root.path().join("Downloads");
        std::os::unix::fs::symlink(&custody, &downloads).unwrap();
        assert_eq!(
            write_export(&downloads, "new.json", &good()).unwrap_err(),
            "export_unavailable"
        );
        assert_eq!(std::fs::read_dir(&custody).unwrap().count(), 0);
        assert_eq!(
            write_export(&root.path().join("missing"), "new.json", &good()).unwrap_err(),
            "export_unavailable"
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_a_planted_link() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("victim");
        std::fs::write(&target, b"keep").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("a.json")).unwrap();
        assert_eq!(
            write_export(dir.path(), "a.json", &good()).unwrap_err(),
            "export_exists"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
    }
}
