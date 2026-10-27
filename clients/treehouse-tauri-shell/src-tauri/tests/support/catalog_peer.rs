//! Shared actual-runtime process runner. Tests retain their own decoder/budget.
use serde_json::Value;
use std::{path::PathBuf, process::Command};
#[path = "peer_response.rs"]
mod peer_response;

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
    let command = if runtime == "beam" {
        let mut command = Command::new(peer_response::mix_executable());
        command.current_dir(root()).env("MIX_ENV", "test").args([
            "run",
            "--no-compile",
            "--no-start",
            if mode == "number-input-produce" {
                "scripts/treehouse_native_catalog_number_input_peer.exs"
            } else if mode == "full-input-produce" {
                "scripts/treehouse_native_catalog_full_input_peer.exs"
            } else if mode == "resolver-consume" {
                "scripts/treehouse_native_catalog_resolver_peer.exs"
            } else if mode == "chains-produce" {
                "scripts/treehouse_native_catalog_chain_peer.exs"
            } else {
                "scripts/treehouse_native_catalog_history_peer.exs"
            },
            mode,
        ]);
        command
    } else {
        let mut command = Command::new("node");
        command.current_dir(root().join("clients/lattice-client"));
        if mode == "resolver-consume" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_resolver_peer.ts",
                "consume",
            ]);
        } else if mode == "refusal-resource-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_refusal_resource_peer.ts",
            ]);
        } else if mode == "resource-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_resource_peer.ts",
            ]);
        } else if mode == "number-values-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/catalog_raw_number_peer.ts",
                "metadata",
            ]);
        } else if mode == "decision-order-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/catalog_decision_order_peer.ts",
            ]);
        } else if mode == "incoming-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_incoming_peer.ts",
            ]);
        } else if mode == "resolver-produce" || mode == "witness-produce" {
            command.args([
                "--import",
                "tsx",
                if mode == "resolver-produce" {
                    "test/support/native_catalog_resolver_peer.ts"
                } else {
                    "test/support/native_catalog_witness_peer.ts"
                },
            ]);
        } else if mode == "chains-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_chain_peer.ts",
            ]);
        } else if mode == "entry-priority" || mode == "entry-priority-multi" {
            command.args([
                "--import",
                "tsx",
                "test/support/catalog_entry_priority_peer.ts",
            ]);
            if mode == "entry-priority-multi" {
                command.arg("multi");
            }
        } else if mode == "snapshot-shapes" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_snapshot_peer.ts",
            ]);
        } else if mode == "entries-consume" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_entry_peer.ts",
                "consume",
            ]);
        } else if mode == "entries-produce" {
            command.args([
                "--import",
                "tsx",
                "test/support/native_catalog_entry_peer.ts",
            ]);
        } else if mode == "artifact-profile-produce" {
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
    let input = input.map(|value| serde_json::to_vec(value).unwrap());
    peer_response::run(
        command,
        runtime,
        input.as_deref(),
        max_bytes,
        &format!("{runtime} {mode}"),
    )
}
