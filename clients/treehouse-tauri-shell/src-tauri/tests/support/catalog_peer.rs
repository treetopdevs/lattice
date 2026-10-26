//! Shared actual-runtime process runner. Tests retain their own decoder/budget.
use serde_json::Value;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
pub fn output(runtime: &str, mode: &str, input: Option<&Value>, max_bytes: usize) -> Vec<u8> {
    static PEER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = PEER_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut command = if runtime == "beam" {
        let shim = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".asdf/shims/mix");
        let mut command = Command::new(if shim.is_file() { shim } else { "mix".into() });
        command.current_dir(root()).env("MIX_ENV", "test").args([
            "run",
            "--no-compile",
            "--no-start",
            "scripts/treehouse_native_catalog_history_peer.exs",
            mode,
        ]);
        command
    } else {
        let mut command = Command::new("node");
        command.current_dir(root().join("clients/lattice-client"));
        if mode == "artifact-profile-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_artifact_peer.ts",
            ]);
        } else {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_history_peer.ts",
                mode,
            ]);
        }
        command
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("prepare actual Node and BEAM peers before native reciprocal tests");
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(input).unwrap())
            .unwrap();
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{runtime} {mode}: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() <= max_bytes, "peer corpus budget");
    output.stdout
}
