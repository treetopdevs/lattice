//! Fresh bounded test response channel, separate from Mix's console output.
use std::{
    ffi::OsString,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

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

/// One launcher for every BEAM peer; explicit operator selection wins.
pub fn mix_executable() -> OsString {
    std::env::var_os("MIX_BIN").unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".asdf/shims/mix"))
            .filter(|path| path.is_file())
            .map_or_else(|| "mix".into(), |path| path.into_os_string())
    })
}

pub fn run(
    mut command: Command,
    runtime: &str,
    input: Option<&[u8]>,
    max_bytes: usize,
    context: &str,
) -> Vec<u8> {
    let response = PeerResponse::prepare(&mut command, runtime);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("prepare actual Node and BEAM peers before native reciprocal tests");
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    drop(child.stdin.take());
    response.finish(child.wait_with_output().unwrap(), max_bytes, context)
}
