use serde_json::Value;
use std::{path::PathBuf, process::Command};
#[path = "peer_response.rs"]
mod peer_response;

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
        let mut command = Command::new(peer_response::mix_executable());
        command
            .env("MIX_ENV", "test")
            .args(["run", "--no-compile", "--no-start"])
            .arg(repo.join("scripts/treehouse_native_catalog_peer.exs"));
        command
    };
    command.current_dir(&repo).arg(mode);
    let input = input.map(|value| serde_json::to_vec(value).unwrap());
    let bytes = peer_response::run(
        command,
        runtime,
        input.as_deref(),
        64 * 1024 * 1024,
        &format!("{runtime} codec {mode}"),
    );
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        panic!(
            "{runtime} codec {mode} peer JSON: {error}: {}",
            String::from_utf8_lossy(&bytes[..bytes.len().min(256)])
        )
    })
}
