use base64::{engine::general_purpose::STANDARD, Engine};
use curve25519_dalek::{
    constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION},
    scalar::Scalar,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
use treehouse_tauri_shell::signature::verify;
fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut cmd = if runtime == "beam" {
        let shim = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(".asdf/shims/mix"));
        let executable = std::env::var_os("MIX_BIN").unwrap_or_else(|| {
            shim.filter(|path| path.is_file())
                .map_or_else(|| "mix".into(), |path| path.into_os_string())
        });
        let mut c = Command::new(executable);
        c.current_dir(&root).env("MIX_ENV", "test").args([
            "run",
            "--no-compile",
            "--no-start",
            "scripts/strict_signature_peer.exs",
            mode,
        ]);
        c
    } else {
        let mut c = Command::new("node");
        c.current_dir(root.join("clients/lattice-client")).args([
            "--import",
            "tsx",
            "test/support/strict_signature_peer.ts",
            mode,
        ]);
        c
    };
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
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
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn three_actual_runtimes_share_strict_signature_profile_with_three_fresh_producers() {
    let mut input = peer("ts", "produce", None);
    for entry in input["frames"].as_array().unwrap() {
        assert_eq!(
            treehouse_tauri_shell::catalog_eval::frame::verify(
                &serde_json::to_vec(&entry["frame"]).unwrap()
            )
            .is_ok(),
            entry["expected"].as_bool().unwrap(),
            "public frame authentication"
        );
    }
    input["cases"].as_array_mut().unwrap().extend(
        peer("beam", "produce", None)["cases"]
            .as_array()
            .unwrap()
            .clone(),
    );
    let key = SigningKey::from_bytes(&[114; 32]);
    let message = b"fresh Rust strict signature producer";
    let valid = key.sign(message).to_bytes();
    let mut identity = [0u8; 32];
    identity[0] = 1;
    let mut forged = [0u8; 64];
    forged[0] = 1;
    for (name, public, msg, sig, expected) in [
        (
            "rust-valid",
            key.verifying_key().to_bytes(),
            message.as_slice(),
            valid,
            true,
        ),
        (
            "rust-wrong-message",
            key.verifying_key().to_bytes(),
            b"wrong".as_slice(),
            valid,
            false,
        ),
        ("rust-weak-key", identity, message.as_slice(), forged, false),
    ] {
        input["cases"].as_array_mut().unwrap().push(json!({"name":name,"key":STANDARD.encode(public),"message":STANDARD.encode(msg),"signature":STANDARD.encode(sig),"expected":expected}));
    }

    // Independent malicious witnesses from dalek, not the TS producer's math.
    let challenge = |r: &[u8; 32], a: &[u8; 32], m: &[u8]| {
        let mut digest = Sha512::new();
        digest.update(r);
        digest.update(a);
        digest.update(m);
        Scalar::from_bytes_mod_order_wide(&digest.finalize().into())
    };
    let mut add = |name: String,
                   public: [u8; 32],
                   msg: Vec<u8>,
                   r: [u8; 32],
                   s: Scalar,
                   expected: bool| {
        let mut sig = Vec::from(r);
        sig.extend(s.to_bytes());
        input["cases"].as_array_mut().unwrap().push(json!({"name":name,"key":STANDARD.encode(public),"message":STANDARD.encode(msg),"signature":STANDARD.encode(sig),"expected":expected}));
    };
    for (i, torsion) in EIGHT_TORSION.iter().enumerate() {
        let public = torsion.compress().to_bytes();
        let (r, s) = (1u64..256)
            .find_map(|nonce| {
                let s = Scalar::from(nonce);
                let r = (ED25519_BASEPOINT_POINT * s).compress().to_bytes();
                (torsion * challenge(&r, &public, message) == EIGHT_TORSION[0]).then_some((r, s))
            })
            .expect("bounded small-order-key equation witness");
        add(
            format!("rust-isolated-weak-A-{i}"),
            public,
            message.to_vec(),
            r,
            s,
            false,
        );
    }
    let a = Scalar::from(23u64);
    for (i, r_point) in EIGHT_TORSION.iter().enumerate() {
        let public = (ED25519_BASEPOINT_POINT * a + EIGHT_TORSION[1])
            .compress()
            .to_bytes();
        let r = r_point.compress().to_bytes();
        let (msg, k) = (0..256)
            .find_map(|nonce| {
                let msg = format!("rust isolated small R {i} nonce {nonce}").into_bytes();
                let k = challenge(&r, &public, &msg);
                (r_point + EIGHT_TORSION[1] * k == EIGHT_TORSION[0]).then_some((msg, k))
            })
            .expect("bounded small-order-R equation witness");
        add(
            format!("rust-isolated-small-R-{i}"),
            public,
            msg,
            r,
            k * a,
            false,
        );
    }
    let ts = peer("ts", "consume", Some(&input));
    let beam = peer("beam", "consume", Some(&input));
    for (i, value) in input["cases"].as_array().unwrap().iter().enumerate() {
        let decode = |name: &str| STANDARD.decode(value[name].as_str().unwrap()).unwrap();
        let actual = verify(&decode("key"), &decode("message"), &decode("signature"));
        assert_eq!(
            actual,
            value["expected"].as_bool().unwrap(),
            "native {}",
            value["name"]
        );
        assert_eq!(json!(actual), ts["decisions"][i], "TS {}", value["name"]);
        assert_eq!(
            json!(actual),
            beam["decisions"][i],
            "BEAM {}",
            value["name"]
        );
    }
}
