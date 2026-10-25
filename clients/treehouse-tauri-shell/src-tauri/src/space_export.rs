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
    write_checked(
        dir,
        file_name,
        contents,
        MAX_BYTES,
        contents.len() <= MAX_BYTES && valid_shape(contents),
    )
}

fn public_frame_shape(value: &serde_json::Value) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let Some(frame) = value.as_object() else {
        return false;
    };
    let mut keys: Vec<&str> = frame.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let encoded = |name: &str, length: usize| {
        frame[name].as_str().is_some_and(|text| {
            STANDARD
                .decode(text)
                .is_ok_and(|bytes| bytes.len() == length && STANDARD.encode(bytes) == text)
        })
    };
    keys == [
        "author", "body", "cap", "deps", "id", "kind", "replica", "sig", "v",
    ] && frame["v"].as_u64() == Some(1)
        && frame["id"].is_string()
        && frame["replica"].is_string()
        && encoded("author", 32)
        && encoded("sig", 64)
        && frame["deps"]
            .as_array()
            .is_some_and(|deps| deps.iter().all(serde_json::Value::is_string))
        && frame["body"].is_array()
        && frame["cap"].is_array()
        && matches!(
            frame["kind"].as_str(),
            Some("authority" | "command" | "inbox" | "tombstone")
        )
}

fn valid_evidence_shape(contents: &str) -> bool {
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(contents)
    else {
        return false;
    };
    let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let count = match map.get("format").and_then(serde_json::Value::as_str) {
        Some("treehouse-offline-invitation-v1")
            if keys
                == [
                    "bootstrapId",
                    "format",
                    "invitationId",
                    "product",
                    "profiles",
                    "recipient",
                    "space",
                    "spaceRoot",
                ] =>
        {
            1
        }
        Some("treehouse-initial-provisioning-v1")
            if keys
                == [
                    "bootstrapId",
                    "format",
                    "product",
                    "profiles",
                    "referenceId",
                    "space",
                    "spaceRoot",
                ] =>
        {
            2
        }
        _ => return false,
    };
    map["product"].as_str() == Some("treehouse")
        && map
            .iter()
            .all(|(key, value)| key == "profiles" || value.is_string())
        && map["profiles"].as_array().is_some_and(|profiles| {
            profiles
                .iter()
                .map(|profile| {
                    profile
                        .get("frames")
                        .and_then(serde_json::Value::as_array)
                        .map_or(0, Vec::len)
                })
                .sum::<usize>()
                <= 4000
        })
        && map["profiles"].as_array().is_some_and(|profiles| {
            profiles.len() == count
                && profiles.iter().enumerate().all(|(i, profile)| {
                    let Some(profile) = profile.as_object() else {
                        return false;
                    };
                    let mut keys: Vec<&str> = profile.keys().map(String::as_str).collect();
                    keys.sort_unstable();
                    keys == ["frames", "product", "replica"]
                        && profile["replica"].is_string()
                        && profile["product"].as_str()
                            == Some(if i == 0 {
                                "Treehouse.Space"
                            } else {
                                "Treehouse.Thread"
                            })
                        && profile["frames"].as_array().is_some_and(|frames| {
                            !frames.is_empty()
                                && frames.len() <= 4000
                                && frames.iter().all(public_frame_shape)
                        })
                })
        })
}

/// Writes supplied public evidence bytes, with no store or custody access. Structural checks are not
/// semantic verification, a confidentiality filter for arbitrary payloads, or a trust-install receipt.
pub fn write_public_evidence(
    dir: &Path,
    file_name: &str,
    contents: &str,
) -> Result<PathBuf, String> {
    write_checked(
        dir,
        file_name,
        contents,
        2 * 1024 * 1024,
        contents.len() <= 2 * 1024 * 1024 && valid_evidence_shape(contents),
    )
}

fn write_checked(
    dir: &Path,
    file_name: &str,
    contents: &str,
    maximum: usize,
    shape_valid: bool,
) -> Result<PathBuf, String> {
    if !valid_name(file_name) {
        return Err("invalid_export_name".into());
    }
    if contents.len() > maximum {
        return Err("export_too_large".into());
    }
    if !shape_valid {
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn treehouse_export_public_evidence<R: tauri::Runtime>(
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
        let path = write_public_evidence(&dir, &file_name, &contents)?;
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "export_failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_evidence_is_closed_bounded_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let frame = serde_json::json!({"v":1,"id":"id","replica":"s","author":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8;32]),"deps":[],"kind":"command","body":["nil"],"cap":["nil"],"sig":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8;64])});
        let profile =
            serde_json::json!({"product":"Treehouse.Space","replica":"s","frames":[frame]});
        let mut evidence = serde_json::json!({"format":"treehouse-offline-invitation-v1","product":"treehouse","space":"s","spaceRoot":"public","bootstrapId":"b","invitationId":"i","recipient":"member","profiles":[profile]});
        let text = evidence.to_string();
        for replacement in [
            serde_json::json!({"state":"not a wire term"}),
            serde_json::json!("not an array"),
        ] {
            let mut malformed = evidence.clone();
            malformed["profiles"][0]["frames"][0]["body"] = replacement;
            assert!(!valid_evidence_shape(&malformed.to_string()));
        }
        let mut malformed = evidence.clone();
        malformed["profiles"][0]["frames"][0]["v"] = serde_json::json!(2);
        assert!(!valid_evidence_shape(&malformed.to_string()));
        let path = write_public_evidence(dir.path(), "invitation.json", &text).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        assert_eq!(
            write_public_evidence(dir.path(), "invitation.json", &text).unwrap_err(),
            "export_exists"
        );
        evidence["state"] = serde_json::json!({"secret":"must not export"});
        assert_eq!(
            write_public_evidence(dir.path(), "bad.json", &evidence.to_string()).unwrap_err(),
            "invalid_export_contents"
        );
        assert!(!dir.path().join("bad.json").exists());
        assert_eq!(
            write_public_evidence(dir.path(), "large.json", &" ".repeat(2 * 1024 * 1024 + 1))
                .unwrap_err(),
            "export_too_large"
        );
        let mut child = profile.clone();
        child["product"] = serde_json::json!("Treehouse.Thread");
        let bundle = serde_json::json!({"format":"treehouse-initial-provisioning-v1","product":"treehouse","space":"s","spaceRoot":"public","bootstrapId":"b","referenceId":"r","profiles":[profile,child]});
        assert!(write_public_evidence(dir.path(), "initial.json", &bundle.to_string()).is_ok());
    }

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
