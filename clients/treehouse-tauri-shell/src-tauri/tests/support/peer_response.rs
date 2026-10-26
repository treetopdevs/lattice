//! Fresh bounded test response channel, separate from Mix's console output.
use std::process::{Command, Output};

pub struct PeerResponse {
    file: Option<tempfile::NamedTempFile>,
}

impl PeerResponse {
    pub fn prepare(command: &mut Command, runtime: &str) -> Self {
        let file = (runtime == "beam").then(|| tempfile::NamedTempFile::new().unwrap());
        if let Some(file) = &file {
            command.env("LATTICE_NATIVE_PEER_OUTPUT", file.path());
        }
        Self { file }
    }

    pub fn finish(self, output: Output, max_bytes: usize, context: &str) -> Vec<u8> {
        assert!(
            output.status.success(),
            "{context}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let bytes = if let Some(file) = self.file {
            let size = file.as_file().metadata().unwrap().len();
            assert!(size <= max_bytes as u64, "{context}: peer corpus budget");
            std::fs::read(file.path()).expect("actual BEAM peer response")
        } else {
            output.stdout
        };
        assert!(bytes.len() <= max_bytes, "{context}: peer corpus budget");
        assert!(
            bytes
                .iter()
                .find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|byte| matches!(byte, b'{' | b'[')),
            "{context}: peer must emit only JSON: {}",
            String::from_utf8_lossy(&bytes[..bytes.len().min(256)])
        );
        bytes
    }
}
