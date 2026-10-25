use serde_json::Value;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
pub fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    let repo = root();
    let mut command = if runtime == "ts" {
        let mut command = Command::new("node");
        command
            .arg(repo.join("clients/lattice-client/node_modules/tsx/dist/cli.mjs"))
            .arg(repo.join("clients/lattice-client/test/support/native_catalog_codec_peer.ts"));
        command
    } else {
        let shim = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".asdf/shims/mix"));
        let mut command = Command::new(
            shim.filter(|path| path.is_file())
                .unwrap_or_else(|| PathBuf::from("mix")),
        );
        command
            .env("MIX_ENV", "test")
            .args(["run", "--no-compile", "--no-start"])
            .arg(repo.join("scripts/treehouse_native_catalog_peer.exs"));
        command
    };
    command
        .current_dir(&repo)
        .arg(mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .expect("Node/client dependencies and compiled test BEAM are required prerequisites");
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(input).unwrap())
            .unwrap();
    } else {
        drop(child.stdin.take());
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{runtime} peer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "{runtime} peer output: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}
